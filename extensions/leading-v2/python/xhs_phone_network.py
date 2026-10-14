"""Resolve XHS share redirects to public IPs, including a local Fake-IP proxy."""
import http.client
import ipaddress
import json
import socket
import ssl
from urllib.parse import urlsplit

from xhs_phone_ui import PhoneFailure

FAKE_IP_RANGE = ipaddress.ip_network('198.18.0.0/15')


def validate_share_url(url):
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == 'https' and not parsed.username and not parsed.password
                 and not parsed.port and not any(c.isspace() or ord(c) < 32 for c in url)
                 and any(parsed.hostname == host or (parsed.hostname or '').endswith('.' + host)
                         for host in ('xiaohongshu.com', 'xhslink.com', 'xhslink.cn')))
        if valid:
            return parsed
    except ValueError:
        pass
    raise PhoneFailure('分享链接跳转目标不受支持。')


def public_dns_addresses(host, timeout):
    # Only the fixed resolver receives the allowlisted public hostname, never the
    # shared URL or its tokens. Requests keeps TLS verification and honors CA bundles.
    import requests

    with requests.get('https://cloudflare-dns.com/dns-query',
                      params={'name': host, 'type': 'A'},
                      headers={'accept': 'application/dns-json'},
                      timeout=timeout, allow_redirects=False, stream=True) as response:
        if response.status_code != 200:
            raise PhoneFailure('公开 DNS 查询失败，请检查网络。')
        raw = response.raw.read(65537, decode_content=True)
    if len(raw) > 65536:
        raise PhoneFailure('DNS 返回内容过大。')
    data = json.loads(raw)
    if (data.get('Status') != 0 or data.get('TC') or
            data.get('Question') != [{'name': host, 'type': 1}] and
            data.get('Question') != [{'name': host + '.', 'type': 1}]):
        raise PhoneFailure('公开 DNS 未确认目标域名。')
    return [ipaddress.ip_address(answer['data']) for answer in data.get('Answer', [])
            if answer.get('type') == 1]


def resolve_public_addresses(host, timeout):
    addresses = [ipaddress.ip_address(item[4][0]) for item in
                 socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]
    if addresses and all(address in FAKE_IP_RANGE for address in addresses):
        # Do not allow private targets. Replace only known benchmark/Fake-IP answers
        # with public DNS results, then pin the connection to a validated public IP.
        addresses = public_dns_addresses(host, timeout)
    if not addresses or not all(address.is_global for address in addresses):
        raise PhoneFailure('分享链接解析到非公网地址，已停止。')
    return sorted(set(addresses), key=lambda address: (address.version, int(address)))


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        import requests

        super().__init__(host, timeout=timeout,
                         context=ssl.create_default_context(cafile=requests.certs.where()))
        self.address = str(address)

    def connect(self):
        # A second hostname resolution here would reopen a DNS-rebinding window.
        sock = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise


def share_redirect(url, timeout=8):
    parsed = validate_share_url(url)
    address = resolve_public_addresses(parsed.hostname, timeout)[0]
    connection = PublicHTTPSConnection(parsed.hostname, address, timeout)
    try:
        path = parsed.path or '/'
        if parsed.query:
            path += '?' + parsed.query
        connection.request('GET', path, headers={'User-Agent': 'Mozilla/5.0'})
        response = connection.getresponse()
        if response.status not in (301, 302, 303, 307, 308):
            raise PhoneFailure('分享短链接未返回可核验的跳转。')
        location = response.getheader('Location')
        if not location or len(location) > 8192:
            raise PhoneFailure('分享短链接跳转地址无效。')
        return location
    finally:
        connection.close()
