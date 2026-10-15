import unittest
import os
from unittest.mock import Mock, patch
from network_guard import public_url, install_network_guard


class NetworkGuardTest(unittest.TestCase):
    def test_fake_ip_policy_does_not_allow_other_private_networks(self):
        for address, expected in (("198.18.0.1", True), ("198.19.255.254", True), ("127.0.0.1", False), ("10.0.0.1", False), ("169.254.169.254", False), ("192.168.1.1", False)):
            resolver = lambda *a, **k: [(None, None, None, None, (address, 443))]
            self.assertFalse(public_url("https://example.test", resolver))
            self.assertEqual(public_url("https://example.test", resolver, allow_rfc2544_benchmark_range=True), expected)

    def test_all_isolated_context_guards_inherit_only_explicit_host_policy(self):
        context = Mock()
        install_network_guard(context)
        callback = context.route.call_args.args[1]
        route = Mock()
        route.request.url = "https://example.test"
        for value, allowed in (("1", True), ("0", False), ("true", False)):
            with patch.dict(os.environ, {"OPENCLAW_COMPLAINT_ALLOW_FAKE_IP": value}), patch("network_guard.public_url", return_value=True) as guard:
                callback(route)
                guard.assert_called_once_with("https://example.test", allow_rfc2544_benchmark_range=allowed)

    def test_rejects_private_destinations_and_credentials(self):
        def private(*args, **kwargs): return [(None, None, None, None, ("127.0.0.1", 80))]
        def public(*args, **kwargs): return [(None, None, None, None, ("8.8.8.8", 443))]
        self.assertFalse(public_url("http://example.test/", private))
        self.assertFalse(public_url("file:///tmp/test", public))
        self.assertFalse(public_url("https://user:secret@example.test/", public))
        self.assertTrue(public_url("https://example.test/", public))
        self.assertFalse(public_url("https://example.test/", lambda *a, **k: []))
        self.assertFalse(public_url("https://example.test/", Mock(side_effect=OSError("DNS"))))

    def test_guards_all_context_requests(self):
        context = Mock()
        install_network_guard(context)
        pattern, callback = context.route.call_args.args
        self.assertEqual(pattern, "**/*")
        route = Mock()
        with patch("network_guard.public_url", return_value=False): callback(route)
        route.abort.assert_called_once()
        with patch("network_guard.public_url", return_value=True): callback(route)
        route.continue_.assert_called_once()
