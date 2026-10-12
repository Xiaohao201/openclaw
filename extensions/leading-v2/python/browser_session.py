# -*- coding: utf-8 -*-
"""浏览器会话配置：为高风控平台提供稳定、可人工登录的资料目录。"""

import json
import os


PERSISTENT_CONTEXT_PLATFORMS = frozenset({"tonghuashun", "xueqiu"})
PERSISTENT_BROWSER_LAUNCH_ARGS = (
    "--log-level=3",
    "--disable-logging",
)
SHARED_BROWSER_LAUNCH_ARGS = (
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-features=VizDisplayCompositor",
    "--log-level=3",
    "--disable-logging",
)
LEGACY_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

_COOKIE_FIELDS = frozenset({
    "name",
    "value",
    "domain",
    "path",
    "expires",
    "httpOnly",
    "secure",
    "sameSite",
})


def context_options(platform=""):
    """高风控平台使用真实 UA；其他平台保持原配置，避免扩大登录影响。"""
    options = {
        "service_workers": "block",
        "viewport": {"width": 1280, "height": 720},
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
    }
    if not uses_persistent_context(platform):
        options["user_agent"] = LEGACY_USER_AGENT
    return options


def uses_persistent_context(platform):
    return str(platform or "").lower() in PERSISTENT_CONTEXT_PLATFORMS


def persistent_profile_dir(base_path, platform):
    safe_platform = str(platform or "").strip().lower()
    return os.path.join(base_path, "ChromeOptions", f"{safe_platform}_profile")


def legacy_storage_state_path(base_path, platform):
    safe_platform = str(platform or "").strip().lower()
    return os.path.join(base_path, "ChromeOptions", f"{safe_platform}_user.json")


def load_legacy_cookies(storage_state_path):
    """读取旧 storage_state 中可被 Playwright 接受的 cookie 字段。"""
    try:
        with open(storage_state_path, "r", encoding="utf-8") as state_file:
            payload = json.load(state_file)
    except (OSError, TypeError, ValueError):
        return []

    cookies = payload.get("cookies", []) if isinstance(payload, dict) else []
    if not isinstance(cookies, list):
        return []

    result = []
    for raw_cookie in cookies:
        if not isinstance(raw_cookie, dict):
            continue
        cookie = {
            key: value for key, value in raw_cookie.items()
            if key in _COOKIE_FIELDS
        }
        if all(cookie.get(key) for key in ("name", "value", "domain", "path")):
            result.append(cookie)
    return result


def launch_persistent_platform_context(
        playwright, base_path, platform, *, headless):
    """启动高风控平台的持久化上下文，并只补回资料中缺失的旧 cookie。"""
    if not uses_persistent_context(platform):
        raise ValueError(f"平台不使用持久化上下文: {platform}")

    profile_dir = persistent_profile_dir(base_path, platform)
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=profile_dir,
        headless=headless,
        args=list(PERSISTENT_BROWSER_LAUNCH_ARGS),
        **context_options(platform),
    )
    legacy_cookies = load_legacy_cookies(
        legacy_storage_state_path(base_path, platform))
    existing_cookie_keys = {
        (cookie.get("name"), cookie.get("domain"), cookie.get("path"))
        for cookie in context.cookies()
    }
    missing_cookies = [
        cookie for cookie in legacy_cookies
        if (cookie.get("name"), cookie.get("domain"), cookie.get("path"))
        not in existing_cookie_keys
    ]
    if missing_cookies:
        context.add_cookies(missing_cookies)
    return context, len(missing_cookies)
