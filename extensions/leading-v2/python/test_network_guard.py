import unittest
from unittest.mock import Mock, patch
from network_guard import public_url, install_network_guard


class NetworkGuardTest(unittest.TestCase):
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
