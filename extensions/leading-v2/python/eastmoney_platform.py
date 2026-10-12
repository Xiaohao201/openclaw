# -*- coding: utf-8 -*-
"""东方财富举报页的纯配置与输入约束（导入时无浏览器/数据库副作用）。"""


HOME_URL = "https://www.eastmoney.com/"
REPORT_CENTER_URL = "https://help.eastmoney.com/report_center.html"
OFFICIAL_BUNDLE_URL = "https://gbfek.dfcfw.com/deploy/help_web/work/report_center.js"
LOGIN_HOST = "passport2.eastmoney.com"

REPORT_ENTRY_SELECTORS = (
    "a.jubao",
    "a[href*='help.eastmoney.com/report_center.html']",
    "//a[normalize-space()='举报']",
)
REASON_OPTIONS_SELECTOR = ".reportTypeList label.typeText"
SELECTED_REASON_INPUT_SELECTOR = "input[name='report_art']:checked"
TEXTAREA_SELECTOR = ".reportDescription textarea.desTextarea"
UPLOAD_INPUT_SELECTOR = "input[type='file'][name='uploadfile'], #absFileInput"
UPLOAD_SUCCESS_SELECTOR = ".reportMaterials .upload_proof img"
SUBMIT_SELECTOR = "#confirmBtn"
SUCCESS_XPATH = "//*[contains(text(), '您的举报已提交，我们将尽快处理')]"

# 页面 textarea 标记 maxlength=500，但当前提交脚本按 300 字校验。
DESCRIPTION_MAX_LENGTH = 300
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 5 * 1024 * 1024

REPORT_CATEGORIES = (
    "广告",
    "色情低俗",
    "恶意灌水",
    "谣言",
    "涉未成年人有害信息",
    "涉互联网算法推荐",
    "AI生成虚假信息",
    "涉网络暴力（人身攻击）",
    "电信诈骗",
    "违规开展互联网新闻信息服务",
)

# Playwright 路由 glob。测试会全部安装；只要误触最终按钮，请求就会被 abort 并记为失败。
SUBMIT_ENDPOINT_GLOBS = (
    "**/*Common/Report*",
    "**/*Common%2FReport*",
)


def prepare_description(value):
    """按东方财富脚本的 300 字限制清洗举报描述。"""
    return str(value or "").strip()[:DESCRIPTION_MAX_LENGTH]


def is_login_url(url):
    """判断页面是否已被东方财富举报中心转到登录站。"""
    return LOGIN_HOST in str(url or "").lower()
