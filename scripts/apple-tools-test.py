"""Tests for delivery tooling only. Synthetic directories are NOT Apple build evidence."""
import json
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class DeliveryToolsTests(unittest.TestCase):
    def run_tool(self, name, *args):
        return subprocess.run([sys.executable, str(ROOT / "scripts" / name), *map(str, args)], capture_output=True, text=True)

    def test_placeholder_preflight_fails_without_echoing_values(self):
        result = self.run_tool("apple-delivery-preflight.py", ROOT / "apple" / "delivery-config.example.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("APPLE_TEAM_ID", result.stdout)
        self.assertNotIn("REPLACE_TEAM_ID", result.stdout)
        self.assertNotIn("agent.example.invalid", result.stdout)

    def test_preflight_is_syntax_only_and_accepts_https_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "config.json"
            config.write_text(json.dumps({
                "APPLE_TEAM_ID": "ABCDE12345", "APP_BUNDLE_ID": "org.test.research",
                "WATCH_BUNDLE_ID": "org.test.research.watchkitapp", "ASC_APP_ID": "123456789",
                "ASC_KEY_ID": "KEY1234567", "ASC_ISSUER_ID": "00000000-0000-4000-8000-000000000001",
                "API_BASE_URL": "https://research.invalid"
            }), encoding="utf-8")
            result = self.run_tool("apple-delivery-preflight.py", config)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("No account lookup, signing or upload", result.stdout)

    def synthetic_archive(self, directory, watch_version="0.2.0", include_watch=True):
        archive = pathlib.Path(directory) / "synthetic.xcarchive"
        wrapper = archive / "Products" / "Applications" / "Wrapper.app"
        wrapper.mkdir(parents=True)
        with (wrapper / "Info.plist").open("wb") as output:
            plistlib.dump({"WKWatchOnly": True, "CFBundleIdentifier": "org.test.research", "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "1"}, output)
        if include_watch:
            watch = wrapper / "Watch" / "ResearchWatch.app"
            watch.mkdir(parents=True)
            with (watch / "Info.plist").open("wb") as output:
                plistlib.dump({"WKApplication": True, "WKRunsIndependentlyOfCompanionApp": True,
                    "WKCompanionAppBundleIdentifier": "org.test.research", "CFBundleIdentifier": "org.test.research.watchkitapp",
                    "CFBundleExecutable": "ResearchWatch", "CFBundleShortVersionString": watch_version, "CFBundleVersion": "1"}, output)
            (watch / "ResearchWatch").write_bytes(b"synthetic-not-an-executable")
        return archive

    def test_inspection_labels_even_valid_synthetic_structure_unsigned_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_tool("apple-inspect-archive.py", self.synthetic_archive(temporary))
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "unsigned_structure_only")
            self.assertIn("real_device", report["not_verified"])

    def test_missing_embedded_watch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_tool("apple-inspect-archive.py", self.synthetic_archive(temporary, include_watch=False))
            self.assertNotEqual(result.returncode, 0)

    def test_version_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_tool("apple-inspect-archive.py", self.synthetic_archive(temporary, watch_version="9.9.9"))
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)["checks"]["version_matches"])

if __name__ == "__main__":
    unittest.main()
