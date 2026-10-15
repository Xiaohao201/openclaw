"""Operator-bound, per-user access to an existing local browser profile."""
import json
import os
import re
import socket
import sys
from pathlib import Path
from urllib.parse import urlsplit

from network_guard import public_url, configured_fake_ip

BINDING_FILE = "browser-binding.json"


class SharedBrowserUnavailable(RuntimeError):
    pass


def validate_binding(value):
    if isinstance(value, dict) and value.get("version") == 2:
        required = {"version", "driver", "profileDir"}
        if (type(value["version"]) is not int or not required <= set(value)
                or set(value) - required - {"allowRfc2544BenchmarkRange"}
                or value.get("driver") != "existing-session"
                or not isinstance(value.get("profileDir"), str)
                or not Path(value["profileDir"]).is_absolute()
                or not isinstance(value.get("allowRfc2544BenchmarkRange", False), bool)):
            raise ValueError("Invalid existing Chrome binding")
        return value
    required = {"version", "profileDir", "cdpUrl"}
    if (not isinstance(value, dict) or not required <= set(value)
            or set(value) - required - {"allowRfc2544BenchmarkRange"}):
        raise ValueError("Invalid browser binding")
    if not isinstance(value.get("allowRfc2544BenchmarkRange", False), bool):
        raise ValueError("Invalid browser network policy")
    if (type(value["version"]) is not int or value["version"] != 1
            or not isinstance(value["profileDir"], str)
            or not isinstance(value["cdpUrl"], str)):
        raise ValueError("Invalid browser binding version/profile")
    if not Path(value["profileDir"]).is_absolute():
        raise ValueError("Browser profile must be absolute")
    url = urlsplit(value["cdpUrl"])
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1")
            or not url.port or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("CDP must be an explicit loopback HTTP endpoint")
    return value


def read_binding(session_dir):
    target = Path(session_dir) / BINDING_FILE
    if not target.exists():
        return None
    return validate_binding(json.loads(target.read_text(encoding="utf-8")))


def default_chrome_profile_dir():
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise ValueError("LOCALAPPDATA is required to locate Chrome")
        return Path(local) / "Google" / "Chrome" / "User Data"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    return Path.home() / ".config" / "google-chrome"


def existing_chrome_binding(profile_dir=None, *, allow_benchmark=False):
    value = dict(version=2, driver="existing-session",
                 profileDir=str(profile_dir or default_chrome_profile_dir()))
    if allow_benchmark:
        value["allowRfc2544BenchmarkRange"] = True
    return validate_binding(value)


def discover_chrome_endpoint(profile_dir):
    # Chrome writes this only after remote debugging is enabled by its owner.
    # Read it for every lease: Chrome may choose a new port after restarting.
    try:
        with (Path(profile_dir) / "DevToolsActivePort").open(encoding="utf-8") as file:
            lines = [line.strip() for line in file.read(4096).splitlines() if line.strip()]
        if (len(lines) != 2 or not re.fullmatch(r"[0-9]{1,5}", lines[0])
                or not 1 <= int(lines[0]) <= 65535
                or not re.fullmatch(r"/devtools/browser/[A-Za-z0-9_-]+", lines[1])):
            raise ValueError("Invalid Chrome discovery metadata")
        return f"ws://127.0.0.1:{int(lines[0])}{lines[1]}"
    except (OSError, UnicodeError, ValueError) as exc:
        raise SharedBrowserUnavailable(
            "请在已登录的 Chrome 打开 chrome://inspect/#remote-debugging，"
            "启用远程调试并保持浏览器打开；连接时允许 Chrome 的访问提示。"
        ) from exc


def bind_profile(session_dir, profile_dir, cdp_url=None, *, allow_benchmark=False,
                 existing_session=False):
    profile = Path(profile_dir)
    value = (existing_chrome_binding(profile) if existing_session else
             validate_binding(dict(version=1, profileDir=str(profile), cdpUrl=cdp_url)))
    if allow_benchmark:
        value["allowRfc2544BenchmarkRange"] = True
    if not (profile / "Local State").is_file() or not (profile / "Default").is_dir():
        raise ValueError("Expected an existing Chrome profile")
    directory = Path(session_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # An existing binding must be inspected/removed explicitly before changing accounts.
    target = directory / BINDING_FILE
    if target.exists():
        if read_binding(directory) == value:
            return
        raise ValueError("A different browser is already bound to this user")
    with target.open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)


