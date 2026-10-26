#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(uname -s)" == Linux ]] || { echo 'This installer requires Linux.' >&2; exit 1; }
REPOSITORY="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_ROOT=''
OUTPUTS=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) SERVICE_ROOT="${2:?Missing private service root}"; shift 2 ;;
    --outputs) OUTPUTS="${2:?Missing private outputs directory}"; shift 2 ;;
    *) echo 'Usage: setup-thinkflow-linux.sh --root ABSOLUTE_PRIVATE_ROOT --outputs ABSOLUTE_PRIVATE_OUTPUTS' >&2; exit 1 ;;
  esac
done
[[ "$SERVICE_ROOT" == /* && "$OUTPUTS" == /* ]] || { echo 'Explicit absolute root and outputs paths are required.' >&2; exit 1; }
for command in git uv node npm realpath; do command -v "$command" >/dev/null || { echo "Missing local prerequisite: $command" >&2; exit 1; }; done
[[ "$(node --version)" == v24.19.0 ]] || { echo 'Node 24.19.0 is required.' >&2; exit 1; }
[[ "$(uv --version)" == 'uv 0.12.15'* ]] || { echo 'uv 0.12.15 is required.' >&2; exit 1; }
mkdir -p "$SERVICE_ROOT" "$OUTPUTS"
SERVICE_ROOT="$(realpath "$SERVICE_ROOT")"
OUTPUTS="$(realpath "$OUTPUTS")"
for directory in "$SERVICE_ROOT" "$OUTPUTS"; do
  permission="$(stat -c '%a' "$directory")"
  (( (8#$permission & 077) == 0 )) || { echo 'Selected service and outputs directories must be private (mode 700).' >&2; exit 1; }
done
SOURCE="$SERVICE_ROOT/source"
case "$OUTPUTS/" in "$SOURCE/"*) echo 'Outputs must be outside the upstream source checkout.' >&2; exit 1 ;; esac
COMMIT=1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3
if [[ ! -e "$SOURCE" ]]; then
  git clone --quiet https://github.com/OpenDCAI/ThinkFlow.git "$SOURCE"
  git -C "$SOURCE" checkout --quiet --detach "$COMMIT"
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$COMMIT" ]] || { echo 'Existing upstream revision differs; it was not changed.' >&2; exit 1; }
git -C "$SOURCE" diff --quiet
git -C "$SOURCE" diff --cached --quiet
# This installer creates the outputs symlink itself. Its exact target is checked below.
[[ -z "$(git -C "$SOURCE" ls-files --others --exclude-standard -- . ':!outputs')" ]] || { echo 'Untracked upstream files require review; no files removed.' >&2; exit 1; }
export UV_CACHE_DIR="$SERVICE_ROOT/cache"
export UV_PYTHON_INSTALL_DIR="$SERVICE_ROOT/python"
if [[ ! -x "$SERVICE_ROOT/venv/bin/python" ]]; then uv venv --python 3.11 "$SERVICE_ROOT/venv"; fi
[[ "$("$SERVICE_ROOT/venv/bin/python" --version)" == 'Python 3.11.'* ]] || { echo 'Existing private environment is not Python 3.11; it was not replaced.' >&2; exit 1; }
uv pip sync --python "$SERVICE_ROOT/venv/bin/python" "$REPOSITORY/scripts/thinkflow-requirements.lock"
"$SERVICE_ROOT/venv/bin/python" --version
OUTPUT_LINK="$SOURCE/outputs"
if [[ -L "$OUTPUT_LINK" ]]; then
  [[ "$(realpath "$OUTPUT_LINK")" == "$OUTPUTS" ]] || { echo 'Existing outputs symlink differs; no data moved.' >&2; exit 1; }
elif [[ -e "$OUTPUT_LINK" ]]; then
  [[ -d "$OUTPUT_LINK" && -z "$(find "$OUTPUT_LINK" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Existing outputs contains data; back it up and migrate explicitly.' >&2; exit 1; }
  # Only the checked empty directory in this exact private checkout is removed.
  rmdir -- "$OUTPUT_LINK"
  ln -s -- "$OUTPUTS" "$OUTPUT_LINK"
else ln -s -- "$OUTPUTS" "$OUTPUT_LINK"; fi
(
  cd "$SOURCE/frontend"
  export VITE_DEFAULT_LLM_API_URL='http://127.0.0.1:8317/v1'
  export VITE_LLM_API_URLS='http://127.0.0.1:8317/v1'
  npm ci --no-audit --no-fund
  npm run build
)
[[ ! -L "$SERVICE_ROOT/run-linux.py" ]] || { echo 'Refusing to replace a runner symlink.' >&2; exit 1; }
install -m 600 "$REPOSITORY/deploy/thinkflow-run-linux.py" "$SERVICE_ROOT/run-linux.py"
printf 'Pinned ThinkFlow ready. No service started and no model installed.\nSource: %s\nOutputs: %s\n' "$SOURCE" "$OUTPUTS"
printf 'Start with: THINKFLOW_SOURCE_ROOT=<source> THINKFLOW_PORT=8437 <root>/venv/bin/python <root>/run-linux.py\n'
