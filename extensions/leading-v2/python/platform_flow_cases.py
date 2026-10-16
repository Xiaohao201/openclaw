"""Synthetic page contracts for every enabled direct web platform."""

from dataclasses import dataclass
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import eastmoney_platform as eastmoney
import futu_platform as futu
import netease_platform as netease
import sina_platform as sina
import sohu_platform as sohu
import tencent_platform as tencent
import tiantianfund_platform as tiantianfund
import yidian_platform as yidian
from platform_flow_fakes import Element, Page, role_key, text_key


SUCCESS = "//*[contains(text(), '提交成功')]"
REASON = "不实信息"


@dataclass
class Case:
    platform: str
    variant: str
    url: str

    @property
    def name(self):
        return self.platform + ":" + self.variant


CASES = (
    Case("xiaohongshu", "web", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567"),
    Case("douyin", "video", "https://www.douyin.com/video/1234567890123456789"),
    Case("douyin", "note", "https://www.douyin.com/note/1234567890123456789"),
    Case("douyin", "jingxuan", "https://www.douyin.com/jingxuan?modal_id=1234567890123456789"),
    Case("kuaishou", "video", "https://www.kuaishou.com/short-video/test-fixture"),
    Case("kuaishou", "new-reco", "https://www.kuaishou.com/new-reco/test-fixture"),
    Case("bilibili", "video", "https://www.bilibili.com/video/BV1testfixture"),
    Case("bilibili", "article", "https://www.bilibili.com/opus/123456"),
    Case("baidu", "article", "https://baijiahao.baidu.com/s?id=123456"),
    Case("baidu", "video", "https://www.baidu.com/video/123456"),
    Case("toutiao", "article", "https://www.toutiao.com/article/123456/"),
    Case("toutiao", "video", "https://www.toutiao.com/video/123456/"),
    Case("zhihu", "answer", "https://www.zhihu.com/question/123/answer/456"),
    Case("zhihu", "article", "https://zhuanlan.zhihu.com/p/123456"),
    Case("weibo", "popup", "https://weibo.com/123456/testfixture"),
    Case("netease", "popup", "https://www.163.com/dy/article/TESTFIXTURE.html"),
    Case("netease", "same-tab", "https://www.163.com/dy/article/TESTFIXTURE.html"),
    Case("eastmoney", "popup", "https://finance.eastmoney.com/a/123456.html"),
    Case("eastmoney", "same-tab", "https://finance.eastmoney.com/a/123456.html"),
    Case("tiantianfund", "redirect-popup", "https://fund.eastmoney.com/ba/news,of000001,123456.html"),
    Case("tencent", "article", "https://news.qq.com/rain/a/TESTFIXTURE"),
    Case("futu", "feed", "https://q.futunn.com/feed/123456789012345"),
    Case("futu", "extra-info", "https://q.futunn.com/feed/123456789012345"),
    Case("sina", "article", "https://news.sina.com.cn/c/2026-01-01/doc-imtest123456.shtml"),
    Case("sina", "community", "https://super.sina.cn/shequn/post/detail_123456.html"),
    Case("sohu", "desktop", "https://www.sohu.com/a/123456_654321"),
    Case("sohu", "mobile", "https://m.sohu.com/a/123456_654321"),
    Case("yidianzixun", "article", "https://www.yidianzixun.com/article/TESTFIXTURE"),
)


def build_case(case, receipt=True):
    page = Page()
    page.state.receipt = receipt
    form = page
    category = REASON
    description = None
    success = SUCCESS
    entry = final = options = None
    selected = None
    relative = None
    is_popup = case.variant in ("popup", "redirect-popup", "desktop", "mobile")
    if is_popup:
        form = Page(page.state)
        form.context = page.context
        page.popup = form

    if case.platform == "xiaohongshu":
        page.add('body', '普通正文')
        page.add('.reds-icon.more')
        page.add(text_key('下一步'), stage=2)
        entry = text_key('举报')
        options = '//div[contains(@class, "list-select-item-option")]'
        description = "//textarea[@class='advice-input']"
        final = text_key('提交')
    elif case.platform == "douyin":
        page.add('[data-e2e="video-play-more"]')
        entry = text_key("举报")
        options = "xpath=//*[contains(text(),'举报原因')]/following::span"
        relative = "xpath=preceding-sibling::div[1]"
        description = 'xpath=//*[contains(text(),"举报描述")]/following::textarea[1]'
        final = text_key("提交")
    elif case.platform == "kuaishou":
        if case.variant == "new-reco":
            page.add("(//img[@class='more-img'])[1]")
            entry = "//div[@class='more-item report']"
        else:
            entry = "//span[@class='item-text' and text() = '举报']"
        options = f"//div[contains(text(),'{category}')]/ancestor::div[@class='report-item-list-item']//label[@class='pl-radio']"
        description = "//textarea[contains(@placeholder,'请描述举报理由')]"
        final = "//button[contains(text(),'提交')]"
    elif case.platform == "bilibili":
        if case.variant == "video":
            page.add("//span[@class='video-tool-more-reference']")
            entry = "//span[text()='稿件举报']"
            form = Page(page.state)
            page.add('iframe[name="appeal"]', stage=1, frame=form)
            options = text_key(category)
            description = role_key("textbox", "详细描述 * 0/")
            final = text_key("提交")
        else:
            page.add(".bili-dyn-more")
            entry = text_key("举报")
            options = f"//span[contains(text(),'{category}')]"
            description = "//textarea[@class='bili-dyn-report__remark__field']"
            final = text_key("确定")
    elif case.platform == "baidu":
        entry = ("(//span[contains(text(),'举报')])[1]" if case.variant == "video"
                 else "//span[@data-testid='report-btn']")
        options = "//label"
        description = "//textarea[@id='fb_des_content']"
        final = text_key("提交反馈")
    elif case.platform == "toutiao":
        if case.variant == "video":
            page.add("//button[@aria-label='更多']//*[name()='svg']")
            entry = "//button[contains(text(),'举报')]//i[@class='icon']//*[name()='svg']"
            description = "//textarea[@placeholder='请描述你遇到的问题']"
        else:
            entry = "//div[@class='detail-report']//i"
        options = "//label"
        final = text_key("确认")
        success = "//*[contains(text(), '反馈成功')]"
    elif case.platform == "zhihu":
        page.add("(//div[@class='Popover ContentItem-action']//button)[1]" if case.variant == "answer"
                 else "//div[@class='Post-ActionMenuButton']//button")
        entry = "//button[contains(text(),'举报')]"
        options = f"//div[contains(text(),'{category}')]"
        description = '//textarea[@name="customReason"]'
        final = "//button[contains(text(),'提交举报')]"
    elif case.platform == "weibo":
        page.add("//i[@title='更多']")
        entry = '//div[@role="button" and .//div[text()="投诉"]]'
        form.add("//h4[text()='侵权投诉专区']", stage=1)
        options = "//a"
        description = "//textarea[contains(@placeholder,'请详细填写')]"
        form.add("//input[@name='chk']", stage=2)
        final = "//a[contains(text(),'提交')]"
    elif case.platform in ("netease", "eastmoney", "tiantianfund"):
        module = {"netease": netease, "eastmoney": eastmoney,
                  "tiantianfund": tiantianfund}[case.platform]
        entry = (module.REPORT_ENTRY_SELECTOR if case.platform == "tiantianfund"
                 else module.REPORT_ENTRY_SELECTORS[0])
        options = module.REASON_OPTIONS_SELECTOR
        category = module.REPORT_CATEGORIES[0]
        description = module.TEXTAREA_SELECTOR
        success = module.SUCCESS_XPATH
        if case.platform == "netease":
            final = role_key("button", "提交")
            form.add(text_key(module.REPORT_HEADING), stage=1)
            selected = module.SELECTED_REASON_SELECTOR
        else:
            final = module.SUBMIT_SELECTOR
        if case.platform == "tiantianfund":
            page.redirects[case.url] = "https://guba.eastmoney.com/news,of000001,123456.html"
            form.url = module.REPORT_CENTER_URL + "?reportType=3&systype=1&replyid=0&gubaCode=000001&id=123456"
    elif case.platform == "tencent":
        page.add(tencent.LOGGED_IN_SELECTOR)
        entry = tencent.REPORT_ENTRY_SELECTOR
        form.add(text_key(tencent.REPORT_MODAL_TITLE), stage=1)
        options = tencent.REASON_OPTIONS_SELECTOR
        category = tencent.REPORT_CATEGORIES[0]
        final = text_key(tencent.SUBMIT_TEXT)
        success = tencent.SUCCESS_XPATH
    elif case.platform == "futu":
        page.scripts["() => Boolean(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.common && window.__INITIAL_STATE__.detail)"] = True
        page.scripts[futu.REPORT_PAGE_STATE_SCRIPT] = dict(feedId="123456789012345", canReport=True)
        def auth_response(url, **kwargs):
            if url != futu.REPORT_TYPES_URL:
                raise AssertionError("Unexpected read-only request")
            return SimpleNamespace(status=200, ok=True, json=lambda: {"code": 0})
        page.request = SimpleNamespace(get=auth_response)
        entry = futu.REPORT_ENTRY_SELECTOR
        form.add(futu.REPORT_DIALOG_SELECTOR, stage=1)
        options = futu.REPORT_OPTIONS_SELECTOR
        category = futu.REPORT_CATEGORIES[0]
        selected = futu.SELECTED_REASON_SELECTOR
        if case.variant == "extra-info":
            form.add(futu.INPUT_CONTENT_SELECTOR, stage=2)
            description = futu.TEXTAREA_SELECTOR
        final, success = futu.SUBMIT_SELECTOR, futu.SUCCESS_XPATH
    elif case.platform == "sina":
        if case.variant == "community":
            feedback = "https://sinanews.sina.cn/activities/feedback.d.html?" + urlencode(dict(
                type="tiezi", docId="HB-1-discovery_hot_doc/hot_community-123456-tiezi",
                dataid="tiezi:123456", wapUrl=case.url))
            page.add("script:not([src])", json.dumps({"feedback": {"link": feedback}}))
            page.page_title = sina.COMMUNITY_FEEDBACK_PAGE_TITLE
            form.add(sina.COMMUNITY_FORM_SELECTOR, stage=1)
            options, selected = sina.COMMUNITY_REPORT_OPTIONS_SELECTOR, sina.COMMUNITY_SELECTED_REASON_SELECTOR
            description = sina.COMMUNITY_TEXTAREA_SELECTOR
            category = sina.COMMUNITY_REPORT_CATEGORIES[0]
            final, success = sina.COMMUNITY_SUBMIT_SELECTOR, sina.COMMUNITY_SUCCESS_XPATH
        else:
            page.page_title = sina.REPORT_PAGE_TITLE
            form.add(sina.FORM_SELECTOR, stage=1)
            page.scripts["() => Boolean(window.SINA_OUTLOGIN_LAYER && window.SINA_OUTLOGIN_LAYER.isLogin())"] = True
            options, selected = sina.REPORT_OPTIONS_SELECTOR, sina.SELECTED_REASON_SELECTOR
            category = sina.REPORT_CATEGORIES[0]
            final, success = sina.SUBMIT_SELECTOR, sina.SUCCESS_XPATH
    elif case.platform == "sohu":
        entry = sohu.REPORT_ENTRY_SELECTOR
        if case.variant == "mobile":
            page.add(sohu.MOBILE_MORE_SELECTOR)
            entry = sohu.MOBILE_REPORT_ENTRY_SELECTOR
        form.url = ("https://m.sohu.com" if case.variant == "mobile" else "https://www.sohu.com") + "/feedback?" + urlencode(dict(articleUrl=case.url, pageType="report"))
        form.page_title = sohu.MOBILE_REPORT_PAGE_TITLE if case.variant == "mobile" else sohu.REPORT_PAGE_TITLE
        form.add(text_key(sohu.REPORT_HEADING), stage=1)
        options, selected = sohu.REASON_OPTIONS_SELECTOR, sohu.SELECTED_REASON_SELECTOR
        category = "标题党"
        description = sohu.TEXTAREA_SELECTOR
        final, success = sohu.SUBMIT_SELECTOR, sohu.SUCCESS_XPATH
        form.add("body", "内容举报", stage=1)
    elif case.platform == "yidianzixun":
        page.add(yidian.REPORT_FORM_SELECTOR)
        page.scripts["() => Boolean(window.yidian && window.yidian.docinfo)"] = True
        page.scripts['''
                () => ({
                    docid: window.yidian.docinfo.doc &&
                        window.yidian.docinfo.doc.docid,
                    isLogin: window.yidian.docinfo.is_login
                })
            '''] = dict(docid="TESTFIXTURE", isLogin=True)
        page.scripts["() => window.yidian && window.yidian.docinfo && window.yidian.docinfo.is_login"] = True
        entry = yidian.REPORT_ENTRY_SELECTOR
        form.add(yidian.REPORT_POPUP_SELECTOR, stage=1)
        options, selected = yidian.REPORT_OPTIONS_SELECTOR, yidian.SELECTED_REASON_SELECTOR
        category = yidian.REPORT_CATEGORIES[0]
        final, success = yidian.SUBMIT_SELECTOR, yidian.SUCCESS_XPATH
    else:
        raise AssertionError(f"Uncovered platform: {case.platform}")

    if entry is not None:
        page.add(entry, "举报", action=page.open_form, attrs={"href": form.url})
    choice = form.add(options, category, stage=1, action=form.choose)
    if case.platform == "douyin":
        # At least two options prevent the handler taking its broad-span fallback.
        choice.children[relative] = [Element(text=category, stage=1, action=form.choose)]
        form.nodes[options].append(Element(text="其他", stage=1))
    if selected:
        node = form.add(selected, category, stage=2)
        node.children["xpath=.."] = [Element(text=category, stage=2)]
    if description:
        form.add(description, stage=2)
    form.add(final, "提交", stage=2, action=form.submit,
             attrs={"class": sina.COMMUNITY_READY_SUBMIT_CLASS})
    (page if case.platform == "bilibili" else form).receipt(success)
    return SimpleNamespace(case=case, page=page, form=form, entry=entry,
                           options=options, final=final, selected=selected,
                           description=description, category=category)
