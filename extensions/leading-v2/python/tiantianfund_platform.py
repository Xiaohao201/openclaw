# -*- coding: utf-8 -*-
"""天天基金“基金吧”主帖举报配置、地址解析与安全约束（导入无副作用）。"""

import re
from urllib.parse import parse_qs, urlparse

import eastmoney_platform as eastmoney


HOME_URL = "https://fund.eastmoney.com/"
REPORT_EMAIL = "jubao@eastmoney.com"
FUND_BAR_HOME_URL = "https://fund.eastmoney.com/ba/jj.html"
FUND_REDIRECT_GUIDE_URL = (
    "https://fund.eastmoney.com/ba/news,of021651,1767208946.html"
)
REPORT_GUIDE_URL = (
    "https://guba.eastmoney.com/news,of021651,1767208946.html"
)

# 天天基金基金吧页面会跳到 guba.eastmoney.com，但主帖举报仍进入东方财富
# 统一举报中心。replyid=0 明确表示举报主帖，避免误点“举报本回复”。
REPORT_ENTRY_SELECTOR = (
    "a.graylink[href*='help.eastmoney.com/report_center.html']"
    "[href*='reportType=3'][href*='replyid=0']"
)
REPORT_CENTER_URL = eastmoney.REPORT_CENTER_URL
OFFICIAL_BUNDLE_URL = eastmoney.OFFICIAL_BUNDLE_URL
LOGIN_HOST = eastmoney.LOGIN_HOST

REASON_OPTIONS_SELECTOR = eastmoney.REASON_OPTIONS_SELECTOR
SELECTED_REASON_INPUT_SELECTOR = eastmoney.SELECTED_REASON_INPUT_SELECTOR
TEXTAREA_SELECTOR = eastmoney.TEXTAREA_SELECTOR
UPLOAD_INPUT_SELECTOR = eastmoney.UPLOAD_INPUT_SELECTOR
UPLOAD_SUCCESS_SELECTOR = eastmoney.UPLOAD_SUCCESS_SELECTOR
SUBMIT_SELECTOR = eastmoney.SUBMIT_SELECTOR
SUCCESS_XPATH = eastmoney.SUCCESS_XPATH

DESCRIPTION_MAX_LENGTH = eastmoney.DESCRIPTION_MAX_LENGTH
MAX_IMAGES = eastmoney.MAX_IMAGES
MAX_IMAGE_BYTES = eastmoney.MAX_IMAGE_BYTES
REPORT_CATEGORIES = eastmoney.REPORT_CATEGORIES
SUBMIT_ENDPOINT_GLOBS = eastmoney.SUBMIT_ENDPOINT_GLOBS
UPLOAD_ENDPOINT_GLOBS = (
    "**/*ReportFileUpload*",
    "**/*Common%2FReportFileUpload*",
)

LOGIN_REQUIRED = True
EMAIL_FALLBACK_SUPPORTED = True

_POST_RE = re.compile(
    r"^/(?:ba/)?news,of([A-Za-z0-9]+),(\d+)\.html$",
    re.I,
)


def extract_post_target(url):
    """返回基金吧 ``(基金代码, 主帖 id)``；非天天基金基金帖返回空值。"""
    parsed = urlparse(str(url or ""))
    hostname = (parsed.hostname or "").lower()
    if hostname not in {"fund.eastmoney.com", "guba.eastmoney.com"}:
        return ("", "")
    match = _POST_RE.match(parsed.path)
    if not match:
        return ("", "")
    return match.group(1), match.group(2)


def is_fundbar_post_url(url, expected_target=None):
    target = extract_post_target(url)
    return bool(
        all(target) and
        (not expected_target or tuple(expected_target) == target)
    )


def report_link_matches_post(report_url, post_url):
    """确认举报链接是当前基金吧主帖，而不是回复或其他东方财富内容。"""
    fund_code, post_id = extract_post_target(post_url)
    if not fund_code or not post_id:
        return False

    parsed = urlparse(str(report_url or ""))
    if (parsed.hostname or "").lower() != "help.eastmoney.com":
        return False
    if parsed.path.rstrip("/") != "/report_center.html":
        return False

    query = parse_qs(parsed.query)
    return all((
        query.get("reportType", [""])[0] == "3",
        query.get("systype", [""])[0] == "1",
        query.get("replyid", [""])[0] == "0",
        query.get("gubaCode", [""])[0].lower() == fund_code.lower(),
        query.get("id", [""])[0] == post_id,
    ))


def prepare_description(value):
    return eastmoney.prepare_description(value)


def is_login_url(url):
    return eastmoney.is_login_url(url)
