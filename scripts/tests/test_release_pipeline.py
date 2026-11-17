"""离线执行发布门禁和安装包命名入口，不调用 GitHub 或实际编译。"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
PACKAGES = [
    "PP_Clash-0.2.1-macos-x86_64.dmg",
    "PP_Clash-0.2.1-macos-aarch64.dmg",
    "PP_Clash-0.2.1-windows-amd64-setup.exe",
    "PP_Clash-0.2.1-windows-arm64-setup.exe",
    "PP_Clash-0.2.1-linux-amd64.deb",
    "PP_Clash-0.2.1-linux-amd64.rpm",
    "PP_Clash-0.2.1-linux-amd64.AppImage",
    "PP_Clash-0.2.1-linux-arm64.deb",
    "PP_Clash-0.2.1-linux-arm64.rpm",
    "PP_Clash-0.2.1-linux-arm64.AppImage",
]


class ReleaseGateTests(unittest.TestCase):
    def run_gate(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / "validate-release.py"),
                               *args], capture_output=True, text=True)

    def test_only_a_matching_version_tag_can_publish(self):
        for ref, publish, success in [
            ("refs/heads/main", "false", True),
            ("refs/tags/v0.2.1", "false", True),
            ("refs/tags/v0.2.1", "true", True),
            ("refs/heads/main", "true", False),
            ("refs/tags/v0.2.0", "false", False),
            ("refs/tags/v0.2.0", "true", False),
        ]:
            with self.subTest(ref=ref, publish=publish):
                result = self.run_gate("ref", "--version", "0.2.1", "--ref", ref,
                                       "--publish", publish)
                self.assertEqual(result.returncode == 0, success, result.stderr)

    def test_complete_package_set_generates_correct_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in PACKAGES:
                (root / name).write_bytes(b"release fixture")
            result = self.run_gate("files", "--version", "0.2.1", "--directory", tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = (root / "SHA256SUMS").read_text().splitlines()
            self.assertEqual(len(lines), 10)
            for line in lines:
                digest, name = line.split("  ")
                self.assertEqual(digest, hashlib.sha256((root / name).read_bytes()).hexdigest())
            # 重跑门禁允许已存在的校验文件。
            self.assertEqual(self.run_gate("files", "--version", "0.2.1",
                                          "--directory", tmp).returncode, 0)

    def test_missing_wrong_version_architecture_or_empty_package_is_rejected(self):
        for replacement in [None, "PP_Clash-0.2.0-windows-arm64-setup.exe",
                            "PP_Clash-0.2.1-windows-x86-setup.exe", "empty"]:
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                for name in PACKAGES:
                    (root / name).write_bytes(b"release fixture")
                path = root / PACKAGES[3]
                if replacement == "empty":
                    path.write_bytes(b"")
                else:
                    path.unlink()
                    if replacement:
                        (root / replacement).write_bytes(b"unexpected package")
                result = self.run_gate("files", "--version", "0.2.1", "--directory", tmp)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / "SHA256SUMS").exists())


@unittest.skipIf(os.name == "nt", "POSIX Bash fixture")
class InstallerNamingTests(unittest.TestCase):
    def test_multiple_candidates_fail_without_moving_any_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPTS / "ci.sh", root / "scripts/ci.sh")
            (root / "package.json").write_text('{"version":"0.2.1"}')
            directory = root / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
            directory.mkdir(parents=True)
            for name in ["previous.exe", "latest.exe"]:
                (directory / name).write_bytes(name.encode())
            result = subprocess.run(["bash", str(root / "scripts/ci.sh"),
                                     "normalize-windows-installer"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ["latest.exe", "previous.exe"])

    def test_fresh_installer_replaces_previous_normalized_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPTS / "ci.sh", root / "scripts/ci.sh")
            # 实际调用 node 读取版本，避免测试替身代替命名逻辑。
            (root / "package.json").write_text('{"version":"0.2.1"}')
            directory = root / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
            directory.mkdir(parents=True)
            dest = directory / PACKAGES[2]
            dest.write_bytes(b"old package")
            (directory / "new-build.exe").write_bytes(b"new package")
            result = subprocess.run(["bash", str(root / "scripts/ci.sh"),
                                     "normalize-windows-installer"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dest.read_bytes(), b"new package")
            self.assertEqual(list(directory.iterdir()), [dest])

    def test_old_normalized_installer_is_not_accepted_as_a_new_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPTS / "ci.sh", root / "scripts/ci.sh")
            (root / "package.json").write_text('{"version":"0.2.1"}')
            directory = root / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
            directory.mkdir(parents=True)
            dest = directory / PACKAGES[2]
            dest.write_bytes(b"old package")
            result = subprocess.run(["bash", str(root / "scripts/ci.sh"),
                                     "normalize-windows-installer"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(dest.read_bytes(), b"old package")
            self.assertEqual(list(directory.iterdir()), [dest])


if __name__ == "__main__":
    unittest.main()
