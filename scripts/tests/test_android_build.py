"""Exercise build orchestration with compiler boundaries replaced by fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


@unittest.skipIf(os.name == "nt", "Android build uses POSIX Bash")
class AndroidBuildPreparationTests(unittest.TestCase):
    def test_fresh_and_existing_projects_clean_outputs_before_tauri_build(self):
        for initialized in (False, True):
            with self.subTest(initialized=initialized), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "scripts").mkdir()
                shutil.copy2(SCRIPTS / "build-android.sh", root / "scripts/build-android.sh")
                project = root / "src-tauri/gen/android"
                (root / "src-tauri/android-core").mkdir(parents=True)
                (project / "app/build/outputs/apk").mkdir(parents=True)
                (project / "app/build/outputs/apk/stale.apk").write_bytes(b"stale output")
                (project / "app/src").mkdir()
                (project / "app/src/source.kt").write_text("source must survive")
                (project / "app/libs").mkdir()
                (project / "app/libs/mihomo.aar").write_bytes(b"core must survive")
                if initialized:
                    (project / "app/build.gradle.kts").touch()
                    (project / "tauri.settings.gradle").write_text("generated previously")
                # Gradle must evaluate settings even for :app:clean. The fresh
                # Tauri template references a file generated later by Cargo.
                gradlew = project / "gradlew"
                gradlew.write_text("#!/bin/sh\n"
                                   "test -f tauri.settings.gradle || exit 31\n"
                                   "rm -rf app/build\n")
                gradlew.chmod(0o755)
                tools = root / "tools"
                tools.mkdir()
                fixture = tools / "fixture"
                fixture.write_text(f"#!{sys.executable}\n" + '''
import json, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "npm":
    project = pathlib.Path("src-tauri/gen/android")
    if "init" in args:
        (project / "app/build.gradle.kts").touch()
    elif "build" in args:
        print(json.dumps({
            "clean": not (project / "app/build").exists(),
            "source": (project / "app/src/source.kt").read_text(),
            "core": (project / "app/libs/mihomo.aar").read_bytes().decode(),
            "args": args,
        }))
        sys.exit(42)  # Stop at the real compiler boundary.
''')
                fixture.chmod(0o755)
                for command in ("npm", "node", "go", "gomobile", "python3"):
                    (tools / command).symlink_to(fixture)
                env = dict(os.environ, LC_ALL="C", PATH=f"{tools}{os.pathsep}{os.environ['PATH']}",
                           ANDROID_HOME=str(root / "sdk"))
                result = subprocess.run(["bash", "scripts/build-android.sh", "release"],
                                        cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
                observation = json.loads(result.stdout)
                self.assertTrue(observation["clean"], "Old APK output must not be reused")
                self.assertEqual(observation["source"], "source must survive")
                self.assertEqual(observation["core"], "core must survive")
                self.assertIn("--split-per-abi", observation["args"])
                self.assertNotIn("--debug", observation["args"])


if __name__ == "__main__":
    unittest.main()
