"""Check the selected Xcode's actual export help without credentials or signing."""
import argparse
import json
import pathlib
from apple_release import ReleaseError, read_tool_help

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=pathlib.Path)
args = parser.parse_args()
try:
    text, channels = read_tool_help(["xcodebuild", "-help"])
    checks = {"app_store_connect": "app-store-connect" in text, "api_key_authentication": "authenticationKeyPath" in text}
    report = {"schema_version":"1", "status":"unsigned_help_check_only", **channels, "checks":checks}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    if not all(checks.values()): raise ReleaseError("XCODE_EXPORT_METHOD_OR_AUTH_NOT_SUPPORTED")
except ReleaseError as error: raise SystemExit(str(error)) from None
