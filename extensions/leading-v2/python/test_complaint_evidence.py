"""Receipt screenshots are bounded artifacts, never a substitute for a receipt."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from complaint_evidence import attach_screenshot, capture_screenshot

PNG = b'\x89PNG\r\n\x1a\n' + b'fixture'


class ComplaintEvidenceTest(unittest.TestCase):
    def test_phone_style_capture_attaches_evidence_without_changing_the_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            result = dict(state='done', message='receipt', offline=None)
            self.assertIs(attach_screenshot(result, lambda: PNG, directory), result)
            self.assertEqual(result['state'], 'done')
            self.assertTrue((Path(directory) / 'screenshots' / result['screenshot']['fileName']).exists())
            failed_capture = Mock(side_effect=OSError('private device error'))
            result = attach_screenshot(dict(state='done'), failed_capture, directory)
            self.assertEqual(result, dict(state='done', evidenceError='SCREENSHOT_CAPTURE_FAILED'))

    def test_captures_a_unique_png_under_the_current_session(self):
        with tempfile.TemporaryDirectory() as directory:
            page = Mock()
            page.screenshot.return_value = PNG
            evidence = capture_screenshot(lambda: page.screenshot(type='png'), directory)
            self.assertRegex(evidence['fileName'], r'^[a-f0-9]{32}\.png$')
            self.assertEqual((Path(directory) / 'screenshots' / evidence['fileName']).read_bytes(), PNG)
            self.assertIn('T', evidence['capturedAt'])

    def test_rejects_invalid_or_oversized_images_without_a_file(self):
        for data in (b'not png', PNG + b'x' * (10 * 1024 * 1024)):
            with self.subTest(size=len(data)), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    capture_screenshot(lambda: data, directory)
                self.assertEqual(list(Path(directory).rglob('*.png')), [])

    def test_exclusive_write_never_deletes_an_existing_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'screenshots' / ('a' * 32 + '.png')
            target.parent.mkdir()
            target.write_bytes(PNG)
            with patch('complaint_evidence.uuid4', return_value=Mock(hex='a' * 32)):
                with self.assertRaises(FileExistsError):
                    capture_screenshot(lambda: PNG, directory)
            self.assertEqual(target.read_bytes(), PNG)

    def test_receipt_is_checked_before_capture_and_capture_failure_preserves_success(self):
        from browser_manager import BrowserManager
        manager = BrowserManager.__new__(BrowserManager)
        manager.submission_attempted = True
        manager.submission_confirmed = False
        manager.result_screenshot = None
        manager.evidence_error = None
        page = Mock()
        events = []
        page.wait_for_selector.side_effect = lambda *a, **k: events.append('receipt')
        page.screenshot.side_effect = lambda **k: events.append('screenshot') or PNG
        with tempfile.TemporaryDirectory() as directory, patch('browser_manager.get_base_path', return_value=directory):
            self.assertTrue(manager._check_submit_success(page, '#receipt'))
            self.assertEqual(events, ['receipt', 'screenshot'])
            self.assertTrue(manager.result_screenshot)
            manager.result_screenshot = None
            page.screenshot.side_effect = OSError('disk full')
            self.assertTrue(manager._check_submit_success(page, '#receipt'))
            self.assertTrue(manager.submission_confirmed)
            self.assertEqual(manager.evidence_error, 'SCREENSHOT_CAPTURE_FAILED')

    def test_runner_returns_capture_metadata_without_leaking_a_local_path(self):
        from runner import execute
        from test_runner import Manager
        manager = Manager()
        manager.result_screenshot = dict(fileName='a' * 32 + '.png', capturedAt='2026-10-16T00:00:00Z')
        with tempfile.TemporaryDirectory() as directory:
            data = dict(platform='weibo', link='https://weibo.com/fixture', reason='fixture',
                        category='fixture', sessionDir=directory)
            result = execute(data, manager_factory=lambda: manager)
        self.assertEqual(result['screenshot'], manager.result_screenshot)
        self.assertNotIn(directory, str(result))
