"""User-scoped interactive login. This worker never imports a report submission flow."""
import base64
import contextlib
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

from config import ALL_PLATFORMS
from shared_browser import validate_handoff
from runtime_diagnostics import runtime_failure

LOGIN_URLS = {
    "baidu": "https://www.baidu.com", "bilibili": "https://www.bilibili.com",
    "douyin": "https://www.douyin.com", "eastmoney": "https://help.eastmoney.com",
    "futu": "https://www.futunn.com", "kuaishou": "https://www.kuaishou.com",
    "netease": "https://www.163.com", "sina": "https://www.sina.com.cn",
    "sohu": "https://www.sohu.com", "tencent": "https://www.qq.com",
    "tiantianfund": "https://fund.eastmoney.com", "toutiao": "https://www.toutiao.com",
    "weibo": "https://weibo.com", "xiaohongshu": "https://www.xiaohongshu.com",
    "yidianzixun": "https://www.yidianzixun.com", "zhihu": "https://www.zhihu.com",
}


def setup(data, commands, emit, manager_factory=None):
    platform = data.get("platform")
    directory = Path(data.get("sessionDir", ""))
    if platform not in ALL_PLATFORMS or platform not in LOGIN_URLS or not directory.is_absolute():
        raise ValueError("Invalid login session")
    # Login must borrow the same OpenClaw page as reporting. Missing or stale
    # handoffs must never trigger BrowserManager's legacy standalone fallback.
    handoff = validate_handoff(data.get("browserHandoff"))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / "execution.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        emit(dict(state="busy", message="此用户正在执行举报或登录，请稍后重试。"))
        return
    with os.fdopen(fd, "w") as file:
        file.write(str(os.getpid()))
    manager = None
    try:
        os.environ["OPENCLAW_COMPLAINT_SESSION_DIR"] = str(directory)
        import config
        config.HEADLESS = False
        # browser_manager copies HEADLESS on import; this process only serves login.
        import browser_manager
        browser_manager.HEADLESS = False
        if manager_factory is None:
            manager_factory = browser_manager.BrowserManager
        manager = manager_factory()
        manager.browser_handoff = handoff
        manager.init_browsers(platform)
        page = manager.pages[platform]
        page.goto(LOGIN_URLS[platform], wait_until="domcontentloaded", timeout=30000)
        # Only reveal a login form, never click a report or account submission button.
        for label in ("立即登录", "登录/注册", "登录"):
            matches = page.get_by_text(label, exact=True)
            visible = next((item for item in matches.all() if item.is_visible()), None)
            if visible is not None:
                visible.click(timeout=5000)
                break
        emit(dict(state="awaiting_login", message="已复用当前对话的 OpenClaw 浏览器标签页，请在该页面完成登录或验证；完成后确认。不会提交举报。"))
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            try:
                command = commands.get_nowait()
            except queue.Empty:
                page.wait_for_timeout(200)
                continue
            if command == "finish":
                from runner import save_sessions
                save_sessions(manager, directory)
                emit(dict(state="saved", message="登录态保留在同一 OpenClaw 浏览器，原标签页保持打开；这不代表平台已通过登录验证或举报已提交，旧批次不会自动重提。"))
                return
            if command == "cancel":
                emit(dict(state="cancelled", message="登录流程已结束，原 OpenClaw 浏览器和标签页保持打开；已有登录变化不会撤销，未提交举报。"))
                return
            if command == "screenshot":
                shot = page.screenshot(type="jpeg", quality=65, timeout=10000)
                emit(dict(state="awaiting_login", message="当前用户的登录页面，请扫码或在执行机完成操作。",
                          screenshot=base64.b64encode(shot).decode("ascii")))
            elif command == "status":
                emit(dict(state="awaiting_login", message="等待此用户完成登录并确认保存；不会自动提交举报。"))
        emit(dict(state="expired", message="登录流程已超时结束，原 OpenClaw 浏览器和标签页保持打开；请先用 browser 查看该页面再发起登录。"))
    finally:
        if manager is not None:
            try:
                manager.close_all()
            finally:
                lock.unlink(missing_ok=True)
        else:
            lock.unlink(missing_ok=True)


def main():
    output = sys.stdout
    def emit(result):
        print(json.dumps(result, ensure_ascii=False), file=output, flush=True)
    commands = queue.Queue()
    try:
        data = json.loads(sys.stdin.readline(65536))
        def read_commands():
            for line in sys.stdin:
                try:
                    command = json.loads(line).get("action")
                except (ValueError, AttributeError):
                    command = "cancel"
                commands.put(command)
            commands.put("cancel")
        threading.Thread(target=read_commands, daemon=True).start()
        with contextlib.redirect_stdout(sys.stderr):
            setup(data, commands, emit)
    except Exception as error:
        failure = runtime_failure(error, "login_setup")
        emit(dict(state="failed", message=failure["message"], errorCode=failure["errorCode"]))


if __name__ == "__main__":
    main()
