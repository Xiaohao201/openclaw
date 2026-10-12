import tempfile
import unittest
import io
import json
from unittest.mock import Mock, patch
from pathlib import Path
from types import SimpleNamespace
from runner import execute, execute_12377, login, main, save_sessions, validate_input


class Manager:
    def __init__(self, *, login=True, confirmed=True, result=True):
        self.login = login
        self.submission_confirmed = confirmed
        self.result = result
        self.closed = False
        self.last_flow_result = SimpleNamespace(error_code=SimpleNamespace(value="NONE"))
        self.contexts = {}
        self.errMessage = ""

    def init_browsers(self, platform): pass
    def check_login_status(self, platform): return self.login
    def perform_complaint(self, platform, data): return self.result
    def close_all(self): self.closed = True


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.payload = dict(link="https://weibo.com/1/2", platform="weibo",
                            reason="已经核对原文及证据，举报内容与事实不符。", category="不实信息",
                            sessionDir=self.temp.name, headless=True, role="Personal")

    def test_success_requires_observed_platform_confirmation(self):
        manager = Manager(confirmed=False)
        result = execute(self.payload, manager_factory=lambda: manager)
        self.assertEqual(result["state"], "unknown")
        self.assertTrue(manager.closed)

    def test_browser_helper_tracks_success_not_handler_boolean(self):
        from browser_manager import BrowserManager
        manager = BrowserManager.__new__(BrowserManager)
        manager.submission_confirmed = False
        page = Mock()
        page.wait_for_selector.side_effect = RuntimeError("missing marker")
        self.assertFalse(manager._check_submit_success(page, "#success"))
        self.assertFalse(manager.submission_confirmed)
        page.wait_for_selector.side_effect = None
        self.assertTrue(manager._check_submit_success(page, "#success"))
        self.assertTrue(manager.submission_confirmed)

    def test_confirmed_submission(self):
        manager = Manager()
        self.assertEqual(execute(self.payload, manager_factory=lambda: manager)["state"], "done")
        self.assertFalse((Path(self.temp.name) / "execution.lock").exists())

    def test_app_only_fallback_before_desktop_login(self):
        manager = Manager(login=False, confirmed=False)
        manager.pages = {"xiaohongshu": Mock()}
        payload = dict(self.payload, platform="xiaohongshu",
                       link="https://www.xiaohongshu.com/explore/0123456789abcdef01234567")
        with patch("xhs_phone.mobile_only_target", return_value=payload['link']), \
                patch("xhs_phone.execute_phone", return_value=dict(state="done")) as phone:
            self.assertEqual(execute(payload, manager_factory=lambda: manager)['state'], 'done')
            phone.assert_called_once_with(payload, payload['link'])
            self.assertTrue(manager.closed)

    def test_web_unknown_does_not_fall_back(self):
        manager = Manager(confirmed=False)
        manager.pages = {"xiaohongshu": Mock()}
        payload = dict(self.payload, platform="xiaohongshu")
        with patch("xhs_phone.mobile_only_target", return_value=None), \
                patch("xhs_phone.execute_phone") as phone:
            self.assertEqual(execute(payload, manager_factory=lambda: manager)['state'], 'unknown')
            phone.assert_not_called()

    def test_handler_gate_switches_before_any_submission(self):
        manager = Manager(confirmed=False)
        manager.pages = {"xiaohongshu": Mock()}
        manager.mobile_only_url = 'https://www.xiaohongshu.com/explore/' + 'a' * 24
        with patch("xhs_phone.mobile_only_target", return_value=None), \
                patch("xhs_phone.execute_phone", return_value=dict(state='manual_required')) as phone:
            self.assertEqual(execute(dict(self.payload, platform='xiaohongshu'),
                                     manager_factory=lambda: manager)['state'], 'manual_required')
            phone.assert_called_once()

    def test_login_is_manual_and_no_submission_occurs(self):
        manager = Manager(login=False)
        manager.perform_complaint = lambda *args: self.fail("must not submit")
        self.assertEqual(execute(self.payload, manager_factory=lambda: manager)["state"], "manual_required")

    def test_lock_prevents_parallel_and_crash_replay(self):
        (Path(self.temp.name) / "execution.lock").write_text("existing")
        result = execute(self.payload, manager_factory=lambda: self.fail("must not start"))
        self.assertEqual(result["errorCode"], "SESSION_LOCKED")

    def test_exception_after_execution_is_unknown(self):
        manager = Manager()
        def fail(*args): raise RuntimeError("secret detail")
        manager.perform_complaint = fail
        result = execute(self.payload, manager_factory=lambda: manager)
        self.assertEqual(result["state"], "unknown")
        self.assertNotIn("secret", result["message"])

    def test_rejects_invalid_payload_before_browser(self):
        for patch in ({"link": "file:///secret"}, {"sessionDir": "../relative"}, {"platform": "../bad"}, {"reason": ""}):
            with self.assertRaises(ValueError):
                validate_input(dict(self.payload, **patch))

    def test_runtime_failure_is_not_submission(self):
        def unavailable(): raise ImportError("missing dependency")
        self.assertEqual(execute(self.payload, manager_factory=unavailable)["state"], "failed")

    def test_captcha_needs_manual_review(self):
        manager = Manager(confirmed=False)
        manager.last_flow_result.error_code.value = "CAPTCHA_REQUIRED"
        self.assertEqual(execute(self.payload, manager_factory=lambda: manager)["state"], "manual_required")

    def test_saves_only_user_scoped_sessions(self):
        context = Mock()
        context.storage_state.side_effect = lambda path: Path(path).write_text("{}")
        manager = Manager()
        manager.contexts = {"weibo": context}
        save_sessions(manager, Path(self.temp.name))
        self.assertTrue((Path(self.temp.name) / "ChromeOptions/weibo_user.json").exists())

    def test_anonymous_receipt_and_manual_timeout(self):
        payload = dict(self.payload, platform="report12377", report12377=dict(category="rumor", websiteName="Example"))
        with patch("playwright.sync_api.sync_playwright") as sync, patch("report_12377.run_browser_flow") as flow:
            browser = sync.return_value.__enter__.return_value.chromium.launch.return_value
            flow.side_effect = lambda page, data, update, heartbeat: update("submitted", "receipt", "test-code")
            result = execute_12377(payload)
            self.assertEqual(result["state"], "done")
            self.assertEqual(result["queryCode"], "test-code")
            browser.close.assert_called_once()
            flow.side_effect = lambda page, data, update, heartbeat: update("manual_expired", "expired")
            self.assertEqual(execute_12377(payload)["state"], "not_submitted")
        with patch("runner.execute_12377", return_value=dict(state="not_submitted")) as anonymous:
            self.assertEqual(execute(payload)["state"], "not_submitted")
            anonymous.assert_called_once()

    def test_login_saves_account_without_reporting(self):
        args = SimpleNamespace(platform="weibo", user_id="123", state_dir=self.temp.name)
        manager = Manager()
        manager.perform_complaint = lambda *a: self.fail("login must not report")
        with patch("runner.create_manager", return_value=manager), patch("builtins.input", return_value=""):
            login(args)
        self.assertTrue(manager.closed)
        with self.assertRaises(ValueError):
            login(SimpleNamespace(platform="bad", user_id="123", state_dir=self.temp.name))

    def test_stdio_protocol_has_only_json(self):
        for value, implementation, expected in (
                ("{}", None, "failed"),
                (json.dumps(self.payload), lambda data: dict(state="done"), "done"),
                (json.dumps(self.payload), Mock(side_effect=RuntimeError("secret")), "unknown")):
            stdout = io.StringIO()
            with patch("sys.argv", ["runner.py"]), patch("sys.stdin", io.StringIO(value)), patch("sys.stdout", stdout):
                if implementation:
                    with patch("runner.execute", side_effect=implementation): main()
                else:
                    main()
            self.assertEqual(json.loads(stdout.getvalue())["state"], expected)


if __name__ == "__main__":
    unittest.main()
