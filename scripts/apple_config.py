"""Strict non-secret build configuration shared by unsigned and release tooling."""
import ipaddress
import json
import pathlib
import re
import urllib.parse
import uuid

BUILD_KEYS = ("APPLE_TEAM_ID", "APP_BUNDLE_ID", "WATCH_BUNDLE_ID", "API_BASE_URL", "MARKETING_VERSION", "CURRENT_PROJECT_VERSION")
ASC_KEYS = ("ASC_APP_ID", "ASC_KEY_ID", "ASC_ISSUER_ID")
ALLOWED = set(BUILD_KEYS + ASC_KEYS + ("synthetic", "ASC_INTERNAL_TEST_GROUP_ID"))

class ConfigError(ValueError):
    def __init__(self, fields):
        self.fields = sorted(set(fields))
        super().__init__("Missing or invalid configuration names: " + ", ".join(self.fields))

def build_number(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,17}(?:\.[0-9]{1,18}){0,2}", value):
        raise ConfigError(["CURRENT_PROJECT_VERSION"])
    return tuple(int(part) for part in value.split(".")) + (0,) * (3 - len(value.split(".")))

def validate(data, *, release=False, allow_synthetic=False):
    if not isinstance(data, dict):
        raise ConfigError(["CONFIG_JSON"])
    failures = []
    if set(data) - ALLOWED:
        failures.append("UNKNOWN_FIELD")
    synthetic = data.get("synthetic", False)
    if not isinstance(synthetic, bool) or (synthetic and (release or not allow_synthetic)):
        failures.append("synthetic")
    for key in BUILD_KEYS + (ASC_KEYS if release else ()):
        value = data.get(key)
        if not isinstance(value, str) or not value or len(value) > 512 or any(ord(c) < 32 or ord(c) > 126 for c in value):
            failures.append(key)
        elif "REPLACE_" in value or (not synthetic and "example" in value.lower()):
            failures.append(key)
    team = data.get("APPLE_TEAM_ID", "")
    if not isinstance(team, str) or not re.fullmatch(r"[A-Z0-9]{10}", team):
        failures.append("APPLE_TEAM_ID")
    for key in ("APP_BUNDLE_ID", "WATCH_BUNDLE_ID"):
        value = data.get(key, "")
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", value):
            failures.append(key)
    if isinstance(data.get("WATCH_BUNDLE_ID"), str) and not data["WATCH_BUNDLE_ID"].startswith(str(data.get("APP_BUNDLE_ID", "")) + "."):
        failures.append("WATCH_BUNDLE_ID")
    try:
        origin = urllib.parse.urlsplit(data.get("API_BASE_URL", ""))
        host = origin.hostname or ""
        if origin.scheme != "https" or not host or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9.-]+", host) or (origin.port is not None and not 1 <= origin.port <= 65535):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
            if address.is_loopback or address.is_unspecified:
                raise ValueError()
        except ValueError:
            if re.fullmatch(r"[0-9.]+", host):
                raise
        if not synthetic and (host == "localhost" or host.endswith((".localhost", ".invalid", ".example"))):
            raise ValueError()
        if any(c in str(data.get("API_BASE_URL", "")) for c in ("$", "#", '"', "\\", " ", "\r", "\n")):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        failures.append("API_BASE_URL")
    if not isinstance(data.get("MARKETING_VERSION"), str) or not re.fullmatch(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}", data.get("MARKETING_VERSION", "")):
        failures.append("MARKETING_VERSION")
    try:
        build_number(data.get("CURRENT_PROJECT_VERSION"))
    except ConfigError:
        failures.append("CURRENT_PROJECT_VERSION")
    if release:
        if not re.fullmatch(r"[0-9]{1,20}", str(data.get("ASC_APP_ID", ""))):
            failures.append("ASC_APP_ID")
        if not re.fullmatch(r"[A-Z0-9]{10}", str(data.get("ASC_KEY_ID", ""))):
            failures.append("ASC_KEY_ID")
        try:
            uuid.UUID(data.get("ASC_ISSUER_ID", ""))
        except (ValueError, AttributeError, TypeError):
            failures.append("ASC_ISSUER_ID")
    if data.get("ASC_INTERNAL_TEST_GROUP_ID"):
        try:
            uuid.UUID(data["ASC_INTERNAL_TEST_GROUP_ID"])
        except (ValueError, AttributeError, TypeError):
            failures.append("ASC_INTERNAL_TEST_GROUP_ID")
    if failures:
        raise ConfigError(failures)
    return data

def load(path, **options):
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ConfigError(["CONFIG_JSON"]) from None
    return validate(data, **options)

def write_xcconfig(data, path):
    # xcconfig treats // as comments. The empty expansion preserves the HTTPS slashes.
    lines = ["// Generated from validated non-secret JSON. No shell interpolation."]
    for key in BUILD_KEYS:
        value = data[key]
        if key == "API_BASE_URL":
            value = value.rstrip("/").replace("https://", "https:/$()/", 1)
        key = "DEVELOPMENT_TEAM" if key == "APPLE_TEAM_ID" else key
        lines.append(f"{key} = {value}")
    path = pathlib.Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
