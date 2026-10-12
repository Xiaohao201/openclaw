"""One direct browser operation per process, with no database or MQ dependency."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit


def outcome(state, message, code="NONE"):
    return dict(state=state, message=message, errorCode=code, offline=None)


def validate_input(data):
    from config import ALL_PLATFORMS
    if not isinstance(data, dict) or data.get("platform") not in ALL_PLATFORMS:
        raise ValueError("Unsupported platform")
    url = urlsplit(data.get("link", ""))
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.port not in (None, 80, 443):
        raise ValueError("Invalid URL")
    if not isinstance(data.get("sessionDir"), str) or not Path(data["sessionDir"]).is_absolute():
        raise ValueError("Invalid session directory")
    for key in ("reason", "category"):
        if not isinstance(data.get(key), str) or not data[key].strip() or len(data[key]) > 6000:
            raise ValueError("Invalid reason/category")
    phone = data.get("phone")
    if phone is not None:
        if not isinstance(phone, dict) or set(phone) - {"serial", "userId", "adbPath"}:
            raise ValueError("Invalid phone configuration")
        for key in ("serial", "userId"):
            if not isinstance(phone.get(key), str) or not 1 <= len(phone[key]) <= 200:
                raise ValueError("Invalid phone binding")
        if "adbPath" in phone and (not isinstance(phone["adbPath"], str) or not phone["adbPath"]):
            raise ValueError("Invalid ADB executable")
    return data


def create_manager():
    from browser_manager import BrowserManager
    return BrowserManager()


def save_sessions(manager, directory):
    import browser_session
    for platform, context in manager.contexts.items():
        target = Path(browser_session.legacy_storage_state_path(str(directory), platform))
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        context.storage_state(path=str(target))
        target.chmod(0o600)


def execute_12377(data):
    from playwright.sync_api import sync_playwright
    from report_12377 import run_browser_flow, validate_payload
    selection = data.get("report12377") or {}
    payload = validate_payload(dict(mode="anonymous", category=selection.get("category"),
                                    websiteName=selection.get("websiteName"),
                                    url=data["link"], description=data["reason"]))
    result = outcome("unknown", "12377尚未返回可验证回执，禁止自动重投。")

    def update(state, message, code=""):
        nonlocal result
        mapped = {"submitted": "done", "failed": "failed", "manual_expired": "not_submitted",
                  "awaiting_manual": "manual_required", "submitting": "unknown", "unknown": "unknown"}
        result = outcome(mapped[state], message)
        if code:
            result["queryCode"] = code

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        try:
            from network_guard import install_network_guard
            context = browser.new_context(service_workers="block")
            install_network_guard(context)
            page = context.new_page()
            run_browser_flow(page, payload, update, lambda: None)
        finally:
            browser.close()
    return result


def execute(data, manager_factory=create_manager):
    validate_input(data)
    directory = Path(data["sessionDir"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / "execution.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return outcome("manual_required", "该用户浏览器正在使用或存在中断锁；请核查进程及旧批次后处理，不会自动重试。", "SESSION_LOCKED")
    with os.fdopen(fd, "w") as file:
        file.write(str(os.getpid()))
    os.environ["OPENCLAW_COMPLAINT_SESSION_DIR"] = str(directory)
    os.environ["OPENCLAW_COMPLAINT_HEADLESS"] = "1" if data.get("headless") else "0"
    # config can already be imported by validation; update only non-secret runtime state.
    import config
    config.HEADLESS = bool(data.get("headless"))
    manager = None
    execution_started = False
    try:
        if data["platform"] == "report12377":
            execution_started = True
            return execute_12377(data)
        manager = manager_factory()
        manager.init_browsers(data["platform"])
        if data["platform"] == "xiaohongshu":
            from xhs_phone import mobile_only_target, execute_phone
            page = manager.pages["xiaohongshu"]
            page.goto(data["link"], wait_until="domcontentloaded")
            target = mobile_only_target(page)
            if target:
                execution_started = True
                return execute_phone(data, target)
        if not manager.check_login_status(data["platform"]):
            return outcome("manual_required", "当前用户尚未登录平台。请使用 runner.py --login 为此用户建立独立登录态。", "LOGIN_REQUIRED")
        execution_started = True
        manager.perform_complaint(data["platform"], dict(data, id=os.getpid()))
        # Legacy handlers may return True even when the success marker is absent.
        if manager.submission_confirmed:
            return outcome("done", "已观察到平台提交成功提示；不代表已受理或处置。")
        if data["platform"] == "xiaohongshu" and getattr(manager, "mobile_only_url", None):
            from xhs_phone import execute_phone
            return execute_phone(data, manager.mobile_only_url)
        code = manager.last_flow_result.error_code.value
        if code in ("LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "MATERIAL_REQUIRED"):
            return outcome("manual_required", "执行遇到登录、验证或材料要求，需要人工核查后处理。", code)
        return outcome("unknown", "未观察到平台提交成功提示，不能确认结果；请人工核对，勿自动重提。", code)
    except Exception:
        return outcome("unknown" if execution_started else "failed",
                       "执行结果无法确认，禁止自动重提。" if execution_started else "浏览器启动失败，请检查 Python 依赖及 Chromium 安装。",
                       "EXECUTION_INTERRUPTED" if execution_started else "RUNTIME_UNAVAILABLE")
    finally:
        if manager is not None:
            try:
                save_sessions(manager, directory)
            except Exception:
                pass  # Session persistence must not erase a confirmed submission.
            manager.close_all()
        lock.unlink(missing_ok=True)


def login(args):
    from config import ALL_PLATFORMS
    if args.platform not in ALL_PLATFORMS or not args.user_id or not args.state_dir:
        raise ValueError("--platform, --user-id and --state-dir are required")
    directory = Path(args.state_dir).resolve() / "leading-v2-complaint-sessions" / hashlib.sha256(args.user_id.encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / "execution.lock"
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    os.environ["OPENCLAW_COMPLAINT_SESSION_DIR"] = str(directory)
    os.environ["OPENCLAW_COMPLAINT_HEADLESS"] = "0"
    manager = None
    try:
        manager = create_manager()
        manager.init_browsers(args.platform)
        manager.check_login_status(args.platform)
        input("请在浏览器完成登录，完成后回到终端按 Enter 保存（不会提交举报）：")
        save_sessions(manager, directory)
    finally:
        if manager is not None:
            manager.close_all()
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--platform")
    parser.add_argument("--user-id")
    parser.add_argument("--state-dir")
    args = parser.parse_args()
    if args.login:
        login(args)
        return
    try:
        data = json.loads(sys.stdin.read(1048576))
        # Browser libraries print diagnostics; stdout is exclusively one JSON result.
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(data)
    except (ValueError, TypeError, KeyError):
        result = outcome("failed", "执行器输入无效，未执行举报。", "INVALID_INPUT")
    except Exception:
        result = outcome("unknown", "执行器异常，结果需人工核查。", "EXECUTION_INTERRUPTED")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
