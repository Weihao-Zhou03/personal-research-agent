"""Review non-secret release configuration only. Never reads a credential or publishes."""
import argparse
import pathlib
from apple_config import ConfigError, load, write_xcconfig

parser = argparse.ArgumentParser()
parser.add_argument("config", type=pathlib.Path, help="Non-secret delivery JSON, copied from apple/delivery-config.example.json")
args = parser.parse_args()
try:
    load(args.config, release=True)
except ConfigError as error:
    print(error); raise SystemExit(1)
print("Non-secret configuration is syntactically valid. No account lookup, signing or upload performed.")
print("Next gate: approved account resources, certificate/profile mapping, then explicit upload authorization.")
