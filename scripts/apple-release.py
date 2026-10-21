"""Explicitly authorized, trusted-ref signing/export/upload. No automatic store release."""
import argparse
import json
import os
import pathlib
import plistlib
import re
import secrets
import shlex
import signal
import subprocess
import sys
import tempfile
from apple_config import ConfigError, load, write_xcconfig
from apple_release import ASC, DeliveryJournal, ReleaseError, check_profile, cleanup_signing, decode_secret, read_tool_help, run

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("config", type=pathlib.Path)
parser.add_argument("--trusted-sha", required=True)
parser.add_argument("--authorize-upload", action="store_true")
args = parser.parse_args()

def main():
    config = load(args.config, release=True)
    if sys.platform != "darwin": raise ReleaseError("MACOS_XCODE_REQUIRED")
    if not args.authorize_upload or os.getenv("APPLE_UPLOAD_AUTHORIZED") != "true": raise ReleaseError("UPLOAD_AUTHORIZATION_REQUIRED")
    head = run(["git", "rev-parse", "HEAD"]).decode().strip()
    if head != args.trusted_sha or len(head) != 40: raise ReleaseError("TRUSTED_SHA_MISMATCH")
    run(["git", "merge-base", "--is-ancestor", head, "origin/main"])
    fields = ["APPLE_DISTRIBUTION_P12_BASE64", "APPLE_DISTRIBUTION_P12_PASSWORD", "APPLE_PROFILES_BASE64_JSON", "ASC_API_PRIVATE_KEY_BASE64"]
    missing = [field for field in fields if not os.getenv(field)]
    if missing: raise ConfigError(missing)
    secret_values = {field: os.environ.pop(field) for field in fields}
    os.environ["DEVELOPER_DIR"] = "/Applications/Xcode_26.6.app/Contents/Developer"
    if not pathlib.Path(os.environ["DEVELOPER_DIR"]).is_dir(): raise ReleaseError("XCODE_26_6_REQUIRED")
    help_text, _ = read_tool_help(["xcodebuild", "-help"])
    if "app-store-connect" not in help_text or "authenticationKeyPath" not in help_text:
        raise ReleaseError("XCODE_EXPORT_METHOD_OR_AUTH_NOT_SUPPORTED")
    output = ROOT / "apple/Generated/release"
    output.mkdir(parents=True, exist_ok=True)
    journal = DeliveryJournal(output / "release-report.json", head, config["CURRENT_PROJECT_VERSION"])
    env = dict(os.environ, APPLE_CONFIG_PATH=str(args.config.resolve()), APPLE_ALLOW_SYNTHETIC="0", APPLE_CHECK_OUTPUT=str(output / "unsigned"))
    # No account side effects until the same real non-secret configuration passed unsigned checks.
    subprocess.run(["bash", str(ROOT / "scripts/apple-check.sh")], env=env, check=True)
    with tempfile.TemporaryDirectory(prefix="research-apple-signing-", dir=os.getenv("RUNNER_TEMP")) as directory:
        temp = pathlib.Path(directory)
        keychain = temp / "signing.keychain-db"
        installed = []
        original_search = shlex.split(run(["security", "list-keychains", "-d", "user"]).decode())
        cleanup_path = pathlib.Path(os.getenv("RUNNER_TEMP", tempfile.gettempdir())) / "research-apple-cleanup.json"
        cleanup_record = {"directory":str(temp), "keychain":str(keychain), "profiles":[], "original_search":original_search}
        def save_cleanup_record():
            cleanup_path.write_text(json.dumps(cleanup_record)); cleanup_path.chmod(0o600)
        save_cleanup_record()
        try:
            p12 = temp / "distribution.p12"
            p12.write_bytes(decode_secret(secret_values[fields[0]], fields[0])); p12.chmod(0o600)
            p8 = temp / ("AuthKey_" + config["ASC_KEY_ID"] + ".p8")
            p8.write_bytes(decode_secret(secret_values[fields[3]], fields[3])); p8.chmod(0o600)
            cert = temp / "distribution.pem"
            cert.write_bytes(run(["openssl", "pkcs12", "-in", p12, "-clcerts", "-nokeys", "-passin", "env:APPLE_DISTRIBUTION_P12_PASSWORD"],
                env={**os.environ, "APPLE_DISTRIBUTION_P12_PASSWORD":secret_values[fields[1]]}))
            run(["openssl", "x509", "-in", cert, "-noout", "-checkend", "86400"])
            subject = run(["openssl", "x509", "-in", cert, "-noout", "-subject", "-nameopt", "RFC2253"]).decode()
            if not re.search(r"(?:^|,)OU=" + re.escape(config["APPLE_TEAM_ID"]) + r"(?:,|$)", subject.removeprefix("subject=")) or "CN=Apple Distribution" not in subject:
                raise ReleaseError("DISTRIBUTION_CERTIFICATE_TEAM")
            fingerprint = run(["openssl", "x509", "-in", cert, "-noout", "-fingerprint", "-sha1"]).decode().strip().split("=")[-1].replace(":", "").upper()
            password = secrets.token_urlsafe(32)
            run(["security", "create-keychain", "-p", password, keychain])
            run(["security", "set-keychain-settings", "-lut", "21600", keychain])
            run(["security", "unlock-keychain", "-p", password, keychain])
            run(["security", "import", p12, "-P", secret_values[fields[1]], "-A", "-t", "cert", "-f", "pkcs12", "-k", keychain])
            run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-k", password, keychain])
            run(["security", "list-keychains", "-d", "user", "-s", keychain, *original_search])
            if fingerprint not in run(["security", "find-identity", "-v", "-p", "codesigning", keychain]).decode(): raise ReleaseError("VALID_SIGNING_IDENTITY_MISSING")
            try: profile_values = json.loads(secret_values[fields[2]])
            except json.JSONDecodeError: raise ConfigError([fields[2]]) from None
            if not isinstance(profile_values, dict): raise ConfigError([fields[2]])
            manifest = json.loads((ROOT / "apple/delivery-manifest.json").read_text())
            profiles = {}; targets = {}
            profile_dir = pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles"
            profile_dir.mkdir(parents=True, exist_ok=True)
            for target in manifest["targets"]:
                bundle = config[target["bundle_id_setting"]]
                if bundle not in profile_values: raise ReleaseError("APPSTORE_PROFILE_MAPPING_MISSING")
                raw = decode_secret(profile_values[bundle], fields[2])
                local = temp / (target["name"] + ".mobileprovision"); local.write_bytes(raw)
                profile = plistlib.loads(run(["security", "cms", "-D", "-i", local]))
                profile_id = check_profile(profile, bundle=bundle, team=config["APPLE_TEAM_ID"], certificate_sha1=fingerprint)
                installed_path = profile_dir / (profile_id + ".mobileprovision")
                if installed_path.exists(): raise ReleaseError("PROFILE_INSTALL_PATH_ALREADY_EXISTS")
                cleanup_record["profiles"].append(str(installed_path)); save_cleanup_record()
                installed_path.write_bytes(raw); installed.append(installed_path)
                profiles[bundle] = profile_id
                targets[target["name"]] = {"settings":{"base":{"CODE_SIGN_STYLE":"Manual", "CODE_SIGN_IDENTITY":fingerprint, "PROVISIONING_PROFILE_SPECIFIER":profile_id}}}
            asc = ASC(config, p8); asc.check_app_and_increasing_build(); asc.check_internal_group()
            signing_spec = output / "SigningProject.json"
            signing_spec.write_text(json.dumps({"include":[str(ROOT / "apple/project.yml")], "targets":targets}))
            generator = pathlib.Path(os.getenv("RUNNER_TEMP", os.getenv("TMPDIR", "/tmp"))) / "personal-research-xcodegen-2.46.0/.build/release/xcodegen"
            run([generator, "generate", "--spec", signing_spec, "--project-root", ROOT / "apple", "--project", ROOT / "apple"])
            xcconfig = output / "Build.xcconfig"; write_xcconfig(config, xcconfig)
            archive = output / "PersonalResearch.xcarchive"
            commands = ["xcodebuild", "-project", ROOT / "apple/PersonalResearch.xcodeproj", "-scheme", "PersonalResearch", "-configuration", "Release",
                "-destination", "generic/platform=iOS", "-archivePath", archive, "-xcconfig", xcconfig, "archive"]
            with (output / "signed-archive.log").open("wb") as log:
                subprocess.run([str(x) for x in commands], stdout=log, stderr=subprocess.STDOUT, check=True)
            run([sys.executable, ROOT / "scripts/apple-inspect-archive.py", archive, "--expected-config", args.config, "--output", output / "signed-structure.json"])
            applications = list((archive / "Products/Applications").glob("*.app"))
            for app in [*applications, *applications[0].joinpath("Watch").glob("*.app")]:
                run(["codesign", "--verify", "--strict", "--deep", app])
            journal.update(signed_archive=True, profile_mapping=profiles)
            options = {"method":"app-store-connect", "destination":"export", "teamID":config["APPLE_TEAM_ID"], "signingStyle":"manual",
                "signingCertificate":fingerprint, "provisioningProfiles":profiles, "manageAppVersionAndBuildNumber":False, "uploadSymbols":True}
            export_options = output / "ExportOptions.plist"
            with export_options.open("wb") as stream: plistlib.dump(options, stream)
            run(["xcodebuild", "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", export_options, "-exportPath", output / "export"])
            if len(list((output / "export").glob("*.ipa"))) != 1: raise ReleaseError("EXPORTED_IPA_MISSING")
            journal.update(exported=True)
            # Separate export and upload gates. No deprecated altool --upload-app invocation.
            options["destination"] = "upload"
            upload_options = output / "UploadOptions.plist"
            with upload_options.open("wb") as stream: plistlib.dump(options, stream)
            journal.update(uploaded=None, upload_state="submission_unknown")
            run(["xcodebuild", "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", upload_options, "-exportPath", output / "upload",
                "-authenticationKeyPath", p8, "-authenticationKeyID", config["ASC_KEY_ID"], "-authenticationKeyIssuerID", config["ASC_ISSUER_ID"]])
            journal.update(uploaded=True, upload_state="accepted", asc_processing="PROCESSING_NOT_CONFIRMED")
            build = asc.wait_for_processing()
            journal.update(asc_processing="VALID")
            journal.update(internal_group_assigned=asc.assign_internal_group(build["id"]))
            print("Upload and ASC processing confirmed. Compliance, TestFlight visibility and real-device installation require separate verification.")
        finally:
            cleanup_signing(cleanup_record, os.getenv("RUNNER_TEMP", tempfile.gettempdir()), pathlib.Path.home())
            cleanup_path.unlink(missing_ok=True)

if __name__ == "__main__":
    def interrupted(*_): raise ReleaseError("RELEASE_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try: main()
    except (ConfigError, ReleaseError) as error: print(str(error)); raise SystemExit(1)
    except subprocess.CalledProcessError: print("RELEASE_TOOL_FAILED_CHECK_LOCAL_BUILD_LOG"); raise SystemExit(1)
