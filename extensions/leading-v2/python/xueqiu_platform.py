# -*- coding: utf-8 -*-
"""雪球帖子投诉弹窗的纯配置与输入约束（导入时无副作用）。"""


HOME_URL = "https://xueqiu.com/"
REPORT_GUIDE_URL = "https://xueqiu.com/4226803442/215770207"
REPORT_ENTRY_SELECTOR = "a.btn-report-spam"
REPORT_MODAL_SELECTOR = ".confirm--report"
REPORT_TITLE_SELECTOR = ".confirm--report .modal__confirm__hd"
REPORT_TITLE = "投诉"
LOGIN_PROMPT_TEXT = "立即登录/注册"

PRIMARY_REASON_SELECTOR = (
    "//*[contains(@class,'confirm--report')]"
    "//*[normalize-space()='投诉原因']/following-sibling::div"
    "[contains(@class,'tags')][1]/div[contains(@class,'tagStyle')]"
)
SECONDARY_REASON_SELECTOR = (
    "//*[contains(@class,'confirm--report')]"
    "//*[normalize-space()='详细内容']/following-sibling::div"
    "[contains(@class,'tags')][1]/div[contains(@class,'tagStyle')]"
)
SELECTED_PRIMARY_SELECTOR = (
    "//*[contains(@class,'confirm--report')]"
    "//*[normalize-space()='投诉原因']/following-sibling::div"
    "[contains(@class,'tags')][1]/div"
    "[contains(@class,'tagStyle') and contains(@class,'clickTagStyle')]"
)
SELECTED_SECONDARY_SELECTOR = (
    "//*[contains(@class,'confirm--report')]"
    "//*[normalize-space()='详细内容']/following-sibling::div"
    "[contains(@class,'tags')][1]/div"
    "[contains(@class,'tagStyle') and contains(@class,'clickTagStyle')]"
)
TEXTAREA_SELECTOR = ".confirm--report textarea.inputStyle"
UPLOAD_INPUT_SELECTOR = ".confirm--report input[type='file']"
UPLOAD_SUCCESS_SELECTOR = ".confirm--report .img_list"
SUBMIT_SELECTOR = ".confirm--report .modal__confirm__submit"
SUCCESS_XPATH = "//*[contains(text(), '您的投诉已提交，我们会认真处理您的投诉')]"

REPORT_TYPES_URL = (
    "https://xueqiu.com/riskcontrol/report/getReportTypes.json?content_type=0"
)
COMMON_BUNDLE_URL = (
    "https://assets.imedao.com/ugc/js/vue-common-76b5f8ea0e.js"
)
ARTICLE_BUNDLE_URL = (
    "https://assets.imedao.com/ugc/js/vue-article-6c984d0e50.js"
)

SUBMIT_ENDPOINT_GLOB = "**/reportspam/create.json*"
UPLOAD_ENDPOINT_GLOBS = (
    "**/reportspam/uploadPic.json*",
    "**/riskcontrol/report/infringement/image/upload.json*",
)

DESCRIPTION_MAX_LENGTH = 300
MAX_FILES = 3
MAX_FILE_BYTES = 10 * 1024 * 1024

PRIMARY_CATEGORIES = (
    "时政有害",
    "非法荐股",
    "广告营销",
    "涉企侵权",
    "其他侵权（非涉企）",
    "造谣传谣",
    "辱骂引战",
    "财经类信息违规",
    "色情低俗",
    "恶意蹭流量",
    "低质不相关内容",
    "其他违法违规",
)

SECONDARY_CATEGORIES = {
    "涉企侵权": (
        "谣言类",
        "侮辱类",
        "侵犯企业家隐私",
        "泄露商业秘密",
        "其他恶意干扰经营",
    ),
    "其他侵权（非涉企）": (
        "网络暴力",
        "抄袭洗稿",
        "侵犯个人隐私",
        "侵犯个人名誉",
        "其他侵权",
    ),
    "财经类信息违规": (
        "恶意曲解政策",
        "炒作恶性事件",
        "外媒抹黑倒灌",
        "其他财经违规",
    ),
    "其他违法违规": (
        "侵害未成年人权益",
        "历史虚无主义",
        "算法推荐违规",
        "其他",
    ),
}

MANUAL_INFRINGEMENT_CATEGORIES = (
    "涉企侵权",
    "其他侵权（非涉企）",
)
DESCRIPTION_REQUIRED_PRIMARY = (
    "非法荐股",
    "造谣传谣",
)
DESCRIPTION_REQUIRED_SECONDARY = (
    "侵害未成年人权益",
    "历史虚无主义",
    "算法推荐违规",
    "其他",
)


def prepare_description(value):
    """清洗并按雪球普通投诉弹窗的 300 字限制截断描述。"""
    return str(value or "").strip()[:DESCRIPTION_MAX_LENGTH]


def is_logged_in_user_id(user_id):
    """雪球页面以 ``window.SNOWMAN_USER.id`` 表示当前账号。"""
    return str(user_id or "").strip().lower() not in {"", "0", "none", "null"}


def is_verification_page(url="", title="", body_text=""):
    """识别雪球/阿里云反自动化验证页，不尝试绕过验证码。"""
    value = " ".join((str(url or ""), str(title or ""), str(body_text or "")))
    return any(marker in value for marker in (
        "/service/captcha",
        "alichlgref=",
        "滑动验证页面",
        "访问验证",
        "雪球验证页面",
        "请完成验证",
        "请按住滑块",
    ))


def primary_categories_from_payload(payload):
    return tuple(item["name"] for item in payload["data"])


def secondary_categories_from_payload(payload):
    return {
        item["name"]: tuple(child["name"] for child in item.get("second", ()))
        for item in payload["data"]
        if item.get("second")
    }


def description_required(primary, secondary=""):
    return (
        primary in DESCRIPTION_REQUIRED_PRIMARY or
        secondary in DESCRIPTION_REQUIRED_SECONDARY
    )


def requires_manual_infringement(primary):
    return primary in MANUAL_INFRINGEMENT_CATEGORIES
