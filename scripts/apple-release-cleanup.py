"""Always-step fallback for this run's bounded signing directory and installed profiles."""
import json
import os
import pathlib
import sys
from apple_release import ReleaseError, cleanup_signing

if sys.platform != "darwin": raise SystemExit("MACOS_REQUIRED")
directory = os.getenv("RUNNER_TEMP")
if not directory: raise SystemExit("RUNNER_TEMP_REQUIRED")
record_path = pathlib.Path(directory) / "research-apple-cleanup.json"
if not record_path.exists():
    print("No signing cleanup record remains.")
else:
    try:
        cleanup_signing(json.loads(record_path.read_text()), directory, pathlib.Path.home())
        record_path.unlink()
    except (ReleaseError, ValueError, KeyError, OSError): raise SystemExit("SIGNING_CLEANUP_FAILED") from None
    print("Temporary signing keychain, profiles and private-key directory removed.")
