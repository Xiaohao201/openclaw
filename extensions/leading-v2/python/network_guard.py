"""Reject browser requests to private/loopback destinations, including redirects."""
import ipaddress
import os
import socket
from urllib.parse import urlsplit


def public_url(url, resolver=socket.getaddrinfo, *, allow_rfc2544_benchmark_range=False):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return False
        addresses = resolver(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        benchmark = ipaddress.ip_network("198.18.0.0/15")
        return bool(addresses) and all(
            ipaddress.ip_address(item[4][0]).is_global or (
                allow_rfc2544_benchmark_range and
                ipaddress.ip_address(item[4][0]) in benchmark)
            for item in addresses)
    except (ValueError, OSError):
        return False


def configured_fake_ip():
    # Set by the host from its explicit RFC2544 policy, never from tool arguments.
    return os.environ.get("OPENCLAW_COMPLAINT_ALLOW_FAKE_IP") == "1"


def install_network_guard(context):
    # Route interception applies to redirects and child frames. Browser DNS/network
    # isolation still needs the deployment's egress firewall to prevent DNS rebinding.
    def guard(route):
        if public_url(route.request.url, allow_rfc2544_benchmark_range=configured_fake_ip()):
            route.continue_()
        else:
            route.abort("blockedbyclient")
    context.route("**/*", guard)
