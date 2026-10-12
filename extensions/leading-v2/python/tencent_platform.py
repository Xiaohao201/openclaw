# -*- coding: utf-8 -*-
"""腾讯新闻文章举报弹窗的纯配置（导入时无浏览器/数据库副作用）。"""

import re


HOME_URL = "https://news.qq.com/"
REPORT_ENTRY_SELECTOR = "a.report"
LOGIN_CONTAINER_SELECTOR = "#qqcom-login"
LOGIN_BUTTON_SELECTOR = "#qqcom-login .login-button"
LOGGED_IN_SELECTOR = "#qqcom-login.qqcon-islogin"

REPORT_MODAL_TITLE = "举报文章"
REPORT_TIPS = "请选择举报原因"
REASON_OPTIONS_SELECTOR = (
    "//*[normalize-space()='请选择举报原因']/following-sibling::div"
    "[not(.//*[normalize-space()='提交'])]"
)
SUBMIT_TEXT = "提交"
SUCCESS_XPATH = "//*[contains(text(), '举报成功')]"

# 真实提交接口。真实页面测试会在网络层硬拦截此请求，且绝不点击最终提交按钮。
SUBMIT_ENDPOINT_GLOB = "**/reportInvalid*"
SUBMIT_ENDPOINT_FRAGMENT = "reportInvalid?apptype=web"

# 腾讯新闻 PC 文章页的主脚本；真实页面测试会从页面读取实际版本 URL。
OFFICIAL_BUNDLE_SELECTOR = (
    "script[src*='common-static/hel/qqnews-pc-dc_']"
    "[src$='/static/js/static.js']"
)
OFFICIAL_BUNDLE_GLOB = (
    "**/common-static/hel/qqnews-pc-dc_*/static/js/static.js"
)
ARTICLE_REPORT_MARKER = 'className:"report"'
_LOGIN_GUARD_RE = re.compile(r"[A-Za-z_$][\w$]*\.checkLogin\(!0\)&&")

CONFIG_URL = (
    "https://i.news.qq.com/i/getONSDict"
    "?wuji_appid=news_h5"
    "&wuji_appkey=9c25e5f15027451bb4ab856c030007cb"
    "&query_key=feedback"
)

REPORT_CATEGORIES = (
    "涉嫌违法违规",
    "仿冒官方机构、新闻媒体等",
    "色情低俗",
    "广告营销",
    "内容不实",
    "恐怖恶心",
    "内容过时",
    "内容质量差",
    "未成年人不良内容",
    "标题夸张／文不对题",
    "内容格式有误",
    "错别字",
    "历史虚无主义",
    "体育饭圈",
    "虚假摆拍演绎",
)


def is_logged_in_state(logged_in_panel_visible, login_button_visible):
    """按腾讯顶部账号区状态做保守登录判断。"""
    return bool(logged_in_panel_visible and not login_button_visible)


def article_categories_from_config(payload):
    """从腾讯公开反馈字典响应中提取文章举报类别。"""
    entries = payload["data"]["feedback"]["data"]
    return tuple(
        item["text"] for item in entries if str(item.get("type")) == "0"
    )


def expose_article_report_modal(source):
    """仅移除文章举报入口的前端登录守卫，供禁止提交的页面测试渲染弹窗。"""
    marker_index = source.find(ARTICLE_REPORT_MARKER)
    if marker_index < 0:
        raise ValueError("腾讯官网脚本中未找到文章举报入口")
    match = _LOGIN_GUARD_RE.search(source, marker_index, marker_index + 1200)
    if match is None:
        raise ValueError("腾讯官网脚本中未找到文章举报登录守卫")
    return source[:match.start()] + "!0&&" + source[match.end():]
