import os
import queue
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from browser_setup import setup


class BrowserSetupTest(unittest.TestCase):
    def test_isolated_browser_falls_back_without_reusing_a_machine_profile(self):
        from browser_session import launch_isolated_browser
        playwright = Mock()
        playwright.chromium.executable_path = "missing-browser"
        with patch("browser_session.os.path.isfile", return_value=False):
            launch_isolated_browser(playwright, headless=True)
        playwright.chromium.launch.assert_called_once_with(headless=True, args=[], channel="chrome")
        playwright.chromium.launch.reset_mock()
        playwright.chromium.launch.side_effect = [RuntimeError("partial install"), Mock()]
        with patch("browser_session.os.path.isfile", return_value=True):
            launch_isolated_browser(playwright, headless=True)
        self.assertEqual(playwright.chromium.launch.call_count, 2)
        self.assertEqual(playwright.chromium.launch.call_args.kwargs["channel"], "chrome")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.data = dict(platform="weibo", sessionDir=self.temp.name)
        self.data["browserHandoff"] = dict(
            version=1, targetId="7", marker="12345678-1234-1234-1234-123456789abc",
            binding=dict(version=1, cdpUrl="http://127.0.0.1:18800", profileDir=self.temp.name))
        self.manager = Mock()
        self.manager.pages = {"weibo": Mock()}
        self.manager.pages["weibo"].get_by_text.return_value.all.return_value = []
        self.commands = queue.Queue()
        self.events = []

    def test_finish_saves_only_user_confirmed_session_without_reporting(self):
        self.commands.put("finish")
        with patch("runner.save_sessions") as save:
            setup(self.data, self.commands, self.events.append, lambda: self.manager)
            save.assert_called_once_with(self.manager, Path(self.temp.name))
        self.assertEqual(self.events[-1]["state"], "saved")
        self.manager.perform_complaint.assert_not_called()
        self.manager.close_all.assert_called_once()
        self.assertFalse((Path(self.temp.name) / "execution.lock").exists())

    def test_login_passes_the_openclaw_handoff_before_initializing_browser(self):
        self.commands.put("cancel")
        def initialized(platform):
            self.assertEqual(self.manager.browser_handoff, self.data["browserHandoff"])
        self.manager.init_browsers.side_effect = initialized
        setup(self.data, self.commands, self.events.append, lambda: self.manager)

    def test_invalid_or_missing_handoff_never_starts_a_browser(self):
        for handoff in (None, {}, dict(self.data["browserHandoff"], marker="invalid"),
                        dict(self.data["browserHandoff"], binding={}),
                        dict(self.data["browserHandoff"], version=True)):
            with self.subTest(handoff=handoff), self.assertRaises(ValueError):
                setup(dict(self.data, browserHandoff=handoff), self.commands,
                      self.events.append, lambda: self.fail("must not open"))
        self.assertFalse((Path(self.temp.name) / "execution.lock").exists())

    def test_reuses_openclaw_page_and_keeps_browser_and_login_state_on_finish(self):
        from browser_manager import BrowserManager
        import json
        Path(self.temp.name, "browser-binding.json").write_text(
            json.dumps(self.data["browserHandoff"]["binding"]), encoding="utf-8")
        page = self.manager.pages["weibo"]
        page.opener.return_value = None
        page.evaluate.return_value = self.data["browserHandoff"]["marker"]
        context = Mock(pages=[page])
        browser = Mock(contexts=[context])
        playwright = Mock()
        playwright.chromium.connect_over_cdp.return_value = browser
        self.commands.put("finish")
        with patch("browser_manager.sync_playwright") as sync, patch("shared_browser.socket.create_connection"):
            sync.return_value.start.return_value = playwright
            setup(self.data, self.commands, self.events.append, BrowserManager)
        playwright.chromium.connect_over_cdp.assert_called_once_with("http://127.0.0.1:18800", timeout=10000)
        playwright.chromium.launch.assert_not_called()
        playwright.chromium.launch_persistent_context.assert_not_called()
        context.new_page.assert_not_called()
        context.storage_state.assert_not_called()
        context.close.assert_not_called()
        browser.close.assert_not_called()
        page.close.assert_not_called()
        page.goto.assert_called_once()
        self.assertEqual(self.events[-1]["state"], "saved")

    def test_disconnected_browser_never_launches_another_window(self):
        from browser_manager import BrowserManager
        from shared_browser import SharedBrowserUnavailable
        import json
        Path(self.temp.name, "browser-binding.json").write_text(
            json.dumps(self.data["browserHandoff"]["binding"]), encoding="utf-8")
        playwright = Mock()
        with patch("browser_manager.sync_playwright") as sync, \
                patch("shared_browser.socket.create_connection", side_effect=ConnectionRefusedError):
            sync.return_value.start.return_value = playwright
            with self.assertRaises(SharedBrowserUnavailable):
                setup(self.data, self.commands, self.events.append, BrowserManager)
        playwright.chromium.launch.assert_not_called()
        playwright.chromium.launch_persistent_context.assert_not_called()
        self.assertFalse((Path(self.temp.name) / "execution.lock").exists())
        self.assertFalse((Path(self.temp.name) / ".openclaw-complaint.lock").exists())

    def test_cancel_never_saves_or_submits(self):
        self.commands.put("cancel")
        with patch("runner.save_sessions") as save:
            setup(self.data, self.commands, self.events.append, lambda: self.manager)
            save.assert_not_called()
        self.assertEqual(self.events[-1]["state"], "cancelled")
        self.manager.perform_complaint.assert_not_called()

    def test_existing_execution_lock_is_preserved(self):
        lock = Path(self.temp.name) / "execution.lock"
        lock.write_text("other-process")
        setup(self.data, self.commands, self.events.append, lambda: self.fail("must not open"))
        self.assertEqual(self.events[-1]["state"], "busy")
        self.assertEqual(lock.read_text(), "other-process")

    def test_removed_platforms_and_12377_have_no_login_workflow(self):
        for platform in ("wechat", "xueqiu", "tonghuashun", "report12377"):
            with self.assertRaises(ValueError):
                setup(dict(self.data, platform=platform), self.commands, self.events.append)
