import tempfile
import os
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from shared_browser import (BINDING_FILE, SharedBrowserLease, SharedBrowserUnavailable,
                            bind_profile, read_binding, validate_binding,
                            existing_chrome_binding, discover_chrome_endpoint)


class SharedBrowserTest(unittest.TestCase):
    def test_handoff_borrows_exact_marked_page_and_preserves_it_on_close(self):
        page, other = Mock(), Mock()
        # Root tabs have no opener; a bare Mock creates an endless parent chain.
        page.opener.return_value = other.opener.return_value = None
        page.evaluate.return_value = "marker"
        other.evaluate.return_value = None
        self.context.pages = [other, page]
        with patch("shared_browser.socket.create_connection", return_value=Mock()):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True, attach_only=True)
        self.assertIs(lease.attach_session_page("marker"), page)
        lease.close()
        page.close.assert_not_called()
        other.close.assert_not_called()
        self.context.close.assert_not_called()

    def test_handoff_rejects_missing_or_ambiguous_page_without_creating_a_tab(self):
        with patch("shared_browser.socket.create_connection", return_value=Mock()):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True, attach_only=True)
        try:
            with self.assertRaises(SharedBrowserUnavailable):
                lease.attach_session_page("marker")
            first, second = Mock(), Mock()
            first.opener.return_value = second.opener.return_value = None
            first.evaluate.return_value = second.evaluate.return_value = "marker"
            self.context.pages = [first, second]
            with self.assertRaises(SharedBrowserUnavailable):
                lease.attach_session_page("marker")
            self.context.new_page.assert_not_called()
        finally:
            lease.close()

    def test_handoff_never_launches_replacement_browser(self):
        with patch("shared_browser.socket.create_connection", side_effect=ConnectionRefusedError):
            with self.assertRaises(SharedBrowserUnavailable):
                SharedBrowserLease(self.playwright, self.binding, headless=True, attach_only=True)
        self.playwright.chromium.launch_persistent_context.assert_not_called()

    def test_shared_browser_inherits_host_fake_ip_without_changing_binding(self):
        with patch.dict(os.environ, {"OPENCLAW_COMPLAINT_ALLOW_FAKE_IP": "1"}), patch("shared_browser.socket.create_connection", side_effect=ConnectionRefusedError):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True)
            self.assertTrue(lease.allow_benchmark)
            self.assertNotIn("allowRfc2544BenchmarkRange", self.binding)
            lease.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = self.root / "profile"
        self.profile.mkdir()
        (self.profile / "Default").mkdir()
        (self.profile / "Local State").write_text("{}")
        self.binding = dict(version=1, profileDir=str(self.profile),
                            cdpUrl="http://127.0.0.1:18800")
        self.playwright = Mock()
        self.context = Mock()
        self.context.pages = []
        self.playwright.chromium.launch_persistent_context.return_value = self.context
        self.browser = Mock(contexts=[self.context])
        self.playwright.chromium.connect_over_cdp.return_value = self.browser

    def test_binding_is_explicit_per_user_and_idempotent(self):
        first, second = self.root / "user-a", self.root / "user-b"
        self.assertIsNone(read_binding(first))
        bind_profile(first, str(self.profile), self.binding['cdpUrl'])
        bind_profile(first, str(self.profile), self.binding['cdpUrl'])
        self.assertEqual(read_binding(first), self.binding)
        self.assertIsNone(read_binding(second))
        with self.assertRaises(ValueError):
            bind_profile(first, str(self.profile), "http://127.0.0.1:18801")

    def test_invalid_binding_fails_closed(self):
        for endpoint in ['https://127.0.0.1:18800', 'http://example.com:18800',
                         'http://user@127.0.0.1:18800', 'http://127.0.0.1:18800/path']:
            with self.assertRaises(ValueError):
                validate_binding(dict(self.binding, cdpUrl=endpoint))
        (self.root / BINDING_FILE).write_text('{"version":2}')
        with self.assertRaises(ValueError):
            read_binding(self.root)

    def test_existing_session_discovers_new_port_after_restart(self):
        binding = existing_chrome_binding(self.profile)
        bind_profile(self.root / 'operator', self.profile, existing_session=True)
        self.assertEqual(read_binding(self.root / 'operator'), binding)
        discovery = self.profile / 'DevToolsActivePort'
        for port in [9222, 9333]:
            discovery.write_text(f'{port}\n/devtools/browser/test-id\n')
            with patch('shared_browser.socket.create_connection'):
                lease = SharedBrowserLease(self.playwright, binding, headless=True)
            self.playwright.chromium.connect_over_cdp.assert_called_with(
                f'ws://127.0.0.1:{port}/devtools/browser/test-id', timeout=60000)
            lease.close()
        self.playwright.chromium.launch_persistent_context.assert_not_called()
        self.context.close.assert_not_called()

    def test_existing_session_never_launches_another_browser(self):
        binding = existing_chrome_binding(self.profile)
        with self.assertRaises(SharedBrowserUnavailable):
            SharedBrowserLease(self.playwright, binding, headless=True)
        (self.profile / 'DevToolsActivePort').write_text('9222\n/devtools/browser/stale')
        self.playwright.chromium.connect_over_cdp.side_effect = RuntimeError('denied')
        with patch('shared_browser.socket.create_connection', side_effect=ConnectionRefusedError):
            with self.assertRaises(SharedBrowserUnavailable):
                SharedBrowserLease(self.playwright, binding, headless=True)
        self.playwright.chromium.launch_persistent_context.assert_not_called()
        self.assertFalse((self.profile / '.openclaw-complaint.lock').exists())

    def test_discovery_rejects_malformed_or_remote_endpoints(self):
        for content in ['0\n/devtools/browser/id', '65536\n/devtools/browser/id',
                        '9222junk\n/devtools/browser/id', '9222\n//remote.example/path',
                        '9222\n/devtools/browser/id?secret=x', '9222',
                        '9222\n/devtools/browser/id\nextra']:
            with self.subTest(content=content):
                (self.profile / 'DevToolsActivePort').write_text(content)
                with self.assertRaises(SharedBrowserUnavailable):
                    discover_chrome_endpoint(self.profile)
        for update in [dict(driver='other'), dict(cdpUrl='http://127.0.0.1:9222'),
                       dict(profileDir='relative'), dict(allowRfc2544BenchmarkRange='yes')]:
            with self.assertRaises(ValueError):
                validate_binding(dict(existing_chrome_binding(self.profile), **update))

    def test_running_browser_is_attached_and_user_tabs_survive(self):
        original = Mock()
        original.opener.return_value = None
        work = Mock()
        popup = Mock()
        popup.opener.return_value = work
        self.context.new_page.return_value = work
        with patch('shared_browser.socket.create_connection'):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True)
        lease.new_page()
        self.context.pages = [original, work, popup]
        lease.close()
        work.close.assert_called_once()
        popup.close.assert_called_once()
        original.close.assert_not_called()
        self.context.close.assert_not_called()
        self.browser.close.assert_not_called()
        self.context.unroute.assert_called_once()
        self.assertFalse(lease.lock.exists())

    def test_offline_browser_uses_exact_same_profile_without_state_export(self):
        with patch('shared_browser.socket.create_connection', side_effect=ConnectionRefusedError):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True)
        args, kwargs = self.playwright.chromium.launch_persistent_context.call_args
        self.assertEqual(args[0], str(self.profile))
        self.assertEqual(kwargs['channel'], 'chrome')
        from runner import save_sessions
        save_sessions(Mock(shared_browser=lease), self.root / 'user')
        self.context.storage_state.assert_not_called()
        lease.close()
        self.context.close.assert_called_once()

    def test_busy_lock_does_not_launch_or_remove_someone_elses_lock(self):
        lock = self.profile / '.openclaw-complaint.lock'
        lock.write_text('other process')
        with self.assertRaises(SharedBrowserUnavailable):
            SharedBrowserLease(self.playwright, self.binding, headless=True)
        self.assertEqual(lock.read_text(), 'other process')
        self.playwright.chromium.launch_persistent_context.assert_not_called()

    def test_live_endpoint_error_never_falls_back_to_new_browser(self):
        self.playwright.chromium.connect_over_cdp.side_effect = RuntimeError('bad endpoint')
        with patch('shared_browser.socket.create_connection'), self.assertRaises(SharedBrowserUnavailable):
            SharedBrowserLease(self.playwright, self.binding, headless=True)
        self.playwright.chromium.launch_persistent_context.assert_not_called()
        self.assertFalse((self.profile / '.openclaw-complaint.lock').exists())

    def test_guard_blocks_private_requests_only_for_owned_pages(self):
        with patch('shared_browser.socket.create_connection'):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True)
        page = lease.new_page()
        route = Mock()
        route.request.frame.page = page
        route.request.url = 'http://127.0.0.1/private'
        with patch('shared_browser.public_url', return_value=False):
            lease._guard(route)
        route.abort.assert_called_once_with('blockedbyclient')
        route.fallback.assert_not_called()
        original = Mock()
        original.opener.return_value = None
        route = Mock()
        route.request.frame.page = original
        lease._guard(route)
        route.fallback.assert_called_once()
        lease.close()

    def test_fake_ip_opt_in_does_not_allow_other_private_addresses(self):
        from network_guard import public_url
        def resolver(*args, **kwargs):
            return [(2, 1, 6, '', ('198.18.1.2', 443))]
        self.assertFalse(public_url('https://example.test/', resolver))
        self.assertTrue(public_url('https://example.test/', resolver,
                                   allow_rfc2544_benchmark_range=True))
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1']:
            with self.subTest(address=address):
                def private_resolver(*args, **kwargs):
                    return [(2, 1, 6, '', (address, 443))]
                self.assertFalse(public_url('https://example.test/', private_resolver,
                                            allow_rfc2544_benchmark_range=True))

    def test_windows_closed_port_timeout_uses_profile_lock(self):
        with patch('shared_browser.socket.create_connection', side_effect=TimeoutError):
            lease = SharedBrowserLease(self.playwright, self.binding, headless=True)
        self.assertTrue(lease.owned_context)
        lease.close()

    def test_manager_and_runner_use_binding_without_copying_credentials(self):
        from browser_manager import BrowserManager
        from runner import execute
        user = self.root / 'user'
        bind_profile(user, str(self.profile), self.binding['cdpUrl'])
        page = Mock()
        self.context.new_page.return_value = page
        with patch.dict(os.environ, {'OPENCLAW_COMPLAINT_SESSION_DIR': str(user)}), \
                patch('browser_manager.sync_playwright') as sync, \
                patch('shared_browser.socket.create_connection'):
            sync.return_value.start.return_value = self.playwright
            manager = BrowserManager()
            manager.check_login_status = Mock(return_value=False)
            manager.perform_complaint = Mock()
            result = execute(dict(platform='weibo', link='https://weibo.com/example',
                                  sessionDir=str(user), reason='test', category='test'),
                             manager_factory=lambda: manager)
        self.assertEqual(result['state'], 'manual_required')
        self.assertIn('共享浏览器', result['message'])
        manager.perform_complaint.assert_not_called()
        self.context.storage_state.assert_not_called()
        self.browser.close.assert_not_called()
        self.assertFalse((user / 'ChromeOptions').exists())


if __name__ == '__main__':
    unittest.main()
