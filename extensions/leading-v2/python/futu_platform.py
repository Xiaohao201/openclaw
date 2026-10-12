# -*- coding: utf-8 -*-
"""富途牛牛“牛牛圈”帖子举报配置、地址解析与安全约束（导入无副作用）。"""

import re
from urllib.parse import urlparse


HOME_URL = "https://www.futunn.com/"
COMMUNITY_HOME_URL = "https://q.futunn.com/"
REPORT_GUIDE_URL = (
    "https://q.futunn.com/feed/115404447941012?lang=zh-cn"
)
COMMUNITY_RULES_URL = "https://support.futunn.com/topic273/"

DETAIL_BUNDLE_URL = (
    "https://cdn.futustatic.com/sns-nnq/assets/index-BQEYVxyF.js"
)
REPORT_COMPONENT_URL = (
    "https://cdn.futustatic.com/sns-nnq/assets/"
    "Report.vue_vue_type_style_index_0_lang-BlzBTy6g.js"
)
REPORT_LOGIC_BUNDLE_URL = (
    "https://cdn.futustatic.com/sns-nnq/assets/useReport-DoXbU54W.js"
)
MORE_BUNDLE_URL = (
    "https://cdn.futustatic.com/sns-nnq/assets/More-PZhBZV_o.js"
)
UPLOAD_HELPER_BUNDLE_URL = (
    "https://cdn.futustatic.com/sns-nnq/assets/"
    "CosUpload.vue_vue_type_style_index_0_scoped_f83d42c2_lang-Cj-c-ieY.js"
)

REPORT_MORE_SELECTOR = ".sns-operate-more"
REPORT_MENU_SELECTOR = ".sns-operate-more-wrapper"
REPORT_ENTRY_SELECTOR = "[data-rep-click-Report]"
REPORT_DIALOG_SELECTOR = ".report-dialog"
REPORT_OPTIONS_SELECTOR = (
    ".report-dialog .sns-operate-items__item-title"
)
SELECTED_REASON_SELECTOR = (
    ".report-dialog .sns-operate-items__item-selected "
    ".sns-operate-items__item-title"
)
INPUT_CONTENT_SELECTOR = ".sns-operate-input"
TEXTAREA_SELECTOR = ".sns-operate-input textarea"
UPLOAD_INPUT_SELECTOR = ".sns-operate-input input[type='file']"
UPLOAD_SUCCESS_SELECTOR = (
    ".sns-operate-input .cos-upload-preview-item"
    ":not(.failed-item):not(.loading-item)"
)
SUBMIT_SELECTOR = (
    ".moo-dialog__box--visible .moo-dialog__footer "
    ".moo-button:last-child"
)
SUCCESS_XPATH = (
    "//*[contains(text(), '举报已提交') or "
    "contains(text(), '举报成功') or "
    "contains(text(), '已收到您的举报')]"
)

REPORT_TYPES_PATH = "/v2/api/sns/get-content-report-type-list"
REPORT_TYPES_URL = COMMUNITY_HOME_URL.rstrip("/") + REPORT_TYPES_PATH
AUTHENTICATED_RESPONSE_CODE = 0
NOT_LOGIN_RESPONSE_CODE = 10888
SUBMIT_ENDPOINT_PATH = "/v2/api/sns/content-report"
SUBMIT_ENDPOINT_GLOB = "**/v2/api/sns/content-report*"
UPLOAD_ENDPOINT_GLOBS = (
    "**/v2/api/get-cos-credential*",
    "**/v2/api/sign-urls*",
)

LOGIN_REQUIRED = True
DESCRIPTION_LIMIT_UNITS = 400
MAX_IMAGES = 6
MAX_IMAGE_BYTES = 30 * 1024 * 1024

# value 与官方前端 ReportType 枚举及当前默认举报列表一致。
REPORT_REASONS = (
    (5, "不友善", False),
    (6, "股托", False),
    (3, "政治", False),
    (2, "广告", False),
    (1, "色情暴力", False),
    (7, "不实信息", True),
    (8, "涉嫌侵权", True),
    (0, "其他", True),
)
REPORT_CATEGORIES = tuple(label for _, label, _ in REPORT_REASONS)
REPORT_TYPE_BY_CATEGORY = {
    label: report_type for report_type, label, _ in REPORT_REASONS
}
EXTRA_INFO_CATEGORIES = tuple(
    label for _, label, need_input in REPORT_REASONS if need_input
)

