# -*- coding: utf-8 -*-
"""新浪新闻文章与新浪新闻社群帖举报的配置、地址解析及安全约束。"""

import json
import re
from urllib.parse import parse_qs, urlencode, urlparse


HOME_URL = "https://www.sina.com.cn/"
REPORT_FORM_URL = "https://news.sina.com.cn/blank/report_news.shtml"
REPORT_GUIDE_URL = (
    "https://news.sina.com.cn/zx/2026-03-26/"
    "doc-inhshnxa6242377.shtml"
)
REPORT_PAGE_TITLE = "举报_新浪跟帖_新浪网"

COMMUNITY_POST_GUIDE_URL = (
    "https://super.sina.cn/shequn/post/"
    "detail_1234718616672141312.html"
)
COMMUNITY_FEEDBACK_FORM_URL = (
    "https://sinanews.sina.cn/activities/feedback.d.html"
)
COMMUNITY_FEEDBACK_PAGE_TITLE = "我要反馈"
COMMUNITY_FEEDBACK_BUNDLE_URL = (
    "https://mjs.sinaimg.cn/wap/project/client-common-page/1.0.65/"
    "feedback/static/js/feedback.min.js"
)

FORM_SELECTOR = "form[bbs-node-type='reportForm']"
REPORT_OPTIONS_SELECTOR = (
    "form[bbs-node-type='reportForm'] .report-types-list label"
)
SELECTED_REASON_SELECTOR = "input[name='reportType']:checked"
HIDDEN_DESCRIPTION_SELECTOR = "textarea[name='reportCont']"
SUBMIT_SELECTOR = (
    "form[bbs-node-type='reportForm'] #submit[bbs-node-type='submit']"
)
ARTICLE_TITLE_SELECTOR = "#title"
SUCCESS_XPATH = (
    "//*[contains(text(), '提交成功，我们会及时处理您的举报，谢谢！')]"
)

SUBMIT_ENDPOINT_GLOB = "**/cmnt/submit*"
REPORT_VALIDATE_ENDPOINT_GLOB = "**/cms/report_page.d.json*"
SUBMIT_ENDPOINT_URL = "https://comment5.news.sina.com.cn/cmnt/submit"

COMMUNITY_FORM_SELECTOR = (
    "form#error-form[action*='/interface/articlefb.d.json']"
)
COMMUNITY_REPORT_OPTIONS_SELECTOR = "#error-form label[for^='check-']"
COMMUNITY_SELECTED_REASON_SELECTOR = (
    "#error-form input[type='checkbox']:checked"
)
COMMUNITY_TEXTAREA_SELECTOR = "#error-form textarea[name='content']"
COMMUNITY_SUBMIT_SELECTOR = "#error-form button.submit"
COMMUNITY_SUCCESS_XPATH = (
    "//div[contains(concat(' ', normalize-space(@class), ' '), ' layer ') "
    "and .//h4[contains(normalize-space(), '提交成功')]]"
)
COMMUNITY_SUBMIT_ENDPOINT_URL = (
    "https://sinanews.sina.cn/interface/articlefb.d.json"
)
COMMUNITY_SUBMIT_ENDPOINT_GLOB = "**/interface/articlefb.d.json*"
COMMUNITY_READY_SUBMIT_CLASS = "submit-select"
COMMUNITY_DESCRIPTION_LIMIT = 140
COMMUNITY_UPLOAD_SUPPORTED = False

LOGIN_REQUIRED = True
DESCRIPTION_SUPPORTED = False
UPLOAD_SUPPORTED = False

REPORT_REASONS = (
    ("1", "违法涉政"),
    ("2", "淫秽色情"),
    ("3", "网络赌博"),
    ("4", "诈 骗"),
    ("5", "营销广告"),
    ("6", "言论攻击"),
    ("8", "涉未成年人举报"),
    ("9", "历史虚无主义"),
    ("13", "网络谣言"),
    ("10", "涉互联网算法推荐专项举报"),
    ("11", "网络暴力"),
    ("12", "养老诈骗"),
    ("13", "传播虚假信息"),
    ("14", "仿冒官方机构、新闻媒体或主播等"),
    ("15", "胡评妄议、导向不良"),
    ("16", "涉民族宗教举报"),
    ("19", "生活服务类信息举报"),
    ("22", "涉十五运会和残特奥会不良信息"),
    ("7", "其他理由"),
)
REPORT_CATEGORIES = tuple(label for _, label in REPORT_REASONS)

COMMUNITY_REPORT_CATEGORIES = (
    "内容太水",
    "标题党",
    "违法涉政",
    "与事实不符",
    "旧闻、重复",
    "低俗色情",
    "广告",
    "侵权",
    "排版格式有误",
    "有错别字",
    "网络赌博",
    "诈骗",
    "涉未成年人举报",
    "违规采编财经信息",
    "历史虚无主义",
    "网络暴力",
    "养老诈骗",
    "网络谣言",
    "涉互联网算法推荐专项举报",
    "胡评妄议、导向不良",
    "传播虚假信息",
    "涉民族宗教举报",
    "仿冒官方机构、新闻媒体或主播等",
    "涉企虚假不实信息举报",
    "生活服务类信息举报",
    "涉十五运会和残特奥会不良信息",
)

