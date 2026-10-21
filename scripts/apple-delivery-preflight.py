"""Review non-secret release configuration only. Never reads a credential or publishes."""
import argparse
import json
import pathlib
import re
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("config", type=pathlib.Path, help="Non-secret delivery JSON, copied from apple/delivery-config.example.json")
args = parser.parse_args()
data = json.loads(args.config.read_text(encoding="utf-8"))
required = ["APPLE_TEAM_ID", "APP_BUNDLE_ID", "WATCH_BUNDLE_ID", "ASC_APP_ID", "ASC_KEY_ID", "ASC_ISSUER_ID", "API_BASE_URL"]
errors = []
for key in required:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or "example" in value.lower() or value.startswith("REPLACE_"):
        errors.append(key)
url = urllib.parse.urlsplit(data.get("API_BASE_URL", ""))
if url.scheme != "https" or not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
    errors.append("API_BASE_URL")
if data.get("APP_BUNDLE_ID") and not re.fullmatch(r"[A-Za-z0-9.-]+", data["APP_BUNDLE_ID"]):
    errors.append("APP_BUNDLE_ID")
if data.get("WATCH_BUNDLE_ID") and not data["WATCH_BUNDLE_ID"].startswith(data.get("APP_BUNDLE_ID", "") + "."):
    errors.append("WATCH_BUNDLE_ID")
if data.get("ASC_APP_ID") and not data["ASC_APP_ID"].isdigit():
    errors.append("ASC_APP_ID")
if errors:
    print("Missing or invalid configuration names: " + ", ".join(sorted(set(errors))))
    raise SystemExit(1)
print("Non-secret configuration is syntactically valid. No account lookup, signing or upload performed.")
print("Next gate: unsigned archive evidence, approved account resources, certificate/profile mapping, then explicit upload authorization.")
