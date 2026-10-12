# -*- coding: utf-8 -*-
"""一点号内容在一点资讯文章页的举报配置与安全约束（导入无副作用）。"""

import re
from urllib.parse import parse_qs, urlparse


HOME_URL = "https://www.yidianzixun.com/"
MP_HOME_URL = "https://mp.yidianzixun.com/"
COMPLAINT_URL = "https://www.yidianzixun.com/complain"
ENTERPRISE_COMPLAINT_URL = "https://www.yidianzixun.com/enterprise-complain"
REPORT_GUIDE_URL = "https://www.yidianzixun.com/article/0gvokThV"
REPORT_EMAIL = "tousu@yidian-inc.com"

ARTICLE_SCRIPT_SELECTOR = "script[src*='/build/index_pc/article-'][src$='.js']"
REPORT_ENTRY_SELECTOR = ".article-report"
REPORT_POPUP_SELECTOR = ".report-article-box"
REPORT_FORM_SELECTOR = ".report-article-form"
REPORT_OPTIONS_SELECTOR = ".report-article-form li"
SELECTED_REASON_SELECTOR = ".report-article-form li.actived-li"
SUBMIT_SELECTOR = ".report-article-form .btn-submit"
SUCCESS_XPATH = "//*[contains(text(), '举报成功！')]"

SUBMIT_ENDPOINT_GLOB = "**/home/q/report_article*"
SUBMIT_ENDPOINT_PATH = "/home/q/report_article"

LOGIN_REQUIRED = True
DESCRIPTION_SUPPORTED = False
UPLOAD_SUPPORTED = False
MULTI_SELECT_SUPPORTED = True
EMAIL_FALLBACK_SUPPORTED = True

REPORT_CATEGORIES = (
    "标题党",
    "谣言",
    "内容差",
    "色情",
    "旧闻",
    "广告",
    "劣质源",
    "反动",
    "封建迷信",
    "错别字多",
    "网络暴力",
    "算法不良信息",
    "侵权",
    "历史虚无",
    "涉未成年不良信息",
    "其他",
)

_ARTICLE_RE = re.compile(r"^/article/([A-Za-z0-9_-]+?)/?$", re.I)


def normalize_option_text(value):
    """保留页面类别文字，仅折叠多余空白。"""
    return " ".join(str(value or "").split())


def _is_yidian_host(hostname):
    value = str(hostname or "").lower()
    return value == "yidianzixun.com" or value.endswith(".yidianzixun.com")


def extract_doc_id(article_url):
    """从一点资讯文章地址中提取公开页面使用的 docid。"""
    parsed = urlparse(str(article_url or ""))
    if not _is_yidian_host(parsed.hostname):
        return ""
    match = _ARTICLE_RE.match(parsed.path)
    return match.group(1) if match else ""


def is_article_page(url, expected_doc_id=""):
    doc_id = extract_doc_id(url)
    return bool(doc_id and (not expected_doc_id or doc_id == expected_doc_id))


def is_login_url(url):
    parsed = urlparse(str(url or ""))
    return _is_yidian_host(parsed.hostname) and parsed.path.rstrip("/") == "/login"


def login_redirect_target(url):
    """返回登录页携带的 redirect_uri，便于检查匿名跳转契约。"""
    if not is_login_url(url):
        return ""
    return parse_qs(urlparse(url).query).get("redirect_uri", [""])[0].strip()


def is_logged_in_state(value):
    """页面 ``window.yidian.docinfo.is_login`` 只有严格布尔真才算登录。"""
    return value is True


def has_report_bundle_contract(source):
    """保守检查文章脚本仍包含登录守卫、选中态和预期提交接口。"""
    value = str(source or "")
    return all(marker in value for marker in (
        "loginFilter()",
        REPORT_ENTRY_SELECTOR,
        SUBMIT_ENDPOINT_PATH + "?docid=",
        "actived-li",
        "举报成功！",
    ))
