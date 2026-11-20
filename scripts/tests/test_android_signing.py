"""使用真实 JDK 密钥验证 Android 发布签名，不接触生产证书。"""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "check-android-signing.mjs"
JAVA_HOME = os.environ.get("JAVA_HOME")
KEYTOOL = str(Path(JAVA_HOME) / "bin" / ("keytool.exe" if os.name == "nt" else "keytool")) if JAVA_HOME else shutil.which("keytool")


@unittest.skipUnless(KEYTOOL, "JDK is required for signing fixtures")
class AndroidSigningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.TemporaryDirectory()
        cls.root = Path(cls.work.name)
        cls.password = secrets.token_hex(24)
        cls.key_password = secrets.token_hex(24)
        cls.env = dict(os.environ, PPCLASH_ANDROID_STORE_PASSWORD=cls.password,
                       PPCLASH_ANDROID_KEY_PASSWORD=cls.key_password, PPCLASH_ANDROID_KEY_ALIAS="release")
        cls.fingerprints = {}
        for name, days, owner in [("release", 10000, "PP Clash Test"), ("short", 30, "PP Clash Test"),
                                  ("debug", 10000, "Android Debug")]:
            path = cls.root / f"{name}.jks"
            subprocess.run([KEYTOOL, "-genkeypair", "-noprompt", "-storetype", "JKS", "-keystore", str(path),
                            "-alias", "release", "-keyalg", "RSA", "-keysize", "2048", "-validity", str(days),
                            "-dname", f"CN={owner},O=Test,C=US", "-storepass:env", "PPCLASH_ANDROID_STORE_PASSWORD",
                            "-keypass:env", "PPCLASH_ANDROID_KEY_PASSWORD"], env=cls.env, check=True, capture_output=True)
            der = subprocess.check_output([KEYTOOL, "-exportcert", "-keystore", str(path), "-alias", "release",
                                           "-storepass:env", "PPCLASH_ANDROID_STORE_PASSWORD"], env=cls.env, stderr=subprocess.DEVNULL)
            cls.fingerprints[name] = hashlib.sha256(der).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.work.cleanup()

    def run_check(self, name="release", **changes):
        env = dict(self.env, PPCLASH_ANDROID_KEYSTORE=str(self.root / f"{name}.jks"),
                   PPCLASH_ANDROID_CERT_SHA256=self.fingerprints[name])
        env.update(changes)
        return subprocess.run(["node", str(SCRIPT)], env=env, capture_output=True, text=True)

    def test_accepts_the_pinned_long_lived_private_key(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Android release signing verified", result.stdout)

    def test_rejects_missing_or_wrong_fingerprint(self):
        for fingerprint in ["", "invalid", "0" * 64]:
            with self.subTest(fingerprint=fingerprint):
                result = self.run_check(PPCLASH_ANDROID_CERT_SHA256=fingerprint)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("certificate", result.stderr.lower())

    def test_rejects_debug_and_short_lived_certificates(self):
        for name in ["short", "debug"]:
            with self.subTest(name=name):
                result = self.run_check(name)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("certificate", result.stderr.lower())

    def test_wrong_password_or_alias_fails_without_printing_credentials(self):
        for field in ["PPCLASH_ANDROID_STORE_PASSWORD", "PPCLASH_ANDROID_KEY_PASSWORD", "PPCLASH_ANDROID_KEY_ALIAS"]:
            with self.subTest(field=field):
                wrong = secrets.token_hex(16)
                result = self.run_check(**{field: wrong})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("signing", result.stderr.lower())
                for value in [wrong, self.password, self.key_password]:
                    self.assertNotIn(value, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
