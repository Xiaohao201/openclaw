# -*- coding: utf-8 -*-
"""搜狐文章“内容举报”页面的纯配置与输入约束（导入时无副作用）。"""

import re
from urllib.parse import parse_qs, urljoin, urlparse

from category_matcher import best_match, normalize_category


HOME_URL = "https://www.sohu.com/"
REPORT_GUIDE_URL = "https://m.sohu.com/a/973967890_161795"

# PC 文章页仍可能直接显示“内容举报”；当前移动文章页需要先点击右上角
# 三点菜单，再点击底部分享面板中的“举报/反馈”。
REPORT_ENTRY_SELECTOR = "a.report-c[href*='/feedback?']"
MOBILE_MORE_SELECTOR = ".navbar-icon"
MOBILE_REPORT_ENTRY_SELECTOR = (
    "a[href*='/feedback?'][href*='articleUrl=']:visible"
)
REPORT_PAGE_TITLE = "搜狐网PC端举报反馈"
MOBILE_REPORT_PAGE_TITLE = "搜狐网"
REPORT_HEADING = "内容举报"
ACTIVE_REPORT_TAB_SELECTOR = ".tab-area .title.active"

REASON_OPTIONS_SELECTOR = (
    ".report-content .question-item .reason-label, "
    ".report-container .question-item .reason-label"
)
SELECTED_REASON_SELECTOR = (
    ".report-content .question-item:has(.radio-label.active-radio) "
    ".reason-label, "
    ".report-container .question-item:has(.radio-label.active-radio) "
    ".reason-label"
)
TEXTAREA_SELECTOR = (
    ".report-content textarea.statement-input, "
    ".report-container textarea.statement-input"
)
UPLOAD_INPUT_SELECTOR = (
    ".report-content input#picture[type='file'], "
    ".report-container input#picture[type='file']"
)
UPLOAD_SUCCESS_SELECTOR = (
    ".report-content .picture-item, .report-container .picture-item"
)
SUBMIT_SELECTOR = (
    ".button-submit.can-submit, .feedback-container .submit-button"
)
SUCCESS_XPATH = "//*[contains(text(), '感谢反馈！已提交审核处理')]"

REASONS_API_URL = (
    "https://uis.mp.sohu.com/advice/home/advice/cause/find?sceneId=2"
)
SUBMIT_ENDPOINT_GLOB = "**/advice/home/advice/report*"
UPLOAD_ENDPOINT_GLOB = "**/advice/image/advice/upload/image*"
CAPTCHA_ENDPOINT_GLOB = "**/advice/imgcode/verifycaptcha*"

PC_BUNDLE_SELECTOR = (
    "script[src*='msfe-static-prod'][src*='/pcFeedback-'][src$='.js']"
)
FORM_CSS_SELECTOR = (
    "link[href*='msfe-static-prod'][href*='/feedbackIndex-'][href$='.css']"
)

DESCRIPTION_MAX_LENGTH = 300
MAX_FILES = 8
ANONYMOUS_REPORTING_SUPPORTED = True
UPLOAD_REQUIRES_LOGIN = True
ANONYMOUS_UPLOAD_TEXT = "登录后可上传截图，便于快速定位问题"

REPORT_REASONS = (
    (3, "标题党"),
    (4, "旧闻重发"),
    (5, "低俗色情"),
    (6, "内容质量差/不完整"),
    (7, "广告软文"),
    (9, "涉嫌侵权"),
    (10, "涉嫌抄袭"),
    (11, "政治有害"),
    (12, "网络暴力"),
    (13, "历史虚无主义"),
    (14, "算法不良信息"),
    (15, "涉及未成年人的不良内容"),
    (16, "传播谣言信息、有害信息和虚假信息"),
    (17, "假冒仿冒官方机构、新闻媒体和特定人员"),
    (18, "蹭炒热点、利用弱势群体博流量等违规盈利行为"),
    (19, "其他"),
    (21, "惊悚恐怖"),
    (22, "博彩诈骗"),
    (23, "生活服务类不良信息"),
    (24, "成都世运会违法不良信息"),
)
REPORT_CATEGORIES = tuple(name for _, name in REPORT_REASONS)
CAUSE_BY_CATEGORY = {name: cause for cause, name in REPORT_REASONS}

