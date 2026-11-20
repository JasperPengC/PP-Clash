"""在临时 Git 仓库验证公开文件边界，不读取本机私密文件。"""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "check-public-files.mjs"


class PublicFilesTests(unittest.TestCase):
    def check(self, names):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            (root / ".gitignore").write_text(".cache/\n*.jks\ndocs/\n")
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("public fixture\n")
            subprocess.run(["git", "add", "-f", "."], cwd=root, check=True)
            return subprocess.run(["node", str(SCRIPT)], cwd=root,
                                  capture_output=True, text=True)

    def test_release_notes_and_product_documents_are_publishable(self):
        result = self.check(["README.md", "README.zh-CN.md", "THIRD_PARTY_NOTICES.md",
                             "scripts/release-notes.md", "src/example.ts"])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_development_documents_and_forced_signing_files_are_rejected(self):
        for name in ["docs/history.md", "scripts/notes.md", ".cache/state.txt", "release.jks"]:
            with self.subTest(name=name):
                result = self.check([name])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(name, result.stderr)


if __name__ == "__main__":
    unittest.main()
