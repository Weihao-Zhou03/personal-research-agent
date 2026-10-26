"""Validate non-secret JSON and emit an xcconfig; never reads Apple Secrets."""
import argparse
from apple_config import ConfigError, load, write_xcconfig

parser = argparse.ArgumentParser()
parser.add_argument("config")
parser.add_argument("--output", required=True)
parser.add_argument("--allow-synthetic", action="store_true")
args = parser.parse_args()
try:
    config = load(args.config, allow_synthetic=args.allow_synthetic)
    write_xcconfig(config, args.output)
except ConfigError as error:
    print(error); raise SystemExit(1)
print("Validated build configuration written; no signing or account operation performed.")