MANUAL_IDENTITY_CATEGORIES = (
    "涉嫌侵权",
    "涉嫌抄袭",
)

_ARTICLE_PATH_RE = re.compile(r"^/a/(\d+)_(\d+)/?$", re.I)


def extract_article_target(url):
    """返回搜狐文章 ``(文章 id, 作者 id)``；非官方文章地址返回空值。"""
    parsed = urlparse(str(url or ""))
    if (parsed.hostname or "").lower() not in {
            "www.sohu.com", "m.sohu.com"}:
        return ("", "")
    match = _ARTICLE_PATH_RE.match(parsed.path)
    return match.groups() if match else ("", "")


def report_link_matches_article(report_url, article_url):
    """确认举报链接来自官方反馈页且绑定当前文章，而非普通意见反馈。"""
    expected = extract_article_target(article_url)
    if not all(expected):
        return False

    parsed = urlparse(urljoin(str(article_url or ""), str(report_url or "")))
    if (parsed.hostname or "").lower() not in {
            "www.sohu.com", "m.sohu.com"}:
        return False
    if parsed.path.rstrip("/") != "/feedback":
        return False

    query = parse_qs(parsed.query)
    target_url = query.get("articleUrl", [""])[0]
    return extract_article_target(target_url) == expected


def prepare_description(value):
    """清洗并按搜狐普通内容举报页的 300 字限制截断描述。"""
    return str(value or "").strip()[:DESCRIPTION_MAX_LENGTH]


def categories_from_payload(payload):
    """从搜狐公开问题类型接口中按展示顺序提取类别。"""
    return tuple(item["causeDesc"] for item in payload["data"])


def reasons_from_payload(payload):
    """从搜狐公开问题类型接口中提取 ``(cause, causeDesc)``。"""
    return tuple(
        (int(item["cause"]), item["causeDesc"])
        for item in payload["data"]
    )


def feedback_bundle_url_from_css(css_url):
    """由页面实际加载的 feedbackIndex CSS 地址推导同版本 JS 地址。"""
    value = str(css_url or "")
    if "/css/feedbackIndex-" not in value or not value.endswith(".css"):
        raise ValueError("不是搜狐 feedbackIndex 样式地址")
    return value.replace("/css/", "/js/")[:-4] + ".js"


def is_report_page(url, title=""):
    """保守识别通过文章入口打开的搜狐 PC 或移动内容举报页。"""
    parsed = urlparse(str(url or ""))
    query = parse_qs(parsed.query)
    hostname = (parsed.hostname or "").lower()
    article_target = extract_article_target(
        query.get("articleUrl", [""])[0]
    )
    expected_title = (
        REPORT_PAGE_TITLE if hostname == "www.sohu.com"
        else MOBILE_REPORT_PAGE_TITLE
    )
    return (
        hostname in {"www.sohu.com", "m.sohu.com"}
        and parsed.path == "/feedback"
        and all(article_target)
        and (
            hostname == "m.sohu.com"
            or query.get("pageType") == ["report"]
        )
        and (not title or title == expected_title)
    )


def requires_manual_identity_flow(category):
    return category in MANUAL_IDENTITY_CATEGORIES


def manual_identity_category_from_input(category, description=""):
    """点击选项前识别会跳转登录/材料页的侵权类举报。"""
    normalized_category = normalize_category(category)
    if normalized_category:
        option, _, score = best_match(
            normalized_category, list(REPORT_CATEGORIES), threshold=0.0
        )
        if option in MANUAL_IDENTITY_CATEGORIES and score >= 0.80:
            return option
        return None

    option, _, score = best_match(
        description, list(REPORT_CATEGORIES), threshold=0.0
    )
    if option in MANUAL_IDENTITY_CATEGORIES and score >= 0.65:
        return option
    return None


def is_anonymous_upload_state(body_text):
    return ANONYMOUS_UPLOAD_TEXT in str(body_text or "")


def is_captcha_challenge(body_text):
    value = str(body_text or "")
    return any(marker in value for marker in (
        "请输入图中字符",
        "看不清，换一张",
        "校验超时，请重新提交",
    ))
