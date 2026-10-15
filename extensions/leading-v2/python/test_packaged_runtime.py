"""Exercise the declared build assets without falling back to the source checkout."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


PLUGIN = Path(__file__).resolve().parent.parent


class PackagedRuntimeTest(unittest.TestCase):
    def setUp(self):
        package = json.loads((PLUGIN / "package.json").read_text(encoding="utf-8"))
        self.assets = package["openclaw"]["build"]["runtimeAssets"]
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.built = self.root / "plugin"
        for asset in self.assets:
            target = self.built / asset
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PLUGIN / asset, target)

    def test_all_production_python_modules_are_shipped(self):
        production = {
            path.relative_to(PLUGIN).as_posix()
            for path in (PLUGIN / "python").rglob("*.py")
            if not path.name.startswith("test_")
            # These shared test fixtures predate the test_ naming convention.
            and path.name not in {"platform_flow_fakes.py", "platform_flow_cases.py"}
        }
        self.assertEqual(production - set(self.assets), set(), "Python modules missing from build assets")

    def test_both_packaged_entrypoints_reach_the_dependency_check(self):
        session = self.root / "session"
        payload = dict(platform="weibo", sessionDir=str(session), browserHandoff=dict(
            version=1, targetId="fixture", marker="12345678-1234-1234-1234-123456789abc",
            binding=dict(version=1, profileDir=str(self.root / "profile"), cdpUrl="http://127.0.0.1:18800")))
        env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        for script, args in (("runner.py", ["--check-runtime"]), ("browser_setup.py", [])):
            with self.subTest(script=script):
                # Without site-packages, a complete package must diagnose Playwright,
                # rather than crash before main because a sibling module was omitted.
                result = subprocess.run([sys.executable, "-S", str(self.built / "python" / script), *args],
                    input=json.dumps(payload) + "\n", cwd=self.root, env=env,
                    capture_output=True, text=True, encoding="utf-8", timeout=15)
                self.assertTrue(result.stdout.strip(), result.stderr)
                outcome = json.loads(result.stdout)
                self.assertEqual(outcome["errorCode"], "RUNTIME_DEPENDENCY_MISSING")
                self.assertIn("playwright", outcome["message"])
                self.assertFalse((session / "execution.lock").exists())


if __name__ == "__main__":
    unittest.main()
