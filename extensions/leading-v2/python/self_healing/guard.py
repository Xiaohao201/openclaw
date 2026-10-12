"""Network hard-stop used by self-healing and live pre-submit validation."""

from fnmatch import fnmatch
from urllib.parse import urlsplit


SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class SafeTestGuard:
    def __init__(self, context, *, allowed_hosts=(), forbidden_globs=()):
        self.context = context
        self.allowed_hosts = {str(host).lower() for host in allowed_hosts if host}
        self.forbidden_globs = tuple(str(item) for item in forbidden_globs)
        self.blocked = []
        self._installed = False

    def _handler(self, route):
        request = route.request
        method = str(request.method or "GET").upper()
        url = str(request.url or "")
        host = (urlsplit(url).hostname or "").lower()
        explicitly_forbidden = any(fnmatch(url, pattern) for pattern in self.forbidden_globs)
        cross_domain = bool(self.allowed_hosts and host not in self.allowed_hosts)
        if method not in SAFE_METHODS or explicitly_forbidden or cross_domain:
            self.blocked.append({"method": method, "url": url})
            route.abort()
        else:
            route.continue_()

    def install(self):
        if not self._installed:
            self.context.route("**/*", self._handler)
            self._installed = True
        return self

    def close(self):
        if self._installed:
            try:
                self.context.unroute("**/*", self._handler)
            finally:
                self._installed = False

    def __enter__(self):
        return self.install()

    def __exit__(self, exc_type, exc, traceback):
        self.close()