_DESKTOP_DOC_RE = re.compile(r"/doc-i([a-z0-9]+)\.shtml$", re.I)
_MOBILE_DOC_RE = re.compile(r"/detail-i([a-z0-9]+)\.d\.html$", re.I)
_METADATA_DOC_RE = re.compile(r"dataid\s*:\s*comos[:\-]([a-z0-9]+)", re.I)
_COMMUNITY_POST_RE = re.compile(
    r"^/shequn/post/detail_(\d+)\.html/?$", re.I
)
_COMMUNITY_FEEDBACK_DOC_RE = re.compile(
    r"^HB-1-discovery_hot_doc/hot_community-(\d+)-tiezi$", re.I
)
_COMMUNITY_FEEDBACK_LINK_RE = re.compile(
    r'"feedback"\s*:\s*\{\s*"link"\s*:\s*"((?:\\.|[^"\\])*)"',
    re.I,
)


def normalize_option_text(value):
    """保留页面类别的实际字样，只折叠多余空白。"""
    return " ".join(str(value or "").split())


def extract_community_post_id(url):
    """从 super.sina.cn 的社群帖子地址提取数字帖子 ID。"""
    parsed = urlparse(str(url or ""))
    if (parsed.hostname or "").lower() != "super.sina.cn":
        return ""
    match = _COMMUNITY_POST_RE.match(parsed.path)
    return match.group(1) if match else ""


def is_community_post_url(url, expected_post_id=""):
    post_id = extract_community_post_id(url)
    return bool(
        post_id and
        (not expected_post_id or post_id == str(expected_post_id))
    )


def is_community_feedback_page(url, expected_post_id="", title=""):
    """严格校验社群帖内嵌的官方“我要反馈”地址及三组帖子标识。"""
    parsed = urlparse(str(url or ""))
    if ((parsed.hostname or "").lower() != "sinanews.sina.cn" or
            parsed.path != "/activities/feedback.d.html"):
        return False
    if title and title != COMMUNITY_FEEDBACK_PAGE_TITLE:
        return False

    params = parse_qs(parsed.query)
    doc_id = params.get("docId", [""])[0]
    match = _COMMUNITY_FEEDBACK_DOC_RE.match(doc_id)
    if not match:
        return False
    post_id = match.group(1)
    data_id = params.get("dataid", [""])[0]
    wap_url = params.get("wapUrl", [""])[0]
    return bool(
        params.get("type", [""])[0] == "tiezi" and
        data_id == f"tiezi:{post_id}" and
        is_community_post_url(wap_url, post_id) and
        (not expected_post_id or post_id == str(expected_post_id))
    )


def extract_community_feedback_url(script_sources, expected_post_id=""):
    """从社群帖子内嵌状态中提取并校验官方反馈地址。"""
    for source in script_sources or ():
        for match in _COMMUNITY_FEEDBACK_LINK_RE.finditer(
                str(source or "")):
            try:
                url = json.loads(f'"{match.group(1)}"')
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if is_community_feedback_page(url, expected_post_id):
                return url
    return ""


def community_description_units(value):
    """反馈页以 JavaScript 字符串长度计数，即 UTF-16 code units。"""
    return sum(2 if ord(char) > 0xFFFF else 1 for char in str(value or ""))


def prepare_community_description(value):
    """按社群反馈页的 140 个 UTF-16 单位限制安全截断说明。"""
    result = []
    used = 0
    for char in str(value or "").strip():
        units = 2 if ord(char) > 0xFFFF else 1
        if used + units > COMMUNITY_DESCRIPTION_LIMIT:
            break
        result.append(char)
        used += units
    return "".join(result)


def extract_doc_id(article_url, metadata=()):
    """从新浪桌面/移动文章地址或 sudameta 中提取举报页所需 docId。"""
    parsed = urlparse(str(article_url or ""))
    hostname = (parsed.hostname or "").lower()
    is_sina_host = (
        hostname == "sina.com.cn"
        or hostname.endswith(".sina.com.cn")
        or hostname == "sina.cn"
        or hostname.endswith(".sina.cn")
    )
    if not is_sina_host:
        return ""

    if parsed.path == "/blank/report_news.shtml":
        return parse_qs(parsed.query).get("docId", [""])[0].strip()

    for pattern in (_DESKTOP_DOC_RE, _MOBILE_DOC_RE):
        match = pattern.search(parsed.path)
        if match:
            return match.group(1)

    for value in metadata or ():
        match = _METADATA_DOC_RE.search(str(value or ""))
        if match:
            return match.group(1)
    return ""


def build_report_url(article_url, metadata=()):
    doc_id = extract_doc_id(article_url, metadata)
    if not doc_id:
        raise ValueError("无法从新浪文章地址提取 docId")
    return f"{REPORT_FORM_URL}?{urlencode({'docId': doc_id})}"


def is_report_page(url, title=""):
    parsed = urlparse(str(url or ""))
    return (
        parsed.hostname == "news.sina.com.cn"
        and parsed.path == "/blank/report_news.shtml"
        and bool(parse_qs(parsed.query).get("docId", [""])[0].strip())
        and (not title or title == REPORT_PAGE_TITLE)
    )


def is_logged_in_state(value):
    """新浪提交脚本以 SINA_OUTLOGIN_LAYER.isLogin() 的布尔值为准。"""
    return value is True


def has_login_and_submit_contract(source):
    """保守检查当前公开页面仍要求登录并使用预期提交接口。"""
    value = str(source or "")
    return all(marker in value for marker in (
        "SINA_OUTLOGIN_LAYER.isLogin()",
        "getOutLogin().show()",
        SUBMIT_ENDPOINT_URL,
    ))


def has_community_feedback_contract(source):
    """检查社群反馈脚本的接口、上限和按钮启用约束仍保持一致。"""
    value = str(source or "")
    return all(marker in value for marker in (
        COMMUNITY_SUBMIT_ENDPOINT_URL,
        "140-",
        COMMUNITY_READY_SUBMIT_CLASS,
        'n.submit()',
    ))
