# -*- coding: utf-8 -*-
"""同花顺举报页的纯配置、URL 构造和输入约束。"""

from urllib.parse import quote


HOME_URL = "https://www.10jqka.com.cn/"
REPORT_CENTER_BASE = "https://eq.10jqka.com.cn/activepage/newReportPage/"
OFFICIAL_BUNDLE_PREFIX = (
    "//s.thsi.cn/cd/iwc-robot-activepage-container/static/"
    "newReportPage/static/index-"
)
LOGIN_HOST = "upass.10jqka.com.cn"
REPORT_ENTRY_TEXT = "违法和不良信息"

PRIMARY_REASON_SELECTOR = ".option-item .option-title"
PRIMARY_OPTION_SELECTOR = ".option-item"
STEP_BUTTON_SELECTOR = "button.submit-button"
DETAIL_REASON_SELECTOR = ".reason-list .reason-item-text"
ADD_LINK_SELECTOR = ".add-link-btn"
LINK_INPUT_SELECTOR = "input.dialog-input"
LINK_CONFIRM_SELECTOR = "button.confirm-btn"
DETAIL_TEXTAREA_SELECTOR = "textarea.report_input"
UPLOAD_INPUT_SELECTOR = ".image-upload-container input[type='file']"
UPLOAD_SUCCESS_SELECTOR = ".image-item img.preview"
FINAL_SUBMIT_TEXT = "确认提交"
SUCCESS_XPATH = "//*[contains(text(), '提交成功，我们将尽快受理')]"

DESCRIPTION_MIN_LENGTH = 10
DESCRIPTION_MAX_LENGTH = 140
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 5 * 1024 * 1024

PRIMARY_CATEGORIES = (
    "政治敏感",
    "涉嫌广告",
    "恶意灌水",
    "低俗色情",
    "涉网络暴力",
    "非法荐股",
    "虚假不实信息",
    "侵犯肖像、隐私、名誉等",
    "涉企侵权",
    "涉AI内容侵权",
    "涉青少年有害信息",
    "其他",
)

DETAIL_CATEGORIES = (
    "无执业资质",
    "假冒专家荐股",
    "软件荐股欺诈",
    "群聊诱导荐股",
    "虚假新闻",
    "假冒组织",
    "假冒名人",
    "伪造数据",
    "涉网络开盒",
    "内容抄袭",
    "侮辱谩骂",
    "谣言诽谤",
    "侵犯个人隐私",
    "商誉诋毁",
    "涉嫌泄密",
    "谣言虚假",
    "人身攻击",
    "未添加AI标识",
    "不实信息",
    "政治敏感",
    "侵犯权益",
    "色情低俗",
    "其他",
)

SUBMIT_ENDPOINT_GLOB = "**/gateway/mbweb-lgt/auth/api/v2/report/submit*"
UPLOAD_ENDPOINT_GLOB = "**/gateway/sns-space-upload/newupload/upload/**"


def build_report_url(article_url):
    """把文章链接放到 hash 路由之前，供页面的查询参数解析器读取。"""
    encoded = quote(str(article_url or "").strip(), safe="")
    return f"{REPORT_CENTER_BASE}?jump_url={encoded}#/"


def prepare_description(value):
    """清洗并按同花顺普通举报详情页的 140 字限制截断描述。"""
    return str(value or "").strip()[:DESCRIPTION_MAX_LENGTH]


def description_is_valid(value):
    return len(prepare_description(value)) >= DESCRIPTION_MIN_LENGTH


def is_login_url(url):
    """判断同花顺举报中心是否已转到统一登录站。"""
    return LOGIN_HOST in str(url or "").lower()


def is_access_forbidden_page(url="", title="", body_text=""):
    """识别同花顺登录域明确拒绝访问的页面，不把它误报成普通未登录。"""
    if not is_login_url(url):
        return False
    value = " ".join((str(title or ""), str(body_text or ""))).lower()
    return any(marker in value for marker in (
        "nginx forbidden",
        "403 forbidden",
        "access denied",
        "访问被拒绝",
    ))
