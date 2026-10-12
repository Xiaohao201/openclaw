# -*- coding: utf-8 -*-
"""网易举报页的纯配置与输入约束（导入时无浏览器/数据库副作用）。"""


HOME_URL = "https://www.163.com"
REPORT_URL_PREFIX = "https://www.163.com/special/0077jt/tipoff.html"
REPORT_HEADING = "举报内容"
INFRINGEMENT_CATEGORY = "涉侵权相关"
DESCRIPTION_MAX_LENGTH = 100

REPORT_ENTRY_SELECTORS = (
    "a.post_jubao",
    "//a[normalize-space()='举报']",
    "//button[normalize-space()='举报']",
    "//*[@role='button' and normalize-space()='举报']",
)
REASON_OPTIONS_SELECTOR = (
    "//div[contains(concat(' ', normalize-space(@class), ' '), "
    "' tag_code_list ')]/label"
)
SELECTED_REASON_SELECTOR = (
    "//span[contains(concat(' ', normalize-space(@class), ' '), ' m_radio ') "
    "and contains(concat(' ', normalize-space(@class), ' '), ' checked ')]"
    "/parent::label"
)
TEXTAREA_SELECTOR = (
    "//textarea[contains(@placeholder,'更多信息') or "
    "contains(@placeholder,'意见') or @maxlength='100']"
)
UPLOAD_INPUT_SELECTOR = "//input[@type='file']"
UPLOAD_SUCCESS_SELECTOR = ".el-upload-list__item.is-success"
SUBMIT_FALLBACK_SELECTOR = (
    "//button[normalize-space()='提交'] | //input[@type='submit']"
)
SUCCESS_XPATH = (
    "//*[contains(text(), '提交成功') or "
    "contains(text(), '反馈成功') or "
    "contains(text(), '您的反馈小编已收到')]"
)
SUBMIT_ENDPOINT_GLOB = "**/uc/feedback/api/v1/pc/fixError/feedback/add"

REPORT_CATEGORIES = (
    "政治反动",
    "垃圾广告",
    "网络敲诈",
    "虚假谣言",
    "民族宗教",
    "未成年相关",
    "色情低俗",
    "钓鱼诈骗",
    "恐怖恶心",
    "网络暴力",
    "算法问题",
    "涉假冒官方",
    "涉历史虚无",
    "内容质量差",
    "涉侵权相关",
    "其他",
)


def prepare_description(value):
    """按网易表单规则清洗并截断举报意见。"""
    return str(value or "").strip()[:DESCRIPTION_MAX_LENGTH]
