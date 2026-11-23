"""Signing helpers. Imported by tests without touching a keychain or Apple service."""
import base64
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from apple_config import ConfigError, build_number

class ReleaseError(RuntimeError):
    pass

def read_tool_help(command):
    """Help is non-secret diagnostic output; Xcode may write it to stderr."""
    result = subprocess.run([str(x) for x in command], capture_output=True)
    if result.returncode: raise ReleaseError("TOOL_HELP_FAILED")
    combined = result.stdout + result.stderr
    return combined.decode("utf-8", errors="replace"), {"stdout_bytes":len(result.stdout), "stderr_bytes":len(result.stderr)}

class DeliveryJournal:
    def __init__(self, path, source_sha, build):
        self.path = pathlib.Path(path)
        self.data = {"schema_version":"1", "source_sha":source_sha, "build":build,
            "signed_archive":False, "exported":False, "uploaded":False, "upload_state":"not_started",
            "asc_processing":"NOT_STARTED", "internal_group_assigned":False,
            "testflight_installation":"NOT_VERIFIED", "real_device":"NOT_VERIFIED", "export_compliance":"REVIEW_IN_ASC"}
        self.update()
    def update(self, **changes):
        allowed = set(self.data) | {"profile_mapping"}
        if set(changes) - allowed: raise ReleaseError("DELIVERY_JOURNAL_FIELD")
        self.data.update(changes)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.data, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.path)

def validate_cleanup_record(record, runner_temp, home):
    runner = pathlib.Path(runner_temp).resolve()
    directory = pathlib.Path(record["directory"]).resolve()
    if directory.parent != runner or not directory.name.startswith("research-apple-signing-"):
        raise ReleaseError("CLEANUP_DIRECTORY_OUT_OF_SCOPE")
    keychain = pathlib.Path(record["keychain"]).resolve()
    if keychain.parent != directory or keychain.name != "signing.keychain-db":
        raise ReleaseError("CLEANUP_KEYCHAIN_OUT_OF_SCOPE")
    profile_dir = pathlib.Path(home).resolve() / "Library/MobileDevice/Provisioning Profiles"
    profiles = [pathlib.Path(value).resolve() for value in record.get("profiles", [])]
    for profile in profiles:
        if profile.parent != profile_dir or profile.suffix != ".mobileprovision": raise ReleaseError("CLEANUP_PROFILE_OUT_OF_SCOPE")
        try: uuid.UUID(profile.stem)
        except ValueError: raise ReleaseError("CLEANUP_PROFILE_NAME") from None
    originals = record.get("original_search", [])
    if not isinstance(originals, list) or any(not isinstance(value, str) or not pathlib.Path(value).is_absolute() for value in originals):
        raise ReleaseError("CLEANUP_SEARCH_LIST")
    return directory, keychain, profiles, originals

def cleanup_signing(record, runner_temp, home):
    directory, keychain, profiles, originals = validate_cleanup_record(record, runner_temp, home)
    for profile in profiles: profile.unlink(missing_ok=True)
    run(["security", "list-keychains", "-d", "user", "-s", *originals])
    if keychain.exists(): run(["security", "delete-keychain", keychain])
    if directory.exists(): shutil.rmtree(directory)

def run(command, *, env=None, input_data=None):
    result = subprocess.run([str(x) for x in command], input=input_data, capture_output=True, env=env)
    if result.returncode:
        # Never echo argv, password, decoded key, arbitrary stdout or upstream error body.
        raise ReleaseError("Required tool failed: " + pathlib.Path(str(command[0])).name)
    return result.stdout

def decode_secret(value, field):
    try:
        if not isinstance(value, str) or not value:
            raise ValueError()
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ConfigError([field]) from None

