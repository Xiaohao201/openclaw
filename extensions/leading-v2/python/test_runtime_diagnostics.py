import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


RUNTIME = Path(__file__).resolve().parent


class RuntimeDiagnosticsTest(unittest.TestCase):
    def test_fresh_process_reports_missing_playwright_for_both_entrypoints(self):
        # -S reproduces a deployment whose selected Python lacks site-packages.
        with tempfile.TemporaryDirectory() as directory:
            payload = dict(platform="douyin", link="https://www.douyin.com/video/fixture",
                           reason="Offline test reason", category="fixture", sessionDir=directory,
                           browserHandoff=dict(version=1, targetId="fixture",
                               marker="12345678-1234-1234-1234-123456789abc",
                               binding=dict(version=1, profileDir=directory,
                                            cdpUrl="http://127.0.0.1:18800")))
            for entrypoint in ("browser_setup.py", "runner.py"):
                with self.subTest(entrypoint=entrypoint):
                    result = subprocess.run(
                        [sys.executable, "-S", str(RUNTIME / entrypoint)],
                        input=json.dumps(payload) + "\n", capture_output=True, text=True,
                        encoding="utf-8", timeout=15,
                        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
                    outcome = json.loads(result.stdout)
                    self.assertEqual(outcome["state"], "failed")
                    self.assertEqual(outcome["errorCode"], "RUNTIME_DEPENDENCY_MISSING")
                    self.assertIn("playwright", outcome["message"])
                    self.assertIn(sys.executable, outcome["message"])
                    self.assertNotIn("Chromium", outcome["message"])
                    self.assertFalse(Path(directory, "execution.lock").exists())

    def test_runtime_check_never_starts_a_platform_workflow(self):
        result = subprocess.run([sys.executable, "-S", str(RUNTIME / "runner.py"), "--check-runtime"],
                                capture_output=True, text=True, encoding="utf-8", timeout=15,
                                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        self.assertNotEqual(result.returncode, 0)
        outcome = json.loads(result.stdout)
        self.assertEqual(outcome["errorCode"], "RUNTIME_DEPENDENCY_MISSING")

    def test_failure_details_do_not_include_arbitrary_exception_text(self):
        from runtime_diagnostics import runtime_failure
        secret = "https://example.test/?token=secret-value"
        result = runtime_failure(RuntimeError(secret), "browser_attach")
        self.assertIn("RuntimeError", result["message"])
        self.assertIn("browser_attach", result["message"])
        self.assertNotIn("secret-value", json.dumps(result))

    def test_checker_starts_driver_without_launching_chrome(self):
        from runtime_diagnostics import check_runtime
        playwright = Mock()
        with patch("playwright.sync_api.sync_playwright") as sync:
            sync.return_value.start.return_value = playwright
            result = check_runtime()
        self.assertTrue(result["ready"])
        playwright.stop.assert_called_once()
        playwright.chromium.launch.assert_not_called()
        playwright.chromium.connect_over_cdp.assert_not_called()

    def test_classifies_startup_failures_without_exposing_exception_payloads(self):
        from runtime_diagnostics import runtime_failure
        from shared_browser import SharedBrowserUnavailable
        cases = [
            (ModuleNotFoundError("secret-value", name="playwright.sync_api"), "RUNTIME_DEPENDENCY_MISSING"),
            (ImportError("secret-value"), "RUNTIME_IMPORT_FAILED"),
            (PermissionError("secret-value"), "RUNTIME_PERMISSION_DENIED"),
        ]
        for error, code in cases:
            with self.subTest(code=code):
                result = runtime_failure(error, "module_import")
                self.assertEqual(result["errorCode"], code)
                self.assertNotIn("secret-value", json.dumps(result))
        result = runtime_failure(ModuleNotFoundError("secret-value", name="token=secret-value"), "module_import")
        self.assertNotIn("secret-value", json.dumps(result))
        result = runtime_failure(SharedBrowserUnavailable("Missing browser binding"), "browser_attach")
        self.assertEqual(result["state"], "manual_required")
        self.assertEqual(result["errorCode"], "SHARED_BROWSER_UNAVAILABLE")

    def test_checker_rejects_unsupported_python_before_importing_executor(self):
        from runtime_diagnostics import check_runtime
        with patch("runtime_diagnostics.sys.version_info", (3, 9)), \
                patch("runtime_diagnostics.importlib.import_module") as load:
            result = check_runtime()
        self.assertFalse(result["ready"])
        self.assertEqual(result["errorCode"], "RUNTIME_PYTHON_UNSUPPORTED")
        load.assert_not_called()

    def test_checker_returns_driver_failure_and_attempts_cleanup(self):
        from runtime_diagnostics import check_runtime
        driver = Mock()
        driver.stop.side_effect = RuntimeError("secret-value")
        with patch("playwright.sync_api.sync_playwright") as sync:
            sync.return_value.start.return_value = driver
            result = check_runtime()
        self.assertFalse(result["ready"])
        self.assertEqual(result["errorCode"], "RUNTIME_UNAVAILABLE")
        self.assertIn("playwright_driver", result["message"])
        self.assertNotIn("secret-value", json.dumps(result))
        self.assertEqual(driver.stop.call_count, 2)


if __name__ == "__main__":
    unittest.main()
