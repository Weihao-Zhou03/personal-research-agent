"""Inspect actual archive products; does not sign, export, upload or claim installability."""
import argparse
import json
import pathlib
import plistlib

parser = argparse.ArgumentParser()
parser.add_argument("archive", type=pathlib.Path)
parser.add_argument("--output", type=pathlib.Path)
args = parser.parse_args()
archive = args.archive.resolve()
applications = archive / "Products" / "Applications"
roots = list(applications.glob("*.app"))
if len(roots) != 1:
    parser.error("Expected one top-level distribution application")
root = roots[0]
watches = list((root / "Watch").glob("*.app"))
if len(watches) != 1:
    parser.error("Expected one embedded Watch application inside wrapper/Watch")

def info(path):
    with (path / "Info.plist").open("rb") as stream:
        return plistlib.load(stream)

wrapper, watch = info(root), info(watches[0])
checks = {
    "watch_only_wrapper": wrapper.get("WKWatchOnly") is True,
    "single_target_watch_app": watch.get("WKApplication") is True,
    "independent": watch.get("WKRunsIndependentlyOfCompanionApp") is True,
    "companion_bundle_matches_root": watch.get("WKCompanionAppBundleIdentifier") == wrapper.get("CFBundleIdentifier"),
    "version_matches": watch.get("CFBundleShortVersionString") == wrapper.get("CFBundleShortVersionString"),
    "build_matches": watch.get("CFBundleVersion") == wrapper.get("CFBundleVersion"),
    "watch_executable_present": bool(watch.get("CFBundleExecutable")) and (watches[0] / watch.get("CFBundleExecutable", "")).is_file(),
    "no_legacy_watchkit_extension": not list((watches[0] / "PlugIns").glob("*.appex")),
}
result = {
    "schema_version": "1", "status": "unsigned_structure_only",
    "wrapper_bundle_id": wrapper.get("CFBundleIdentifier"),
    "watch_bundle_id": watch.get("CFBundleIdentifier"),
    "version": watch.get("CFBundleShortVersionString"), "build": watch.get("CFBundleVersion"),
    "checks": checks,
    "not_verified": ["distribution_signing", "export", "ASC_upload_and_processing", "TestFlight", "real_device"],
}
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
if not all(checks.values()):
    raise SystemExit("Archive structure validation failed")