def check_profile(profile, *, bundle, team, certificate_sha1, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expiry = profile.get("ExpirationDate")
    if not isinstance(expiry, datetime.datetime):
        raise ReleaseError("PROFILE_EXPIRATION")
    if expiry.tzinfo is None: expiry = expiry.replace(tzinfo=datetime.timezone.utc)
    entitlements = profile.get("Entitlements", {})
    prefixes = profile.get("ApplicationIdentifierPrefix", [])
    expected = {str(prefix) + "." + bundle for prefix in prefixes}
    certificates = {hashlib.sha1(value).hexdigest().upper() for value in profile.get("DeveloperCertificates", []) if isinstance(value, bytes)}
    try: uuid.UUID(profile.get("UUID", ""))
    except (ValueError, TypeError, AttributeError): raise ReleaseError("PROFILE_UUID") from None
    if (expiry <= now + datetime.timedelta(days=1) or team not in profile.get("TeamIdentifier", [])
        or entitlements.get("com.apple.developer.team-identifier") != team
        or entitlements.get("application-identifier") not in expected
        or "*" in str(entitlements.get("application-identifier", ""))
        or entitlements.get("get-task-allow") is not False or profile.get("ProvisionedDevices")
        or profile.get("ProvisionsAllDevices") or certificate_sha1.upper() not in certificates):
        raise ReleaseError("PROFILE_TEAM_BUNDLE_CERTIFICATE_OR_DISTRIBUTION_MISMATCH")
    return profile["UUID"]

def b64url(value): return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

def jose_signature(der):
    def length(offset):
        first = der[offset]; offset += 1
        if first < 128: return first, offset
        count = first & 127
        return int.from_bytes(der[offset:offset + count], "big"), offset + count
    if not der or der[0] != 0x30: raise ReleaseError("ASC_SIGNATURE_FORMAT")
    _, offset = length(1)
    values = []
    for _ in range(2):
        if der[offset] != 2: raise ReleaseError("ASC_SIGNATURE_FORMAT")
        size, offset = length(offset + 1)
        values.append(int.from_bytes(der[offset:offset + size], "big").to_bytes(32, "big")); offset += size
    return b"".join(values)

class ASC:
    def __init__(self, config, private_key): self.config = config; self.private_key = private_key
    def request(self, path, *, method="GET", body=None):
        # Follow only known ASC API URLs. Never send a JWT to pagination-provided foreign hosts.
        url = urllib.parse.urljoin("https://api.appstoreconnect.apple.com", path)
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "api.appstoreconnect.apple.com" or not parts.path.startswith("/v1/"):
            raise ReleaseError("ASC_API_URL")
        now = int(time.time())
        header = b64url(json.dumps({"alg":"ES256", "kid":self.config["ASC_KEY_ID"], "typ":"JWT"}, separators=(",", ":")).encode())
        claims = b64url(json.dumps({"iss":self.config["ASC_ISSUER_ID"], "iat":now, "exp":now+600, "aud":"appstoreconnect-v1"}, separators=(",", ":")).encode())
        message = (header + "." + claims).encode()
        signature = run(["openssl", "dgst", "-sha256", "-sign", self.private_key], input_data=message)
        token = message.decode() + "." + b64url(jose_signature(signature))
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
            headers={"Authorization":"Bearer " + token, "Content-Type":"application/json"})
        try:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl): return None
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                content = response.read(2_000_001)
            if len(content) > 2_000_000: raise ReleaseError("ASC_RESPONSE_SIZE")
            return json.loads(content) if content else {}
        except (urllib.error.URLError, json.JSONDecodeError): raise ReleaseError("ASC_API_REQUEST_FAILED") from None
    def check_app_and_increasing_build(self):
        app = self.request("/v1/apps/" + self.config["ASC_APP_ID"])
        if app.get("data", {}).get("attributes", {}).get("bundleId") != self.config["APP_BUNDLE_ID"]:
            raise ReleaseError("ASC_APP_BUNDLE_MISMATCH")
        candidate = build_number(self.config["CURRENT_PROJECT_VERSION"])
        path = "/v1/builds?" + urllib.parse.urlencode({"filter[app]":self.config["ASC_APP_ID"], "limit":"200"})
        for _ in range(10):
            page = self.request(path)
            for build in page.get("data", []):
                try: existing = build_number(build["attributes"]["version"])
                except (KeyError, ConfigError): raise ReleaseError("ASC_BUILD_HISTORY_NOT_COMPARABLE") from None
                if candidate <= existing: raise ReleaseError("CURRENT_PROJECT_VERSION_NOT_INCREASING")
            path = page.get("links", {}).get("next")
            if not path: return
        raise ReleaseError("ASC_BUILD_HISTORY_TOO_LARGE_FOR_PREFLIGHT")
    def check_internal_group(self):
        group = self.config.get("ASC_INTERNAL_TEST_GROUP_ID")
        if not group: return None
        document = self.request("/v1/betaGroups/" + group + "?include=app")
        resource = document.get("data", {})
        attributes = resource.get("attributes", {})
        app = resource.get("relationships", {}).get("app", {}).get("data", {})
        if (resource.get("type") != "betaGroups" or resource.get("id") != group
            or attributes.get("isInternalGroup") is not True or attributes.get("publicLinkEnabled") is True
            or app.get("type") != "apps" or app.get("id") != self.config["ASC_APP_ID"]):
            raise ReleaseError("ASC_GROUP_NOT_INTERNAL_OR_APP_MISMATCH")
        return group
    def assign_internal_group(self, build_id):
        group = self.check_internal_group()
        if group:
            self.request("/v1/betaGroups/" + group + "/relationships/builds", method="POST",
                body={"data":[{"type":"builds", "id":build_id}]})
        return bool(group)
    def wait_for_processing(self):
        path = "/v1/builds?" + urllib.parse.urlencode({"filter[app]":self.config["ASC_APP_ID"], "filter[version]":self.config["CURRENT_PROJECT_VERSION"], "limit":"20"})
        for _ in range(30):
            page = self.request(path)
            builds = page.get("data", [])
            if len(builds) > 1: raise ReleaseError("ASC_BUILD_AMBIGUOUS")
            if builds:
                build = builds[0]; state = build.get("attributes", {}).get("processingState")
                if state == "VALID": return build
                if state in ("FAILED", "INVALID"): raise ReleaseError("ASC_PROCESSING_FAILED")
            time.sleep(30)
        raise ReleaseError("ASC_PROCESSING_NOT_CONFIRMED")