_FEED_RE = re.compile(
    r"^/(?:(?:hk|en|ja|th)/)?feed/(?:[^/?#]+-)?(\d+)/?$",
    re.I,
)
_DOUBLE_WIDTH_PUNCTUATION = frozenset(
    "。？！？，、；：“”‘’（）《》〈〉【】『』「」﹃﹄〔〕…—～﹏￥｜"
)

# 富途新页面会把登录字段包装成含循环引用的响应式对象，直接从
# page.evaluate 返回给 Python 会触发 Playwright 序列化异常。帖子页这里只返回
# 在浏览器内转换好的普通字符串和布尔值；登录状态由只读接口单独确认。
REPORT_PAGE_STATE_SCRIPT = """
    () => {
        const state = window.__INITIAL_STATE__;
        const feed = state && state.detail && state.detail.feedCommon;
        let feedId = '';
        try {
            feedId = String((feed && feed.feedId) || '');
        } catch (error) {
            feedId = '';
        }
        return {
            feedId,
            canReport: Boolean(
                feed && feed.accessPermission &&
                feed.accessPermission.report === true
            )
        };
    }
"""


def _is_futu_community_host(hostname):
    return str(hostname or "").lower() == "q.futunn.com"


def extract_feed_id(url):
    """从富途牛牛圈帖子地址提取 feedId；非帖子或非富途域名返回空串。"""
    parsed = urlparse(str(url or ""))
    if not _is_futu_community_host(parsed.hostname):
        return ""
    match = _FEED_RE.match(parsed.path)
    return match.group(1) if match else ""


def is_feed_url(url, expected_feed_id=""):
    feed_id = extract_feed_id(url)
    return bool(
        feed_id and
        (not expected_feed_id or str(expected_feed_id) == feed_id)
    )


def is_logged_in_state(user_id, is_login):
    """页面 uid 必须为正整数且 isLogin 严格为真，才视为登录。"""
    try:
        valid_uid = int(user_id) > 0
    except (TypeError, ValueError):
        valid_uid = False
    return valid_uid and is_login is True


def is_authenticated_report_types_response(response_ok, payload):
    """举报原因只读接口 HTTP 正常且明确返回 code=0 才视为已登录。"""
    if response_ok is not True or not isinstance(payload, dict):
        return False
    code = payload.get("code")
    return type(code) is int and code == AUTHENTICATED_RESPONSE_CODE


def is_explicit_not_login_response(payload):
    """识别富途接口明确的未登录响应，避免把它当成瞬时网络错误重试。"""
    if not isinstance(payload, dict):
        return False
    code = payload.get("code")
    return type(code) is int and code == NOT_LOGIN_RESPONSE_CODE


def normalize_option_text(value):
    return " ".join(str(value or "").split())


def report_type_for_category(category):
    return REPORT_TYPE_BY_CATEGORY.get(normalize_option_text(category))


def needs_extra_info(category):
    return normalize_option_text(category) in EXTRA_INFO_CATEGORIES


def _description_char_units(char):
    codepoint = ord(char)
    is_unified_ideograph = (
        0x3400 <= codepoint <= 0x4DBF or
        0x4E00 <= codepoint <= 0x9FFF or
        0xF900 <= codepoint <= 0xFAFF or
        0x20000 <= codepoint <= 0x323AF
    )
    return 2 if is_unified_ideograph or char in _DOUBLE_WIDTH_PUNCTUATION else 1


def description_units(value):
    return sum(_description_char_units(char) for char in str(value or ""))


def prepare_description(value):
    """按官方前端 400 加权单位限制截断；汉字和中文标点按 2 单位计算。"""
    result = []
    used = 0
    for char in str(value or "").strip():
        units = _description_char_units(char)
        if used + units > DESCRIPTION_LIMIT_UNITS:
            break
        result.append(char)
        used += units
    return "".join(result)


def has_detail_bundle_contract(source):
    value = str(source or "")
    return all(marker in value for marker in (
        'report:"/sns/content-report"',
        'getContentReportTypeList:"/sns/get-content-report-type-list"',
        'getUserReportTypeList:"/sns/get-user-report-type-list"',
        'opFuncs',
    ))


def has_report_component_contract(source):
    value = str(source or "")
    return all(marker in value for marker in (
        'dialog-class":"report-dialog"',
        'reportReason',
        'reportImgs',
        'feedId',
        'reportType',
    ))


def has_report_logic_contract(source):
    value = str(source or "")
    return all(marker in value for marker in (
        'limit:400',
        'ot(a,30)',
        'max-file-num',
        'reportReason',
        'reportImgs',
    ))


def has_more_menu_contract(source):
    value = str(source or "")
    return all(marker in value for marker in (
        '__name:"More"',
        'opFuncs',
        '.report',
        'onReport',
    ))
