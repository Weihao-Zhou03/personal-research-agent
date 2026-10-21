#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Apple build requires macOS and Xcode; no build has been performed.' >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
[[ -d "$DEVELOPER_DIR" ]] || { echo 'Required Xcode 26.6 is not installed.' >&2; exit 1; }
xcodebuild -version
xcodebuild -showsdks
swift --version
python3 "$ROOT/scripts/apple-tools-test.py"
OUTPUT="${APPLE_CHECK_OUTPUT:-$ROOT/apple/Generated/check}"
mkdir -p "$OUTPUT"

# Source and generator are pinned; do not silently take a newer brew version.
TOOL_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/personal-research-xcodegen-2.46.0"
if [[ ! -d "$TOOL_DIR/.git" ]]; then
  git clone --quiet --branch 2.46.0 --depth 1 https://github.com/yonaskolb/XcodeGen.git "$TOOL_DIR"
fi
EXPECTED=8445e778451c7e44237b90281bde622d764b0084
[[ "$(git -C "$TOOL_DIR" rev-parse HEAD)" == "$EXPECTED" ]] || { echo 'XcodeGen revision mismatch.' >&2; exit 1; }
swift build --package-path "$TOOL_DIR" --configuration release --product xcodegen
GENERATOR="$TOOL_DIR/.build/release/xcodegen"
"$GENERATOR" version
"$GENERATOR" generate --spec "$ROOT/apple/project.yml" --project "$ROOT/apple"

swift test --package-path "$ROOT/apple/WatchCore" 2>&1 | tee "$OUTPUT/swift-test.log"
xcodebuild -list -json -project "$ROOT/apple/PersonalResearch.xcodeproj" > "$OUTPUT/schemes.json"
xcodebuild -project "$ROOT/apple/PersonalResearch.xcodeproj" -scheme ResearchWatch \
  -destination 'generic/platform=watchOS Simulator' -configuration Debug \
  -derivedDataPath "$OUTPUT/DerivedData" CODE_SIGNING_ALLOWED=NO build \
  2>&1 | tee "$OUTPUT/watch-simulator-build.log"

# Exercise the distribution wrapper before Apple accounts are available.
# An unsigned archive is structural evidence only, not installable delivery.
xcodebuild -project "$ROOT/apple/PersonalResearch.xcodeproj" -scheme PersonalResearch \
  -destination 'generic/platform=iOS' -configuration Release \
  -archivePath "$OUTPUT/PersonalResearch.xcarchive" \
  -derivedDataPath "$OUTPUT/DerivedData" CODE_SIGNING_ALLOWED=NO archive \
  2>&1 | tee "$OUTPUT/unsigned-archive.log"
python3 "$ROOT/scripts/apple-inspect-archive.py" "$OUTPUT/PersonalResearch.xcarchive" \
  --output "$OUTPUT/archive-inspection.json"
echo 'Unsigned checks completed. Signing, upload and real-device installation are NOT verified.'
