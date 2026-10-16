import contextlib
import io
import json
import unittest
from unittest.mock import Mock

from log_utils import log_diagnostic


class DiagnosticTest(unittest.TestCase):
    def test_exception_text_is_never_logged(self):
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            log_diagnostic("navigate", TimeoutError("secret URL and password"))
            log_diagnostic("invalid stage secret")
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0].removeprefix("OPENCLAW_DIAGNOSTIC ")),
                         {"stage": "navigate", "errorType": "TimeoutError"})

    def test_douyin_navigation_failure_keeps_the_stage(self):
        from browser_manager import BrowserManager
        manager = BrowserManager.__new__(BrowserManager)
        page = Mock()
        page.goto.side_effect = TimeoutError("secret URL")
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            result = manager._douyin_complaint_flow(page, {"link": "https://example.test"})
        self.assertFalse(result)
        self.assertIn("navigate", manager.submission_diagnostic)
        self.assertIn("TimeoutError", stream.getvalue())
        self.assertNotIn("secret URL", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
