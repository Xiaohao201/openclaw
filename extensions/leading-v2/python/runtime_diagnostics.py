"""Bounded runtime diagnostics, without exposing exception payloads or account data."""
import importlib
import platform
import re
import sys

from shared_browser import SharedBrowserUnavailable


def runtime_failure(error, phase):
    if isinstance(error, SharedBrowserUnavailable):
        return dict(state="manual_required", message=str(error),
                    errorCode="SHARED_BROWSER_UNAVAILABLE", offline=None)
    code = "RUNTIME_UNAVAILABLE"
    missing = getattr(error, "name", None)
    module = missing if isinstance(missing, str) and re.fullmatch(r"[A-Za-z0-9_.]{1,120}", missing) else None
    if isinstance(error, ModuleNotFoundError):
        code = "RUNTIME_DEPENDENCY_MISSING"
        advice = "请使用插件的 setup_runtime.py 安装 Python 运行环境，或为 complaintExecution.python 指定已安装依赖的解释器。"
    elif isinstance(error, ImportError):
        code = "RUNTIME_IMPORT_FAILED"
        advice = "请检查 Python 版本及插件 Python 文件和依赖是否完整。"
    elif isinstance(error, PermissionError):
        code = "RUNTIME_PERMISSION_DENIED"
        advice = "请检查执行账号对用户会话目录、浏览器资料目录和 Python 驱动的访问权限。"
    else:
        advice = "请运行 runner.py --check-runtime 核对解释器及驱动，再检查当前浏览器连接；不能据此认定缺少浏览器安装。"
    # Exception messages may contain page content, tokens, or connection URLs.
    kind = type(error).__name__
    kind = kind if re.fullmatch(r"[A-Za-z0-9_]{1,100}", kind) else "Exception"
    message = (f"Python 执行器失败（阶段 {phase}；异常 {kind}"
               + (f"；缺少模块 {module}" if module else "")
               + f"；解释器 {sys.executable}；Python {platform.python_version()}）。{advice}未提交平台。")
    return dict(state="failed", message=message[:2000], errorCode=code, offline=None)


def check_runtime():
    """Import all executor modules and start only Playwright's driver, never Chrome."""
    if sys.version_info < (3, 10):
        return dict(ready=False, state="failed", errorCode="RUNTIME_PYTHON_UNSUPPORTED",
                    message="举报执行器需要 Python 3.10 或更高版本。", offline=None)
    phase = "module_import"
    driver = None
    try:
        importlib.import_module("browser_manager")
        from playwright.sync_api import sync_playwright
        phase = "playwright_driver"
        driver = sync_playwright().start()
        driver.stop()
        driver = None
        return dict(ready=True, python=sys.executable, pythonVersion=platform.python_version())
    except Exception as error:
        return dict(ready=False, **runtime_failure(error, phase))
    finally:
        if driver is not None:
            try:
                driver.stop()
            except Exception:
                pass
