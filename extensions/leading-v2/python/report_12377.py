"""12377 anonymous browser flow. No network/DB/browser work at import time.

Official HTML verified 2026-09-28: notice -> smjb -> nmjb; form IDs and
the POST /rpapi/portal/report/add response come from the official page.
The operator performs captcha, attachment selection and final submission.
"""
import json
import time
from urllib.parse import urlsplit


NOTICES = {
    "politics": "zzl", "terrorism": "bkl", "fraud": "zpl",
    "pornography": "sql", "vulgarity": "dsl", "gambling": "dbl", "rumor": "yyl",
}
LABELS = dict(zip(NOTICES, ("政治类", "暴恐类", "诈骗类", "色情类", "低俗类", "赌博类", "谣言类")))
ANONYMOUS_PATH = "/jbxzxq/jbxx/nmjb/nmjb.html"
SUBMIT_PATH = "/rpapi/portal/report/add"


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def validate_payload(payload):
    if not isinstance(payload, dict) or payload.get("mode") != "anonymous":
        raise ValueError("12377任务必须明确使用匿名模式")
    if payload.get("category") not in NOTICES:
        raise ValueError("不支持该匿名类别；侵权类须实名")
    clean = {"mode": "anonymous", "category": payload["category"]}
    for key, limit in (("url", 500), ("description", 500), ("websiteName", 40)):
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip() or "\0" in value or utf16_length(value.strip()) > limit:
            raise ValueError("举报字段为空或超出官网限制：" + key)
        clean[key] = value.strip()
    url = urlsplit(clean["url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("被举报网址无效")
    return clean  # Identity/credentials/attachments are never propagated.


def is_official(url):
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in ("www.12377.cn", "new.12377.cn") and parsed.port in (None, 443)


def is_submission(url, method):
    return method == "POST" and is_official(url) and urlsplit(url).path == SUBMIT_PATH


def receipt_code(payload):
    if not isinstance(payload, dict) or str(payload.get("code")) != "1000":
        return ""
    result = payload.get("result")
    code = result.get("retrievalCode") if isinstance(result, dict) else None
    if not isinstance(code, str) or not code.strip() or len(code) > 128 or any(c.isspace() or ord(c) < 32 for c in code):
        return ""
    return code




def run_browser_flow(page, payload, update, heartbeat, timeout=600, now=time.monotonic):
    data = validate_payload(payload)
    result = {"attempted": False, "code": "", "response_error": False}
    anonymous_requests = set()

    def on_request(request):
        if is_submission(request.url, request.method):
            result["attempted"] = True
            if is_official(page.url) and urlsplit(page.url).path == ANONYMOUS_PATH:
                anonymous_requests.add(request)
            else:
                result["response_error"] = True

    def on_response(response):
        if response.request not in anonymous_requests or not is_submission(response.url, response.request.method):
            return
        try:
            code = receipt_code(response.json()) if response.ok else ""
            if code:
                result["code"] = code
            else:
                result["response_error"] = True
        except Exception:
            result["response_error"] = True

    page.on("request", on_request)
    page.on("response", on_response)
    # Registering a handler disables Playwright's default auto-dismiss. The
    # on-site operator handles the website's native confirmation dialog.
    def on_dialog(dialog):
        pass
    page.on("dialog", on_dialog)
    try:
        notice = "https://www.12377.cn/jbxzxq/" + NOTICES[data["category"]] + "jbxzxq.html"
        page.goto(notice, wait_until="domcontentloaded", timeout=30000)
        heartbeat()
        if not is_official(page.url):
            raise ValueError("未进入12377官网")
        page.locator("#isee").check(timeout=15000)
        page.locator("#agree:not(.grey)").wait_for(state="visible", timeout=15000)
        page.locator("#agree").click(timeout=15000)
        heartbeat()
        page.locator("#nmjb_tabs").click(timeout=15000)
        page.wait_for_url("**" + ANONYMOUS_PATH, timeout=30000)
        heartbeat()
        if not is_official(page.url) or urlsplit(page.url).path != ANONYMOUS_PATH:
            raise ValueError("无法确认匿名举报页面，停止填表")
        if LABELS[data["category"]] not in page.locator("#big_HAEM").inner_text():
            raise ValueError("官网类别与任务不符，停止填表")
        # niceSelect hides the native select; changing it dispatches the official change handler.
        page.locator("#report_platform").select_option("WEBSITE", force=True)
        page.locator("#report_platform").evaluate("el => window.jQuery(el).niceSelect('update')")
        heartbeat()
        page.locator("#website_name").fill(data["websiteName"])
        page.locator("#website_address").fill(data["url"])
        page.locator("#report_content").fill(data["description"])
        update("awaiting_manual", "匿名表单已填好，请在执行机浏览器核对小类、补充附件、完成验证码并点击提交（10分钟内）")
        deadline = now() + timeout
        submitting_saved = False
        while now() < deadline:
            heartbeat()
            if result["code"]:
                update("submitted", "官网已返回举报查询码；不代表已受理或处置", result["code"])
                return
            if result["response_error"]:
                update("unknown", "官网提交未返回可验证查询码，请人工核对；不会自动重投")
                return
            if result["attempted"] and not submitting_saved:
                update("submitting", "已观察到官网提交请求，正在等待查询码；请勿重复提交")
                submitting_saved = True
            if page.is_closed():
                break
            page.wait_for_timeout(500)
        update("unknown" if result["attempted"] else "manual_expired",
               "未取得官网查询码，请人工核查，任务不会自动重投" if result["attempted"] else "人工处理窗口已结束，未观察到提交请求")
    except Exception:
        if result["code"]:
            # A receipt persistence failure must NOT downgrade to a retryable failure.
            raise
        update("unknown" if result["attempted"] else "failed",
               "提交结果不明，请人工核对，禁止自动重投" if result["attempted"] else "未完成匿名表单准备，请检查官网布局或执行机浏览器")
    finally:
        page.remove_listener("request", on_request)
        page.remove_listener("response", on_response)
        page.remove_listener("dialog", on_dialog)


