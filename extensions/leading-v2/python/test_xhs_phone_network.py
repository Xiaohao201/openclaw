import ipaddress
import unittest
from unittest.mock import Mock, patch

from xhs_phone_network import (PublicHTTPSConnection, resolve_public_addresses,
                               share_redirect, validate_share_url)
from xhs_phone_ui import PhoneFailure


def address_info(*addresses):
    return [(2, 1, 6, '', (address, 443)) for address in addresses]


class ShareNetworkTests(unittest.TestCase):
    def test_allowlist_rejects_credentials_ports_and_foreign_redirects(self):
        for url in ('https://xhslink.com.evil.test/x', 'https://127.0.0.1/x',
                    'https://user@xhslink.com/x', 'https://xhslink.com:444/x',
                    'http://xhslink.com/x', 'https://xhslink.com/x\r\nHeader: value'):
            with self.assertRaises(PhoneFailure):
                validate_share_url(url)

    def test_fake_ip_is_replaced_with_verified_public_addresses(self):
        with patch('xhs_phone_network.socket.getaddrinfo', return_value=address_info('198.18.1.2')), \
                patch('xhs_phone_network.public_dns_addresses', return_value=[ipaddress.ip_address('8.8.8.8')]) as dns:
            self.assertEqual(resolve_public_addresses('xhslink.com', 8), [ipaddress.ip_address('8.8.8.8')])
            dns.assert_called_once_with('xhslink.com', 8)

    def test_private_or_mixed_addresses_never_enable_public_dns_fallback(self):
        for addresses in [('127.0.0.1',), ('10.0.0.1',), ('198.18.1.2', '10.0.0.1'), ()]:
            with patch('xhs_phone_network.socket.getaddrinfo', return_value=address_info(*addresses)), \
                    patch('xhs_phone_network.public_dns_addresses') as dns:
                with self.assertRaises(PhoneFailure):
                    resolve_public_addresses('xhslink.com', 8)
                dns.assert_not_called()

    def test_private_public_dns_answer_is_also_rejected(self):
        with patch('xhs_phone_network.socket.getaddrinfo', return_value=address_info('198.18.1.2')), \
                patch('xhs_phone_network.public_dns_addresses', return_value=[ipaddress.ip_address('10.0.0.1')]):
            with self.assertRaises(PhoneFailure):
                resolve_public_addresses('xhslink.com', 8)

    def test_connection_dials_validated_ip_and_retains_hostname_for_tls(self):
        # Bypass only construction: the actual connect implementation must not resolve host again.
        connection = PublicHTTPSConnection.__new__(PublicHTTPSConnection)
        connection.address, connection.host, connection.timeout = '8.8.8.8', 'xhslink.com', 8
        connection._context = Mock()
        with patch('xhs_phone_network.socket.create_connection') as connect:
            connection.connect()
            connect.assert_called_once_with(('8.8.8.8', 443), 8)
            connection._context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='xhslink.com')

    def test_redirect_reader_closes_connection_without_reading_page_body(self):
        with patch('xhs_phone_network.resolve_public_addresses', return_value=['8.8.8.8']), \
                patch('xhs_phone_network.PublicHTTPSConnection') as factory:
            connection = factory.return_value
            response = connection.getresponse.return_value
            response.status = 302
            response.getheader.return_value = 'https://www.xiaohongshu.com/explore/' + 'a' * 24
            self.assertIn('/explore/', share_redirect('https://xhslink.com/a/test'))
            response.read.assert_not_called()
            connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
