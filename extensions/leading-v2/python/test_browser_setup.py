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
