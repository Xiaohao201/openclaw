"""One direct browser operation per process, with no database or MQ dependency."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from shared_browser import SharedBrowserUnavailable, validate_handoff
from runtime_diagnostics import check_runtime, runtime_failure


def outcome(state, message, code="NONE"):
    return dict(state=state, message=message, errorCode=code, offline=None)


def validate_input(data):
    from config import ALL_PLATFORMS
    if not isinstance(data, dict) or data.get("platform") not in ALL_PLATFORMS:
        raise ValueError("Unsupported platform")
    handoff = data.get("browserHandoff")
    if handoff is not None:
        validate_handoff(handoff)
        if data["platform"] == "report12377":
            raise ValueError("Invalid session browser handoff")
    url = urlsplit(data.get("link", ""))
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.port not in (None, 80, 443):
        raise ValueError("Invalid URL")
    if data["platform"] != "report12377" and any(
        url.hostname == host or url.hostname.endswith("." + host)
        for host in ("10jqka.com.cn", "xueqiu.com", "weixin.qq.com", "weixin.com")
    ):
        raise ValueError("Unsupported direct reporting platform")
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
    if getattr(manager, "shared_browser", None) is not None:
        return  # The shared profile persists its own state; never export all accounts.
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
        import browser_session
        browser = browser_session.launch_isolated_browser(playwright, headless=False)
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
    phase = "manager_initialization"
    try:
        if data["platform"] == "report12377":
            execution_started = True
            return execute_12377(data)
        manager = manager_factory()
        manager.browser_handoff = data.get("browserHandoff")
        phase = "browser_attach"
        manager.init_browsers(data["platform"])
        phase = "login_check"
        if data["platform"] == "xiaohongshu":
            from xhs_phone import mobile_only_target, execute_phone
            page = manager.pages["xiaohongshu"]
            page.goto(data["link"], wait_until="domcontentloaded")
            target = mobile_only_target(page)
            if target:
                execution_started = True
                return execute_phone(data, target)
        # Login probes often navigate home. Keep the inherited document untouched
        # until the report flow itself navigates to the authorized target.
        if manager.browser_handoff is not None:
            inherited = manager.pages[data["platform"]]
            probe = manager.shared_browser.new_page()
            manager.pages[data["platform"]] = probe
            try:
                logged_in = manager.check_login_status(data["platform"])
            finally:
                manager.pages[data["platform"]] = inherited
                probe.close()
        else:
            logged_in = manager.check_login_status(data["platform"])
        if not logged_in:
            diagnostic = getattr(manager, "login_status_message", lambda platform: "")(data["platform"])
            if diagnostic:
                return outcome("manual_required", "平台登录状态检查发生异常，不能据此判定未登录。请检查浏览器连接、页面加载及运行权限后再核验。", "LOGIN_CHECK_FAILED")
            if getattr(manager, "shared_browser", None) is not None:
                return outcome("manual_required", "共享浏览器尚未确认平台登录，请先用 browser 查看原标签页，再调用 complaint_browser 的 login 复用该页，完成验证后 finish。旧批次不会自动重提。", "LOGIN_REQUIRED")
            return outcome("manual_required", "尚未确认当前用户的平台登录。请先用 OpenClaw browser 打开平台页面，再调用 complaint_browser(action=login, platform=" + data["platform"] + ", confirmed=true) 复用该标签页，用户登录后调用 finish。不会自动重提旧批次。", "LOGIN_REQUIRED")
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
        diagnostic = getattr(manager, "submission_diagnostic", None)
        if getattr(manager, "submission_attempted", None) is False:
            return outcome("failed", diagnostic or "举报流程在提交前停止，未点击提交。", code)
        return outcome("unknown", diagnostic or "未观察到平台提交成功提示，不能确认结果；请人工核对，勿自动重提。", code)
    except SharedBrowserUnavailable as exc:
        return outcome("manual_required", str(exc), "SHARED_BROWSER_UNAVAILABLE")
    except Exception as error:
        if execution_started:
            if getattr(manager, "submission_attempted", None) is False:
                return outcome("failed", "举报流程在提交前发生异常，未点击提交。", "EXECUTION_INTERRUPTED")
            return outcome("unknown", "执行结果无法确认，禁止自动重提。", "EXECUTION_INTERRUPTED")
        return runtime_failure(error, phase)
    finally:
        if manager is not None:
            if data.get("browserHandoff") is not None:
                try:
                    # Keep the exact borrowed tab addressable for the next item in
                    # this already-authorized batch, even after handler navigation.
                    page = manager.pages[data["platform"]]
                    page.evaluate("marker => Object.defineProperty(window, '__openclaw_session_handoff_v1', {value: marker, configurable: true})",
                                  data["browserHandoff"]["marker"])
                except Exception:
                    pass  # Next item will fail closed if the inherited page is gone.
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
        if not manager.check_login_status(args.platform):
            raise RuntimeError("尚未确认平台登录成功，请完成登录或验证后重新检查；未执行举报。")
        save_sessions(manager, directory)
    finally:
        if manager is not None:
            manager.close_all()
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-runtime", action="store_true",
                        help="Check Python modules and the Playwright driver without opening a browser")
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--platform")
    parser.add_argument("--user-id")
    parser.add_argument("--state-dir")
    parser.add_argument("--bind-browser", action="store_true")
    parser.add_argument("--existing-chrome", action="store_true",
                        help="Attach to the operator's running Chrome with remote debugging enabled")
    parser.add_argument("--check-browser", action="store_true",
                        help="Check existing Chrome connectivity without opening platform pages")
    parser.add_argument("--profile-dir")
    parser.add_argument("--cdp-url", default="http://127.0.0.1:18800")
    parser.add_argument("--allow-fake-ip", action="store_true",
                        help="Allow RFC2544 DNS answers only for a trusted local Fake-IP proxy")
    args = parser.parse_args()
    if args.check_runtime:
        with contextlib.redirect_stdout(sys.stderr):
            result = check_runtime()
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result["ready"] else 1)
    if args.allow_fake_ip:
        os.environ["OPENCLAW_COMPLAINT_ALLOW_FAKE_IP"] = "1"
    if args.existing_chrome:
        from shared_browser import default_chrome_profile_dir
        args.profile_dir = args.profile_dir or str(default_chrome_profile_dir())
    if args.check_browser:
        if not args.existing_chrome:
            parser.error("--check-browser requires --existing-chrome")
        from playwright.sync_api import sync_playwright
        from shared_browser import existing_chrome_binding, SharedBrowserLease
        try:
            with sync_playwright() as playwright:
                lease = SharedBrowserLease(playwright, existing_chrome_binding(
                    args.profile_dir, allow_benchmark=args.allow_fake_ip), headless=False)
                try:
                    print(json.dumps(dict(connected=True, driver="existing-session")))
                finally:
                    lease.close()
        except SharedBrowserUnavailable as exc:
            print(json.dumps(outcome("manual_required", str(exc),
                                     "SHARED_BROWSER_UNAVAILABLE"), ensure_ascii=False))
            raise SystemExit(1)
        return
    if args.existing_chrome and not args.bind_browser:
        parser.error("--existing-chrome requires --bind-browser or --check-browser")
    if args.bind_browser:
        if not args.user_id or not args.state_dir or not args.profile_dir:
            parser.error("--bind-browser requires --user-id, --state-dir and --profile-dir")
        from shared_browser import bind_profile
        directory = (Path(args.state_dir).resolve() / "leading-v2-complaint-sessions"
                     / hashlib.sha256(args.user_id.encode()).hexdigest())
        bind_profile(directory, args.profile_dir, args.cdp_url,
                     allow_benchmark=args.allow_fake_ip,
                     existing_session=args.existing_chrome)
        print(json.dumps(dict(bound=True, userId=args.user_id), ensure_ascii=False))
        return
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