class SharedBrowserLease:
    def __init__(self, playwright, binding, *, headless, attach_only=False):
        binding = validate_binding(binding)
        self.allow_benchmark = binding.get("allowRfc2544BenchmarkRange", False) or configured_fake_ip()
        self.context = None
        self.browser = None
        self.owned_context = False
        self.pages = set()
        self.borrowed_pages = set()
        self.lock = Path(binding["profileDir"]) / ".openclaw-complaint.lock"
        self.lock_owned = False
        self.guard_installed = False
        existing_session = binding.get("driver") == "existing-session"
        # Discover before acquiring a lock so missing setup produces an actionable error.
        endpoint_url = (discover_chrome_endpoint(binding["profileDir"])
                        if existing_session else binding["cdpUrl"])
        try:
            fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise SharedBrowserUnavailable("共享浏览器正被举报任务使用或存在中断锁，请人工核查。") from exc
        self.lock_owned = True
        with os.fdopen(fd, "w") as file:
            file.write(str(os.getpid()))
        try:
            endpoint = urlsplit(endpoint_url)
            connection = None
            if not existing_session:
                try:
                    connection = socket.create_connection((endpoint.hostname, endpoint.port), timeout=2)
                except (ConnectionRefusedError, TimeoutError):
                    # Windows may time out instead of refusing a closed loopback port.
                    # Chrome's profile lock still prevents a second owner of this profile.
                    connection = None
            if connection is not None or existing_session:
                if connection is not None:
                    connection.close()
                self.browser = playwright.chromium.connect_over_cdp(
                    endpoint_url, timeout=60000 if existing_session else 10000)
                if len(self.browser.contexts) != 1:
                    raise SharedBrowserUnavailable("共享浏览器上下文不唯一，请核查绑定的调试端口。")
                self.context = self.browser.contexts[0]
            else:
                if attach_only:
                    raise SharedBrowserUnavailable("会话浏览器已断开，不能启动替代浏览器。")
                self.context = playwright.chromium.launch_persistent_context(
                    binding["profileDir"], channel="chrome", headless=headless,
                    service_workers="block", viewport={"width": 1280, "height": 900},
                    locale="zh-CN", timezone_id="Asia/Shanghai",
                )
                self.owned_context = True
            self.context.route("**/*", self._guard)
            self.guard_installed = True
        except Exception as exc:
            self.close()
            if existing_session:
                raise SharedBrowserUnavailable(
                    "无法连接已登录的 Chrome；请检查远程调试是否开启并允许连接提示。"
                    "未启动其他浏览器或复制登录态。"
                ) from exc
            raise SharedBrowserUnavailable(
                "无法使用共享浏览器；请检查资料目录、Chrome 占用和绑定的调试端口。未回退到其他账号。"
            ) from exc

    def owns_page(self, page):
        while page is not None:
            if page in self.pages:
                return True
            page = page.opener()
        return False

    def _guard(self, route):
        try:
            owned = self.owns_page(route.request.frame.page)
        except Exception:
            owned = self.owned_context
        if owned and not public_url(route.request.url,
                                   allow_rfc2544_benchmark_range=self.allow_benchmark):
            route.abort("blockedbyclient")
        else:
            # Preserve any route installed by the browser owner.
            route.fallback()

    def new_page(self):
        page = self.context.new_page()
        self.pages.add(page)
        return page

    def attach_session_page(self, marker):
        """Locate the exact marked document; never select by URL or tab position."""
        matches = []
        for page in self.context.pages:
            try:
                if page.evaluate("() => window.__openclaw_session_handoff_v1") == marker:
                    matches.append(page)
            except Exception:
                continue
        if len(matches) != 1:
            raise SharedBrowserUnavailable("当前对话标签页已关闭、跳转或身份不唯一，请重新查看页面后再举报。")
        page = matches[0]
        self.pages.add(page)
        self.borrowed_pages.add(page)
        return page

    def close(self):
        try:
            if self.context is not None:
                try:
                    for page in list(self.context.pages):
                        if self.owns_page(page) and page not in self.borrowed_pages:
                            page.close()
                finally:
                    if self.guard_installed:
                        self.context.unroute("**/*", self._guard)
                    if self.owned_context:
                        self.context.close()
        finally:
            if self.lock_owned:
                self.lock.unlink(missing_ok=True)
                self.lock_owned = False
