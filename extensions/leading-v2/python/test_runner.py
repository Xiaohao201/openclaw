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
    def test_handoff_login_probe_preserves_inherited_page_for_submission(self):
        manager = Manager()
        original, probe = Mock(), Mock()
        manager.pages = {'weibo': original}
        manager.shared_browser = Mock()
        manager.shared_browser.new_page.return_value = probe
        def check(platform):
            self.assertIs(manager.pages[platform], probe)
            return True
        manager.check_login_status = check
        manager.perform_complaint = lambda platform, data: self.assertIs(manager.pages[platform], original)
        data = dict(self.payload, browserHandoff=dict(version=1, targetId='7',
                    marker='12345678-1234-1234-1234-123456789abc',
                    binding=dict(version=2, driver='existing-session', profileDir=self.temp.name)))
        self.assertEqual(execute(data, manager_factory=lambda: manager)['state'], 'done')
        probe.close.assert_called_once()
        original.close.assert_not_called()
        self.assertTrue(manager.closed)

    def test_douyin_requires_visible_account_avatar_and_no_login_prompt(self):
        from browser_manager import BrowserManager, PlaywrightTimeoutError
        for avatar_visible, login_visible, expected in ((True, False, True),
                                                        (False, False, False),
                                                        (True, True, False)):
            with self.subTest(avatar=avatar_visible, login=login_visible):
                manager = BrowserManager.__new__(BrowserManager)
                manager.check_browser_status = Mock()
                manager.login_status_errors = {}
                manager.shared_browser = Mock()
                page = Mock()
                manager.pages = {'douyin': page}
                manager.contexts = {'douyin': Mock()}
                avatar = page.locator.return_value.first
                avatar.is_visible.return_value = avatar_visible
                if not avatar_visible:
                    avatar.wait_for.side_effect = PlaywrightTimeoutError('no avatar')
                login = Mock()
                login.is_visible.return_value = login_visible
                page.get_by_text.return_value.all.return_value = [login]
                self.assertEqual(manager.check_login_status('douyin'), expected)
                page.goto.assert_called_once_with('https://www.douyin.com/',
                                                 wait_until='domcontentloaded', timeout=30000)

    def test_unavailable_direct_platforms_are_rejected(self):
        for platform, link in (("wechat", "https://mp.weixin.qq.com/s/1"),
                               ("tonghuashun", "https://www.10jqka.com.cn/1"),
                               ("xueqiu", "https://xueqiu.com/1"),
                               ("tencent", "https://mp.weixin.qq.com/s/1")):
            with self.subTest(platform=platform), self.assertRaises(ValueError):
                validate_input(dict(self.payload, platform=platform, link=link))

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

    def test_login_check_error_is_not_reported_as_logged_out(self):
        manager = Manager(login=False)
        manager.login_status_message = lambda platform: "navigation timeout"
        manager.perform_complaint = lambda *args: self.fail("must not submit")
        result = execute(self.payload, manager_factory=lambda: manager)
        self.assertEqual(result["errorCode"], "LOGIN_CHECK_FAILED")

    def test_login_does_not_claim_success_after_enter_without_authentication(self):
        args = SimpleNamespace(platform="weibo", user_id="123", state_dir=self.temp.name)
        manager = Manager(login=False)
        with patch("runner.create_manager", return_value=manager), patch("builtins.input", return_value=""), patch("runner.save_sessions") as save:
            with self.assertRaises(RuntimeError):
                login(args)
            save.assert_not_called()
        self.assertTrue(manager.closed)

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

    def test_12377_context_uses_host_network_policy(self):
        import os
        from network_guard import public_url
        payload = dict(self.payload, platform="report12377", report12377=dict(category="rumor", websiteName="Example"))
        with patch.dict(os.environ, {"OPENCLAW_COMPLAINT_ALLOW_FAKE_IP": "1"}), patch("playwright.sync_api.sync_playwright") as sync, patch("report_12377.run_browser_flow"):
            context = sync.return_value.__enter__.return_value.chromium.launch.return_value.new_context.return_value
            execute_12377(payload)
            callback = context.route.call_args.args[1]
            route = Mock()
            route.request.url = "https://www.12377.cn/"
            resolver = lambda *a, **k: [(None, None, None, None, ("198.18.0.35", 443))]
            with patch("network_guard.public_url", side_effect=lambda url, **kw: public_url(url, resolver, **kw)):
                callback(route)
            route.continue_.assert_called_once()
            route.abort.assert_not_called()

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
