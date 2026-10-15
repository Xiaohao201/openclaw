"""Opt-in CDP smoke test using a disposable Chrome profile and an offline page."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.environ.get("OPENCLAW_COMPLAINT_BROWSER_SMOKE") == "1", "opt-in Chrome smoke")
class BrowserHandoffLiveTest(unittest.TestCase):
    def test_python_login_borrows_the_running_browser_without_closing_its_tab(self):
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
            profile = Path(directory) / "profile"
            session = Path(directory) / "session"
            session.mkdir()
            owner = playwright.chromium.launch_persistent_context(
                str(profile), channel="chrome", headless=True, args=["--remote-debugging-port=0"])
            try:
                page = owner.pages[0]
                page.goto("data:text/html,<title>OpenClaw fixture</title>")
                marker = "12345678-1234-1234-1234-123456789abc"
                page.evaluate("marker => window.__openclaw_session_handoff_v1 = marker", marker)
                port = (profile / "DevToolsActivePort").read_text().splitlines()[0]
                binding = dict(version=1, profileDir=str(profile), cdpUrl=f"http://127.0.0.1:{port}")
                (session / "browser-binding.json").write_text(json.dumps(binding), encoding="utf-8")
                payload = dict(platform="weibo", sessionDir=str(session), browserHandoff=dict(
                    version=1, targetId="fixture", marker=marker, binding=binding))
                script = "\n".join([
                    "import json,queue,sys",
                    "from browser_setup import setup,LOGIN_URLS",
                    "LOGIN_URLS['weibo']='data:text/html,<title>Login fixture</title>'",
                    "commands=queue.Queue();commands.put('finish')",
                    "setup(json.load(sys.stdin),commands,lambda result: print(json.dumps(result),flush=True))",
                ])
                result = subprocess.run([sys.executable, "-c", script], input=json.dumps(payload),
                    cwd=Path(__file__).resolve().parent, text=True, encoding="utf-8",
                    capture_output=True, timeout=45,
                    env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout.splitlines()[-1])["state"], "saved")
                self.assertFalse(page.is_closed())
                self.assertEqual(page.title(), "Login fixture")
                self.assertEqual(len(owner.pages), 1)
                self.assertFalse((session / "ChromeOptions").exists())
            finally:
                owner.close()


if __name__ == "__main__":
    unittest.main()
