"""Tests for delivery tooling only. Synthetic directories are NOT Apple build evidence."""
import json
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest
import datetime
import hashlib
import copy
from unittest.mock import patch
from types import SimpleNamespace
from apple_config import ConfigError, load, validate, write_xcconfig
from apple_release import ASC, DeliveryJournal, ReleaseError, check_profile, jose_signature, read_tool_help, validate_cleanup_record

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
                "API_BASE_URL": "https://research.test.org", "MARKETING_VERSION": "0.3.0", "CURRENT_PROJECT_VERSION": "101"
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

    def test_build_config_rejects_wrong_types_unknown_fields_and_injection(self):
        baseline = json.loads((ROOT / "apple/ci-config.json").read_text(encoding="utf-8"))
        mutations = [
            {"CURRENT_PROJECT_VERSION": 101}, {"MARKETING_VERSION": "1.0\nCODE_SIGNING_ALLOWED=YES"},
            {"APPLE_TEAM_ID": "$(SECRET)"}, {"WATCH_BUNDLE_ID": "org.other.watch"},
            {"API_BASE_URL": "https://host.test.org/#secret"}, {"API_BASE_URL": "https://host.test.org/$()"},
            {"API_BASE_URL": "http://host.test.org"}, {"API_BASE_URL": "https://user:pass@host.test.org"},
            {"API_BASE_URL": "https://127.0.0.1"}, {"EXTRA_PRIVATE_VALUE": "must-not-print"},
        ]
        for mutation in mutations:
            with self.assertRaises(ConfigError) as caught:
                validate({**baseline, **mutation}, allow_synthetic=True)
            self.assertNotIn("must-not-print", str(caught.exception))

    def test_synthetic_config_is_explicitly_blocked_for_release(self):
        config = ROOT / "apple/ci-config.json"
        load(config, allow_synthetic=True)
        with self.assertRaises(ConfigError): load(config)
        with self.assertRaises(ConfigError): load(config, release=True, allow_synthetic=True)

    def test_xcconfig_preserves_https_slashes_without_comments_or_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary) / "Build.xcconfig"
            data = load(ROOT / "apple/ci-config.json", allow_synthetic=True)
            write_xcconfig(data, output)
            text = output.read_text(encoding="utf-8")
            self.assertIn("API_BASE_URL = https:/$()/ci-backend.invalid", text)
            self.assertIn("DEVELOPMENT_TEAM = CI00000000", text)
            self.assertIn("CURRENT_PROJECT_VERSION = 100", text)

    def test_expected_config_rejects_wrong_archived_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_tool("apple-inspect-archive.py", self.synthetic_archive(temporary), "--expected-config", ROOT / "apple/ci-config.json")
            self.assertNotEqual(result.returncode, 0)
            report = json.loads(result.stdout)
            self.assertFalse(report["checks"]["expected_root_bundle"])
            self.assertFalse(report["checks"]["expected_api_origin"])

    def profile_fixture(self):
        return {"UUID":"00000000-0000-4000-8000-000000000001", "ExpirationDate":datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30),
            "TeamIdentifier":["ABCDE12345"], "ApplicationIdentifierPrefix":["ABCDE12345"], "DeveloperCertificates":[b"synthetic-certificate"],
            "Entitlements":{"application-identifier":"ABCDE12345.org.test.research", "com.apple.developer.team-identifier":"ABCDE12345", "get-task-allow":False}}

    def check_synthetic_profile(self, profile):
        return check_profile(profile,bundle="org.test.research",team="ABCDE12345",certificate_sha1=hashlib.sha1(b"synthetic-certificate").hexdigest())

    def test_profile_checks_exact_team_bundle_certificate_and_distribution(self):
        baseline = self.profile_fixture()
        self.assertEqual(self.check_synthetic_profile(baseline),baseline["UUID"])
        for mutation in [
            {"TeamIdentifier":["OTHER12345"]}, {"DeveloperCertificates":[b"wrong-certificate"]},
            {"ProvisionedDevices":["synthetic-device"]}, {"ProvisionsAllDevices":True},
            {"ExpirationDate":datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)},
            {"Entitlements":{**baseline["Entitlements"],"application-identifier":"ABCDE12345.*"}},
            {"Entitlements":{**baseline["Entitlements"],"get-task-allow":True}},
        ]:
            with self.assertRaises(ReleaseError): self.check_synthetic_profile({**copy.deepcopy(baseline),**mutation})

    def test_asc_jose_signature_converts_der_integers_without_private_key(self):
        raw=jose_signature(bytes.fromhex("3006020101020102"))
        self.assertEqual(len(raw),64);self.assertEqual(raw[:32],(1).to_bytes(32,"big"));self.assertEqual(raw[32:],(2).to_bytes(32,"big"))
        with self.assertRaises(ReleaseError): jose_signature(b"not-der")

    def test_signing_cleanup_rejects_paths_outside_its_own_temporary_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve(); own = root / "research-apple-signing-synthetic"
            record={"directory":str(own),"keychain":str(own / "signing.keychain-db"),"profiles":[],"original_search":[]}
            validate_cleanup_record(record,root,root / "home")
            with self.assertRaises(ReleaseError): validate_cleanup_record({**record,"directory":str(root)},root,root / "home")
            with self.assertRaises(ReleaseError): validate_cleanup_record({**record,"keychain":str(root / "other.keychain")},root,root / "home")
            with self.assertRaises(ReleaseError): validate_cleanup_record({**record,"profiles":[str(root / "user.mobileprovision")]},root,root / "home")

    def test_xcode_help_in_stderr_is_checked_without_secret_tool_output(self):
        result = SimpleNamespace(returncode=0,stdout=b"",stderr=b"app-store-connect authenticationKeyPath")
        with patch("apple_release.subprocess.run",return_value=result):
            text, channels = read_tool_help(["xcodebuild","-help"])
        self.assertIn("app-store-connect",text);self.assertEqual(channels["stdout_bytes"],0)
        self.assertGreater(channels["stderr_bytes"],0)

    def group_client(self, document):
        class FakeASC(ASC):
            def request(self,path,*,method="GET",body=None):
                self.calls.append((path,method,body))
                return document if method == "GET" else {}
        client=FakeASC({"ASC_APP_ID":"12345","ASC_INTERNAL_TEST_GROUP_ID":"group-synthetic"},None)
        client.calls=[];return client

    def group_document(self):
        return {"data":{"type":"betaGroups","id":"group-synthetic","attributes":{"isInternalGroup":True,"publicLinkEnabled":False},"relationships":{"app":{"data":{"type":"apps","id":"12345"}}}}}

    def test_internal_group_is_verified_before_adding_build(self):
        client=self.group_client(self.group_document())
        self.assertTrue(client.assign_internal_group("build-synthetic"))
        self.assertEqual([call[1] for call in client.calls],["GET","POST"])
        self.assertEqual(client.calls[1][2],{"data":[{"type":"builds","id":"build-synthetic"}]})

    def test_external_cross_app_or_public_group_never_receives_build(self):
        for mutation in ("external","cross_app","public","wrong_id","missing_internal"):
            document=self.group_document();resource=document["data"]
            if mutation == "external": resource["attributes"]["isInternalGroup"]=False
            elif mutation == "cross_app": resource["relationships"]["app"]["data"]["id"]="other"
            elif mutation == "public": resource["attributes"]["publicLinkEnabled"]=True
            elif mutation == "wrong_id": resource["id"]="other"
            else: del resource["attributes"]["isInternalGroup"]
            client=self.group_client(document)
            with self.assertRaises(ReleaseError):client.assign_internal_group("build-synthetic")
            self.assertTrue(all(call[1] == "GET" for call in client.calls))

    def test_delivery_journal_preserves_unknown_upload_and_unverified_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=pathlib.Path(temporary) / "release-report.json"
            journal=DeliveryJournal(path,"a"*40,"101")
            journal.update(signed_archive=True,exported=True,uploaded=None,upload_state="submission_unknown")
            report=json.loads(path.read_text())
            self.assertIsNone(report["uploaded"]);self.assertEqual(report["upload_state"],"submission_unknown")
            self.assertEqual(report["real_device"],"NOT_VERIFIED")
            with self.assertRaises(ReleaseError): journal.update(raw_secret="not-allowed")

    def test_asc_processing_waits_for_valid_and_rejects_failed_state(self):
        class FakeASC(ASC):
            def request(self,path,**kwargs):return {"data":[{"id":"build-synthetic","attributes":{"processingState":self.states.pop(0)}}]}
        client=FakeASC({"ASC_APP_ID":"12345","CURRENT_PROJECT_VERSION":"101"},None)
        client.states=["PROCESSING","VALID"]
        with patch("apple_release.time.sleep") as sleep:
            result=client.wait_for_processing()
        self.assertEqual(result["attributes"]["processingState"],"VALID");sleep.assert_called_once_with(30)
        client.states=["FAILED"]
        with self.assertRaises(ReleaseError):client.wait_for_processing()

if __name__ == "__main__":
    unittest.main()
