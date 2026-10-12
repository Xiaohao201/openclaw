from playwright.sync_api import sync_playwright, Browser, Page, BrowserContext
from config import (
    HEADLESS, PLATFORMS, UC_PLATFORMS, CHROMEDRIVER_PATH, DebugRun,
    get_base_path, MILU_PROVIDER, SELF_HEALING_ENABLED,
    SELF_HEALING_AUTO_ACTIVATE, SELF_HEALING_MODEL,
    SELF_HEALING_MAX_ATTEMPTS, SELF_HEALING_FAILURE_THRESHOLD,
    SELF_HEALING_COOLDOWN_MINUTES, SELF_HEALING_SNAPSHOT_RETENTION,
    SELF_HEALING_SNAPSHOT_DAYS,
)
import time
import os
import random
import re
from log_utils import log_message
from category_matcher import normalize_category
from complaint_payload import prepare_complaint_data
from browser_actions import check_checkbox, click_non_terminal_option
import browser_session
from network_guard import install_network_guard
from self_healing import FlowResult, SelfHealingManager
import netease_platform as netease
import eastmoney_platform as eastmoney
import tonghuashun_platform as tonghuashun
import tencent_platform as tencent
import xueqiu_platform as xueqiu
import sohu_platform as sohu
import sina_platform as sina
import yidian_platform as yidian
import tiantianfund_platform as tiantianfund
import futu_platform as futu


# 枚举“平台真实选项”时要排除的 UI 动作词——它们绝不是举报原因，若被误当成选项
# 让 best_match / milu 选中（尤其 //button、//a 这类宽选择器会把它们一起抓进来），
# 可能导致误点“确认/提交”而提前提交。统一在枚举阶段置空、从候选中剔除。
_ACTION_WORDS = {
    '取消', '确认', '确定', '提交', '提交举报', '提交反馈', '提交投诉', '完成',
    '关闭', '搜索', '登录', '注册', '关注', '换一换', '回复', '赞', '点赞',
    '下载', '更多', '首页', '反馈', '下一步', '上一步', '继续', '返回', '×',
}


class BrowserManager:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.contexts = {}  # 存储每个平台的BrowserContext
        self.pages = {}     # 存储每个平台的Page
        self.drivers = set()  # 存储已初始化的平台
        self.login_status_errors = {}
        self.errMessage = ""
        self.submission_confirmed = False
        self.last_flow_result = FlowResult.succeeded()
        self.self_healing = SelfHealingManager(
            enabled=SELF_HEALING_ENABLED,
            auto_activate=SELF_HEALING_AUTO_ACTIVATE,
            provider=MILU_PROVIDER,
            model=SELF_HEALING_MODEL,
            max_attempts=SELF_HEALING_MAX_ATTEMPTS,
            failure_threshold=SELF_HEALING_FAILURE_THRESHOLD,
            cooldown_minutes=SELF_HEALING_COOLDOWN_MINUTES,
            snapshot_retention=SELF_HEALING_SNAPSHOT_RETENTION,
            snapshot_days=SELF_HEALING_SNAPSHOT_DAYS,
            data_dir=os.path.join(get_base_path(), "data", "self_healing"),
        )
        self._init_playwright()

    def _init_playwright(self):
        """初始化Playwright"""
        if self.playwright is not None:
            return  # 已经初始化
        try:
            self.playwright = sync_playwright().start()
            log_message("Playwright初始化成功")
        except Exception as e:
            log_message(f"Playwright初始化失败: {e}", True)
            raise

    def _ensure_shared_browser(self):
        """按需启动普通平台共用的浏览器进程。"""
        if self.browser is not None:
            return
        try:
            self.browser = self.playwright.chromium.launch(
                headless=HEADLESS,
                args=list(browser_session.SHARED_BROWSER_LAUNCH_ARGS),
            )
            log_message("Playwright浏览器初始化成功")
        except Exception as e:
            log_message(f"Playwright浏览器初始化失败: {e}", True)
            raise

    def init_browsers(self, platform=None):
        """为指定平台或所有平台初始化浏览器上下文和页面"""
        # 确保Playwright已初始化
        self._init_playwright()
        platforms_to_init = [platform] if platform else PLATFORMS
        for platform in platforms_to_init:
            try:
                existing_context = self.contexts.get(platform)
                if existing_context:
                    try:
                        existing_context.close()
                    except Exception:
                        pass

                base_path = get_base_path()
                state_path = browser_session.legacy_storage_state_path(
                    base_path, platform)
                context_kwargs = browser_session.context_options(platform)

                if browser_session.uses_persistent_context(platform):
                    context, migrated_cookie_count = (
                        browser_session.launch_persistent_platform_context(
                            self.playwright, base_path, platform,
                            headless=HEADLESS,
                        )
                    )
                    if migrated_cookie_count:
                        log_message(
                            f"{platform} 已补回持久化资料目录中缺失的登录状态")
                    log_message(
                        f"{platform} 使用独立持久化浏览器会话，"
                        "登录和验证状态将在重启后保留")
                else:
                    self._ensure_shared_browser()
                    if os.path.exists(state_path):
                        context_kwargs['storage_state'] = state_path
                        log_message(
                            f"{platform} 发现状态文件，使用已保存的登录状态")
                    else:
                        log_message(
                            f"{platform} 未发现状态文件，将创建新的浏览器上下文")
                    context = self.browser.new_context(**context_kwargs)

                install_network_guard(context)
                pages = context.pages
                page = pages[0] if pages else context.new_page()

                self.contexts[platform] = context
                self.pages[platform] = page

                log_message(f"{platform} 浏览器上下文和页面初始化成功")
            except Exception as e:
                log_message(f"{platform} 浏览器上下文初始化失败: {e}", True)
                self.contexts[platform] = None
                self.pages[platform] = None

        # 更新已初始化的平台集合
        self.drivers = {p for p, ctx in self.contexts.items() if ctx is not None}
    
    def check_browser_status(self, platform):
        """检查浏览器状态，如果关闭则重新初始化"""
        if platform not in self.pages or not self.pages[platform]:
            self.init_browsers(platform)
            return

        try:
            # 尝试获取当前URL，如果失败说明页面已关闭
            _ = self.pages[platform].url
        except:
            log_message(f"{platform} Warning: 页面已关闭，正在重新初始化...")
            self.init_browsers(platform)

    def login_status_message(self, platform):
        return self.login_status_errors.get(str(platform or ""), "")
            
    def check_login_status(self, platform):
        """检查指定平台是否已登录"""
        self.check_browser_status(platform)  # 检查如果页面关闭则重新初始化

        page = self.pages[platform]
        context = self.contexts[platform]
        self.login_status_errors[platform] = ""
        flag = False
        try:
            # 平台特定的登录状态检查逻辑
            if platform == 'wechat':
                # 微信登录检查示例：查找用户头像元素
                page.goto("https://mp.weixin.qq.com")
                flag = True
                
            elif platform == 'xiaohongshu':
                # 小红书登录检查示例：查找个人中心元素
                page.goto("https://www.xiaohongshu.com")
                if(page.get_by_role("button", name="登录").count() == 0):
                    flag = True
                    
            elif platform == 'toutiao':
                # 今日头条登录检查示例：查找个人中心元素
                page.goto("https://www.toutiao.com")
                if(page.get_by_role("button", name="登录").count() == 0):
                    flag = True
            elif platform == 'douyin':
                # 抖音登录检查示例：查找个人中心元素
                # page.goto("https://www.douyin.com")
                # if(page.get_by_role("button", name="登录").count() == 0):
                flag = True
            elif platform == 'baidu':
                # 百度登录检查示例：查找个人中心元素
                page.goto("https://www.baidu.com")
                if(page.get_by_role("button", name="登录").count() == 0):
                    flag = True
            elif platform == 'weibo':
                # 微博登录检查：首页保持长连接，load 事件常年不触发，默认 goto 会 30s 超时误判为未登录；
                # 且 www.weibo.com 会重定向到裸域 weibo.com 造成 “navigation interrupted”。
                # 故直接访问重定向后的规范裸域名，并用 domcontentloaded 判断登录态。
                page.goto("https://weibo.com", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1500)  # 等待登录态相关元素渲染完成，避免误判
                if(page.get_by_role("button", name="登录/注册").count() == 0):
                    flag = True
            elif platform == 'zhihu':
                # 知乎登录检查示例：查找个人中心元素
                page.goto("https://www.zhihu.com")
                if(page.get_by_role("button", name="登录/注册").count() == 0):
                    flag = True
            elif platform == 'kuaishou':
                # 快手登录检查示例：查找个人中心元素
                page.goto("https://www.kuaishou.com")
                if(page.get_by_role("button", name="立即登录").count() == 0):
                    flag = True
            elif platform == 'bilibili':
                # B站登录检查示例：查找个人中心元素
                page.goto("https://www.bilibili.com")
                if(page.get_by_role("button", name="登录").count() == 0):
                    flag = True

            elif platform == 'netease':
                # 网易顶部导航会同时保留登录前/登录后的 DOM，仅切换可见性，不能用
                # “登录”文字的 count 判断，否则登录后仍会被误判为未登录。
                page.goto(netease.HOME_URL, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1500)
                logged_in_panel = page.locator("#js_N_navLoginAfter")
                if (logged_in_panel.count() > 0 and
                        logged_in_panel.first.is_visible()):
                    flag = True

            elif platform == 'eastmoney':
                # 举报中心会在未登录时跳到 passport2；以最终地址判断比首页上
                # 同时存在的登录模板更可靠。
                page.goto(eastmoney.REPORT_CENTER_URL,
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2500)
                flag = (not eastmoney.is_login_url(page.url) and
                        "help.eastmoney.com" in page.url.lower())

            elif platform == 'tiantianfund':
                # 天天基金基金吧与东方财富共用统一举报中心；匿名访问会被
                # passport2 拦截。独立保存登录态，避免仅凭主站“登录”文字误判。
                page.goto(tiantianfund.REPORT_CENTER_URL,
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2500)
                flag = (not tiantianfund.is_login_url(page.url) and
                        "help.eastmoney.com" in page.url.lower())

            elif platform == 'tonghuashun':
                # 新举报中心的前端路由守卫会把匿名用户送往 upass 登录站。
                page.goto(tonghuashun.REPORT_CENTER_BASE,
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)
                body_text = page.locator("body").inner_text(
                    timeout=3000)[:1000]
                if tonghuashun.is_access_forbidden_page(
                        page.url, page.title(), body_text):
                    self.login_status_errors[platform] = (
                        "同花顺登录入口拒绝当前网络访问，请暂停重试并稍后人工登录")
                    log_message(self.login_status_errors[platform], True)
                else:
                    flag = (not tonghuashun.is_login_url(page.url) and
                            "eq.10jqka.com.cn" in page.url.lower())
                    if not flag:
                        self.login_status_errors[platform] = (
                            "同花顺账号未登录，请在程序浏览器窗口完成登录")

            elif platform == 'tencent':
                # 腾讯文章页的举报入口会先调用 checkLogin；顶部账号区登录后会
                # 追加 qqcon-islogin，并隐藏登录按钮。两项同时判断可避免页面尚未
                # 渲染完成时把“没有登录按钮”误当成已登录。
                page.goto(tencent.HOME_URL,
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(2500)
                logged_in_panel = page.locator(tencent.LOGGED_IN_SELECTOR)
                login_button = page.locator(tencent.LOGIN_BUTTON_SELECTOR)
                flag = tencent.is_logged_in_state(
                    logged_in_panel.count() > 0 and
                    logged_in_panel.first.is_visible(),
                    login_button.count() > 0 and
                    login_button.first.is_visible(),
                )

            elif platform == 'xueqiu':
                # 雪球的登录指令和投诉入口都以页面全局用户 ID 为准；匿名用户 ID
                # 为 0。若命中滑块验证页则保守判定未登录，交给人工完成验证。
                try:
                    page.goto(xueqiu.HOME_URL,
                              wait_until="domcontentloaded", timeout=30000)
                except Exception as navigation_error:
                    if "interrupted by another navigation" not in str(
                            navigation_error):
                        raise
                    page.wait_for_timeout(1500)
                page.wait_for_timeout(2000)
                body_text = page.locator("body").inner_text(timeout=3000)[:1000]
                if xueqiu.is_verification_page(
                        page.url, page.title(), body_text):
                    self.login_status_errors[platform] = (
                        "雪球触发官方访问验证，请在程序浏览器窗口人工完成后重试")
                    log_message(self.login_status_errors[platform], True)
                    flag = False
                else:
                    user_id = page.evaluate(
                        "() => window.SNOWMAN_USER && window.SNOWMAN_USER.id")
                    flag = xueqiu.is_logged_in_user_id(user_id)
                    if not flag:
                        self.login_status_errors[platform] = (
                            "雪球账号未登录，请在程序浏览器窗口完成登录")

            elif platform == 'futu':
                # 富途新版页面的登录字段可能是含循环引用的响应式对象，不能直接
                # 经 page.evaluate 序列化。改用官方举报原因只读接口确认会话；
                # 匿名访问会明确返回 10888，登录会话返回 0。
                page.goto(futu.REPORT_GUIDE_URL,
                          wait_until="domcontentloaded", timeout=30000)
                flag = self._futu_has_authenticated_session(page)

            elif platform == 'sohu':
                # 搜狐普通内容举报允许匿名提交；登录仅用于上传截图和查看处理进度。
                # 因此平台可用性检查不把“未登录”当成阻塞条件。
                page.goto(sohu.HOME_URL,
                          wait_until="domcontentloaded", timeout=30000)
                flag = "sohu.com" in page.url.lower()

            elif platform == 'sina':
                # 新浪文章举报表单可匿名浏览，但页面提交脚本明确要求新浪账号登录。
                page.goto(
                    sina.build_report_url(sina.REPORT_GUIDE_URL),
                    wait_until="domcontentloaded", timeout=30000)
                page.locator(sina.FORM_SELECTOR).wait_for(
                    state="visible", timeout=15000)
                page.wait_for_timeout(1500)
                login_state = page.evaluate(
                    "() => Boolean(window.SINA_OUTLOGIN_LAYER && "
                    "window.SINA_OUTLOGIN_LAYER.isLogin())")
                flag = sina.is_logged_in_state(login_state)

            elif platform == 'yidianzixun':
                # 一点号内容的普通举报位于一点资讯文章页。公开页面会渲染表单，
                # 但入口与最终请求都依赖文章页登录态，严格以 docinfo 布尔值为准。
                page.goto(yidian.REPORT_GUIDE_URL,
                          wait_until="domcontentloaded", timeout=30000)
                page.locator(yidian.REPORT_FORM_SELECTOR).wait_for(
                    state="attached", timeout=15000)
                page.wait_for_function(
                    "() => Boolean(window.yidian && window.yidian.docinfo)",
                    timeout=15000)
                login_state = page.evaluate(
                    "() => window.yidian.docinfo.is_login")
                flag = yidian.is_logged_in_state(login_state)
            
            
            if flag:
                user_data_dir = browser_session.legacy_storage_state_path(
                    get_base_path(), platform)
                os.makedirs(os.path.dirname(user_data_dir), exist_ok=True)
                context = self.contexts[platform]
                context.storage_state(path=user_data_dir)
            return flag
        except Exception as e:
            self.login_status_errors[platform] = (
                f"{platform} 登录状态检查异常: {e}")
            log_message(f"{platform} 登录状态检查失败: {e}",True)
            return False

    def _futu_has_authenticated_session(self, page, attempts=2):
        """通过富途官方只读接口确认登录；仅瞬时异常会有限重试。"""
        last_status = None
        last_code = None
        for attempt in range(max(1, attempts)):
            try:
                response = page.request.get(
                    futu.REPORT_TYPES_URL,
                    headers={"Referer": page.url}, timeout=15000)
                last_status = response.status
                try:
                    payload = response.json()
                except Exception:
                    payload = {}
                last_code = payload.get('code') if isinstance(
                    payload, dict) else None
                if futu.is_authenticated_report_types_response(
                        response.ok, payload):
                    return True
                if futu.is_explicit_not_login_response(payload):
                    return False
            except Exception as exc:
                last_status = type(exc).__name__
                last_code = None

            if attempt + 1 < max(1, attempts):
                page.wait_for_timeout(500)

        log_message(
            "富途登录状态只读接口未能确认会话: "
            f"status={last_status}, code={last_code}", True)
        return False
    
    
    def perform_complaint(self, platform, complaint_data):
        """执行投诉流程"""
        if platform not in self.pages or not self.pages[platform]:
            self.last_flow_result = FlowResult.from_legacy(
                False, f"{platform} 浏览器页面未初始化", "OPEN_CONTENT"
            )
            return False

        # 统一限制所有平台的举报理由，同时覆盖绕过 MQ 的直接调用。
        complaint_data = prepare_complaint_data(complaint_data)
        log_message(f"开始处理 {platform} 投诉……")

        self.errMessage = ""
        self.submission_confirmed = False

        raw_page = self.pages[platform]
        self.mobile_only_url = None
        page = self.self_healing.wrap_page(platform, raw_page)
        self.self_healing.begin_flow(
            platform, complaint_data, getattr(raw_page, "url", "")
        )
        try:
            handlers = {
                'wechat': self._wechat_complaint_flow,
                'xiaohongshu': self._xiaohongshu_complaint_flow,
                'toutiao': self._toutiao_complaint_flow,
                'douyin': self._douyin_complaint_flow,
                'baidu': self._baidu_complaint_flow,
                'zhihu': self._zhihu_complaint_flow,
                'weibo': self._weibo_complaint_flow,
                'kuaishou': self._kuaishou_complaint_flow,
                'bilibili': self._bilibili_complaint_flow,
                'netease': self._netease_complaint_flow,
                'eastmoney': self._eastmoney_complaint_flow,
                'tiantianfund': self._tiantianfund_complaint_flow,
                'tonghuashun': self._tonghuashun_complaint_flow,
                'tencent': self._tencent_complaint_flow,
                'xueqiu': self._xueqiu_complaint_flow,
                'futu': self._futu_complaint_flow,
                'sohu': self._sohu_complaint_flow,
                'sina': self._sina_complaint_flow,
                'yidianzixun': self._yidianzixun_complaint_flow,
            }
            handler = handlers.get(platform)
            if handler is None:
                self.errMessage = f"不支持的平台: {platform}"
                succeeded = False
            else:
                succeeded = bool(handler(page, complaint_data))
            self.last_flow_result = FlowResult.from_legacy(
                succeeded, self.errMessage
            )
            if not succeeded:
                evidence_id = self.self_healing.handle_flow_failure(
                    platform,
                    raw_page,
                    self.errMessage or "浏览器流程返回失败",
                    healable=self.last_flow_result.healable,
                )
                if evidence_id:
                    self.last_flow_result = FlowResult(
                        status=self.last_flow_result.status,
                        error_code=self.last_flow_result.error_code,
                        step=self.last_flow_result.step,
                        retryable=self.last_flow_result.retryable,
                        healable=self.last_flow_result.healable,
                        message=self.last_flow_result.message,
                        evidence_id=evidence_id,
                    )
            return succeeded
        except Exception as e:
            self.errMessage = self.errMessage or f"{platform} 投诉流程执行失败: {e}"
            self.last_flow_result = FlowResult.from_legacy(
                False, self.errMessage
            )
            evidence_id = self.self_healing.handle_flow_failure(
                platform,
                raw_page,
                self.errMessage,
                healable=self.last_flow_result.healable,
            )
            if evidence_id:
                self.last_flow_result = FlowResult(
                    status=self.last_flow_result.status,
                    error_code=self.last_flow_result.error_code,
                    step=self.last_flow_result.step,
                    retryable=self.last_flow_result.retryable,
                    healable=self.last_flow_result.healable,
                    message=self.last_flow_result.message,
                    evidence_id=evidence_id,
                )
            log_message(self.errMessage, True)
            return False
        finally:
            self.self_healing.finish_flow(
                getattr(self.last_flow_result, "success", False)
            )
        
    def close_all(self):
        """关闭所有浏览器实例"""
        try:
            # 关闭所有上下文和页面
            for platform, context in self.contexts.items():
                if context:
                    try:
                        context.close()
                        log_message(f"{platform} 浏览器上下文已关闭")
                    except:
                        log_message(f"{platform} 浏览器上下文关闭失败", True)

            # 清空存储
            self.contexts.clear()
            self.pages.clear()
            self.drivers.clear()

            # 关闭浏览器
            if self.browser:
                self.browser.close()
                self.browser = None
                log_message("浏览器已关闭")

            # 停止Playwright
            if self.playwright:
                self.playwright.stop()
                self.playwright = None
                log_message("Playwright已停止")

        except Exception as e:
            log_message(f"关闭浏览器时出错: {e}", True)
    

    #region 微信投诉流程
    def _wechat_complaint_flow(self, page, complaint_data):
        """微信投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://mp.weixin.qq.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")

            # 等待页面加载完成（10秒超时）
            page.wait_for_selector("//span[@class='js_pay_attention']", timeout=overTime)

            # 步骤2: 点击举报按钮
            log_message("步骤2: 点击举报按钮")
            page.wait_for_selector("//span[contains(text(),'举报')]", timeout=overTime)
            page.locator("//span[contains(text(),'举报')]").click()
            time.sleep(0.5)  # 等待举报页面加载

            # 步骤3: 选择举报原因
            main_category = complaint_data.get('category', 'not found')  # 默认选择第一个原因
            log_message("步骤3: 选择举报原因：{}".format(main_category))
            reason_xpath = f"//span[contains(text(),'{main_category}')]"
            page.wait_for_selector(reason_xpath, timeout=overTime)
            page.locator(reason_xpath).click()
            time.sleep(1)

            # 步骤4: 选择子原因（根据索引，5秒超时）
            sub_category = complaint_data.get('subCategory', 'not found')  # 默认选择第一个原因
            if sub_category != 'not found':
                log_message("步骤4: 选择子原因：{}".format(sub_category))
                sub_reason_xpath = f"//span[contains(text(),'{sub_category}')]"
                page.wait_for_selector(sub_reason_xpath, timeout=overTime)
                page.locator(sub_reason_xpath).click()
                time.sleep(0.5)
            else:
                log_message("步骤4: 未找到子原因，跳过选择")

            # 步骤5: 输入描述文本
            log_message("步骤5: 输入描述文本")
            description = complaint_data.get('reason', None)
            if description:
                page.wait_for_selector("//textarea[contains(@placeholder,'请描述问题')]", timeout=overTime)
                page.locator("//textarea[contains(@placeholder,'请描述问题')]").fill(description)

            # 步骤6: 上传图片
            log_message("步骤6: 上传图片")
            self._upload_image(page, complaint_data, "//input[@type='file']")
            time.sleep(1)

            # 步骤7: 点击提交按钮
            log_message("步骤7: 点击提交按钮")
            page.wait_for_selector("//span[contains(text(),'提交')]", timeout=overTime)
            if not DebugRun:
                page.locator("//span[contains(text(),'提交')]").click()
            log_message("微信投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤8: 截图并上传到OSS
            log_message("步骤8: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)

            # 步骤9: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"微信投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region 小红书投诉流程
    def _xiaohongshu_complaint_flow(self, page, complaint_data):
        """小红书投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）
        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.xiaohongshu.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")

            from xhs_phone import mobile_only_target
            self.mobile_only_url = mobile_only_target(page)
            if self.mobile_only_url:
                return False

            if(page.get_by_text("你访问的页面不见了").count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True
            
            # 步骤2: 点击下拉菜单
            log_message("步骤2: 点击下拉菜单")
            page.locator(".reds-icon.more").first.click()
            time.sleep(0.5)  # 等待菜单展开

            # 步骤3: 点击举报按钮
            log_message("步骤3: 点击举报按钮")
            page.get_by_text("举报", exact=True).click()
            time.sleep(1)  # 等待举报页面加载

            # 步骤4: 选择举报原因（兼容序号前缀“9. 标题党”等库文本差异）
            main_category = complaint_data.get('category')
            log_message("步骤4: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl='//div[contains(@class, "list-select-item-option") and contains(text(), "{text}")]',
                    options_selector='//div[contains(@class, "list-select-item-option")]',
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            time.sleep(0.5)

            # 步骤5: 点击下一步按钮
            log_message("步骤5: 点击下一步按钮")
            page.get_by_text("下一步", exact=True).click()
            time.sleep(0.5)  # 等待下一步页面加载

            # 步骤6: 选择子原因（空/NULL 时跳过）
            sub_category = complaint_data.get('subCategory')
            if normalize_category(sub_category):
                log_message("步骤6: 选择子原因：{}".format(sub_category))
                self._select_reason(
                    page, sub_category,
                    click_xpath_tpl='//div[@class="choice-item" and contains(text(), "{text}")]',
                    options_selector='//div[@class="choice-item"]',
                    ready_timeout=overTime, label="子原因")
                time.sleep(0.5)
            else:
                log_message("步骤6: 未找到子原因，跳过选择")

            # 步骤7: 输入描述文本
            log_message("步骤7: 输入描述文本")
            description = complaint_data.get('reason', None)
            if description:
                page.locator("//textarea[@class='advice-input']").fill(description)

            # 步骤8: 上传图片
            log_message("步骤8: 上传图片")
            self._upload_image(page, complaint_data, "//input[@type='file']")
            time.sleep(0.5)

            # 步骤9: 点击提交按钮
            log_message("步骤9: 点击提交按钮")
            if not DebugRun:
                page.get_by_text("提交", exact=True).click()
            log_message("小红书投诉提交按钮已点击")
            time.sleep(1)

            # 步骤9.5: 截图并上传到OSS
            log_message("步骤9.5: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)


            # 步骤10: 验证提交结果（3秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)


            return True

        except Exception as e:
            log_message(f"小红书投诉流程执行失败: {e}",True)
            return False

    #endregion
    
    #region 抖音投诉流程
    def _douyin_complaint_flow(self, page, complaint_data):
        """抖音投诉流程"""
        overTime = 30000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.douyin.com/')
            # 抖音页面资源多，默认 wait_until='load' 常在 30s 超时（见日志 attempt#1）；
            # 改用 domcontentloaded 提前返回，再等 SPA 渲染，后续操作有各自的可等待兜底
            page.goto(url, wait_until="domcontentloaded")
            time.sleep(2)
            log_message("步骤1: GET完成……")

            # 抖音会做客户端重定向：/video/{id} 的图文内容跳到 /note/{id}，死链跳到
            # /jingxuan?modal_id=<别的视频>（不显示404页）。goto 返回时重定向往往还没发生，
            # 立刻读 page.url 分支就会走错（见日志：按 video 分支点举报，却卡在等待
            # note 页导航完成直至 30s 超时）。这里先等 URL 稳定（连续 1.5s 不变）再分支。
            current_url = page.url
            stable_since = time.time()
            deadline = time.time() + 8
            while time.time() < deadline:
                time.sleep(0.5)
                if page.url != current_url:
                    current_url = page.url
                    stable_since = time.time()
                elif time.time() - stable_since >= 1.5:
                    break

            # 死链判定：最终 URL 不再包含原链接中的内容 ID（"视频不存在"只是短暂 toast，
            # 文本检查不可靠）
            id_match = re.search(r'(\d{15,})', url)
            if id_match and id_match.group(1) not in current_url:
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            # 检查页面是否无效
            if(page.get_by_text("不存在").count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            if 'note' in current_url:
                log_message("抖音投诉流程----note图文！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.locator('[data-e2e="video-play-more"]').first.hover()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.get_by_text("举报", exact=True).click()
                time.sleep(0.5)  # 等待举报页面加载
            elif 'video' in current_url:
                log_message("抖音投诉流程----video视频！")
                # 视频页通常有 1 个可见"举报"可直接点；若改版/布局不同导致直点失败，
                # 兜底走"更多"菜单 hover 后再点
                try:
                    page.get_by_text("举报", exact=True).click(timeout=8000)
                except Exception:
                    log_message("直接点击举报失败，改走更多菜单……")
                    page.locator('[data-e2e="video-play-more"]').first.hover()
                    time.sleep(0.5)
                    page.get_by_text("举报", exact=True).click()
                time.sleep(0.5)  # 等待菜单展开
            else:
                log_message("抖音投诉流程----精选视频！")

                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.locator('[data-e2e="video-play-more"]').first.hover()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.get_by_text("举报", exact=True).click()
                time.sleep(0.5)  # 等待举报页面加载

            # 步骤4: 选择举报原因
            # 说明1：原选择器依赖抖音混淆类名 //div[@class='QOkSKhJv']（连同 OrTUg0ay/GOD8H7wO
            #   等都是哈希类名，前端改版即失效），导致每条投诉都在此超时。改为“文本锚定枚举
            #   平台真实选项 + best_match 动态归类”，不依赖任何类名。
            # 说明2：抖音单选格结构是 <div格><div单选圈/><span文字/></div>，单选点击事件绑在
            #   **单选圈**(文字 span 的前一个兄弟 div)上——点父格或点文字都不会选中、提交按钮
            #   会一直是 disabled。故 click_relative 定位到 span 的 preceding-sibling::div[1]（单选圈）。
            #   （在线核验：点单选圈 -> 提交按钮变可用；点父格/文字 -> 仍禁用。）
            # 说明3：抖音网页举报只有“单层”原因，没有二级子类；数据库 subCategory 是 App 端二级，
            #   网页流程不用，故不再选子类，以免把“其他违规”误模糊成一级“其他”。
            main_category = complaint_data.get('category')
            log_message("步骤4: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl="//span[contains(text(),'{text}')]",
                    options_selector="xpath=//*[contains(text(),'举报原因')]/following::span",
                    options_fallback="//span",
                    click_relative="xpath=preceding-sibling::div[1]",
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            time.sleep(1)

            # 步骤6: 输入描述文本（可选！抖音选完原因“提交”即已可用；描述框选择器抖音会改版，
            #   找不到就跳过、绝不因此让整条投诉失败。多个选择器兜底：优先按“举报描述”标签锚定
            #   其后的 textarea（不依赖 placeholder），再退化到按 placeholder 关键字匹配。）
            description = complaint_data.get('reason', None)
            if description:
                log_message("步骤6: 输入描述文本")
                filled = False
                for sel in ['xpath=//*[contains(text(),"举报描述")]/following::textarea[1]',
                            '//textarea[contains(@placeholder,"请详细描述")]',
                            '//textarea[contains(@placeholder,"描述")]']:
                    try:
                        ta = page.locator(sel).first
                        if ta.count() > 0:
                            ta.fill(description, timeout=5000)
                            filled = True
                            break
                    except Exception:
                        continue
                if not filled:
                    log_message("步骤6: 未找到描述输入框，跳过（描述可选，不影响提交）")

            # 步骤7: 上传图片（可选，_upload_image 内部已容错、失败不抛出）
            log_message("步骤7: 上传图片")
            self._upload_image(page, complaint_data, "//input[@type='file']")
            time.sleep(2)

            # 步骤8: 点击提交按钮
            log_message("步骤8: 点击提交按钮")
            if not DebugRun:
                page.get_by_text("提交", exact=True).click()
            log_message("抖音投诉提交按钮已点击")
            time.sleep(1)

            # 步骤9: 截图并上传到OSS
            log_message("步骤9: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)

            # 步骤10: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"抖音投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region 今日头条投诉流程
    def _toutiao_complaint_flow(self, page, complaint_data):
        """今日头条投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）
        main_category = complaint_data.get('category', 'not found')  # 默认选择第一个原因
        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.toutiao.com/')
            page.goto(url)
            current_url = page.url
            log_message("步骤1: GET完成……")
            
            if(page.get_by_text("内容不存在").count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            if "video" in current_url:

                log_message("今日头条投诉流程----视频链接！")

                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("//button[@aria-label='更多']//*[name()='svg']", timeout=overTime)
                page.locator("//button[@aria-label='更多']//*[name()='svg']").click()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.wait_for_selector("//button[contains(text(),'举报')]//i[@class='icon']//*[name()='svg']", timeout=overTime)
                time.sleep(0.5)  # 等待举报页面加载
                page.locator("//button[contains(text(),'举报')]//i[@class='icon']//*[name()='svg']").click()
                time.sleep(0.5)  # 等待举报页面加载

                # 步骤4: 选择举报原因（兼容库文本与页面文字差异，如 重复、旧闻/重复旧闻）
                log_message("步骤4: 选择举报原因：{}".format(main_category))
                if not self._select_reason(
                        page, main_category,
                        click_xpath_tpl="//label[contains(text(),'{text}')]",
                        options_selector="//label",
                        ready_timeout=overTime, label="举报原因"):
                    self.errMessage = "未找到匹配的举报原因"
                    return False
                time.sleep(1)

                # 步骤5: 输入描述文本
                log_message("步骤5: 输入描述文本")
                description = complaint_data.get('reason', None)
                if description:
                    page.wait_for_selector("//textarea[@placeholder='请描述你遇到的问题']", timeout=overTime)
                    page.locator("//textarea[@placeholder='请描述你遇到的问题']").fill(description)

            else:

                log_message("今日头条投诉流程----文章链接！")
                # 步骤2: 点击举报按钮
                log_message("步骤2: 点击举报按钮")
                page.wait_for_selector("//div[@class='detail-report']//i", timeout=overTime)
                time.sleep(0.5)  # 等待举报页面加载
                page.locator("//div[@class='detail-report']//i").click()
                time.sleep(0.5)  # 等待举报页面加载

                # 步骤3-5: 选择举报原因（兼容库文本与页面文字差异）
                log_message("步骤3-5: 选择举报原因：{}".format(main_category))
                # “其他问题，我要吐槽”是按钮，其余是 label
                if "其他问题" in (normalize_category(main_category) or ""):
                    ok = self._select_reason(
                        page, main_category,
                        click_xpath_tpl="//button[contains(text(),'{text}')]",
                        options_selector="//button",
                        ready_timeout=overTime, label="举报原因")
                else:
                    ok = self._select_reason(
                        page, main_category,
                        click_xpath_tpl="//label[contains(text(),'{text}')]",
                        options_selector="//label",
                        ready_timeout=overTime, label="举报原因")
                if not ok:
                    self.errMessage = "未找到匹配的举报原因"
                    return False
                time.sleep(1)


            # 步骤6: 点击提交按钮
            log_message("步骤6: 点击提交按钮")
            if not DebugRun:
                page.get_by_text("确认", exact=True).click()
            log_message("今日头条投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤7: 截图并上传到OSS
            log_message("步骤7: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)


            # 步骤8: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '反馈成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"今日头条投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region 百度投诉流程
    def _baidu_complaint_flow(self, page, complaint_data):
        """百度投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.baidu.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")
            
            url = page.url
            
            if(page.get_by_text("内容不存在").count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            # 步骤2: 点击举报按钮
            log_message("步骤2: 点击举报按钮")
            xpath = "//span[@data-testid='report-btn']"
            if "video" in url or "videolanding" in url:
                xpath = "(//span[contains(text(),'举报')])[1]"

            page.locator(xpath).evaluate("element => element.click()")
            time.sleep(0.5)  # 等待菜单展开


            # 步骤3: 选择举报原因（兼容库文本与页面文字差异）
            main_category = complaint_data.get('category')
            log_message("步骤3: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl="//label[contains(text(),'{text}')]",
                    options_selector="//label",
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            time.sleep(1)


            # 步骤4: 输入描述文本
            log_message("步骤4: 输入描述文本")
            description = complaint_data.get('reason', None)
            if description:
                page.wait_for_selector("//textarea[@id='fb_des_content']", timeout=overTime)
                page.locator("//textarea[@id='fb_des_content']").fill(description)

            # 步骤5: 上传图片
            log_message("步骤5: 上传图片")
            self._upload_image(page, complaint_data, "//input[@type='file']")
            time.sleep(1)  # 等待图片上传


            # 步骤6: 点击提交按钮
            log_message("步骤6: 点击提交按钮")
            if not DebugRun:
                page.get_by_text("提交反馈", exact=True).click()
            log_message("百度投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤7: 截图并上传到OSS
            log_message("步骤7: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)


            # 步骤8: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"百度投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region 知乎投诉流程
    def _zhihu_complaint_flow(self, page, complaint_data):
        """知乎投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页 - 添加随机延迟避免被检测
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.zhihu.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")

            # 检查是否出现40362错误
            page_content = page.content()
            if "您当前请求存在异常" in page_content or "40362" in page_content:
                log_message("检测到知乎40362限制错误", True)
                self.errMessage = "知乎检测到自动化行为，访问被限制"
                self.close_all()
                log_message("已关闭浏览器！")
                return False

            # 检查页面是否失效
            try:
                page.wait_for_selector("//p[contains(text(),'你似乎来到了没有知识存在的荒原')]", timeout=5000)
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True
            except:
                pass  # 页面正常，继续执行

            if 'answer' in url:
                log_message("知乎投诉流程----问答！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("(//div[@class='Popover ContentItem-action']//button)[1]", timeout=20000)
                page.locator("(//div[@class='Popover ContentItem-action']//button)[1]").click()
                time.sleep(0.5)  # 等待菜单展开
            else:
                log_message("知乎投诉流程----文章！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("//div[@class='Post-ActionMenuButton']//button", timeout=20000)
                page.locator("//div[@class='Post-ActionMenuButton']//button").click()
                time.sleep(0.5)  # 等待菜单展开

            # 步骤3: 点击举报按钮
            log_message("步骤3: 点击举报按钮")
            page.wait_for_selector("//button[contains(text(),'举报')]", timeout=overTime)
            time.sleep(0.5)  # 等待举报页面加载
            page.locator("//button[contains(text(),'举报')]").click()
            time.sleep(0.5)  # 等待举报页面加载

            # 步骤4: 选择举报原因（兼容 JSON 数组/顿号多值，如 ["不友善","不实信息"]）
            main_category = complaint_data.get('category')
            log_message("步骤4: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl="//div[contains(text(),'{text}')]",
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            time.sleep(1)

            # 步骤5: 选择子原因（空/NULL 时跳过）
            sub_category = complaint_data.get('subCategory')
            if normalize_category(sub_category):
                log_message("步骤5: 选择子原因：{}".format(sub_category))
                self._select_reason(
                    page, sub_category,
                    click_xpath_tpl="//div[contains(text(),'{text}')]",
                    ready_timeout=overTime, label="子原因")
                time.sleep(0.5)
            else:
                log_message("步骤5: 未找到子原因，跳过选择")

            # 步骤6: 输入描述文本
            log_message("步骤6: 输入描述文本")
            description = complaint_data.get('reason', None)
            if description:
                page.wait_for_selector('//textarea[@name="customReason"]', timeout=overTime)
                page.locator('//textarea[@name="customReason"]').fill(description)

            # 步骤7: 上传图片
            log_message("步骤7: 上传图片")
            self._upload_image(page, complaint_data, "//div[contains(@class, 'Modal-content')]//input[@type='file']")
            time.sleep(1)

            # 步骤8: 点击提交按钮
            log_message("步骤8: 点击提交按钮")
            page.wait_for_selector("//button[contains(text(),'提交举报')]", timeout=overTime)
            if not DebugRun:
                page.locator("//button[contains(text(),'提交举报')]").click()
            log_message("知乎投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤9: 截图并上传到OSS
            log_message("步骤9: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)

            # 步骤10: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"知乎投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region 微博投诉流程
    def _weibo_complaint_flow(self, page, complaint_data):
        """微博投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）
        popup_page = None  # 新标签页

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.weibo.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")
            
            url = page.url
            
            if(page.get_by_text("内容不存在").count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            # 步骤2: 点击下拉菜单
            log_message("步骤2: 点击下拉菜单")
            page.wait_for_selector("//i[@title='更多']", timeout=overTime)
            page.locator("//i[@title='更多']").click()
            time.sleep(1)  # 等待菜单展开

            # 步骤3: 点击举报按钮并等待新标签页打开
            log_message("步骤3: 点击举报按钮")
            with page.expect_popup() as popup_info:
                page.wait_for_selector('//div[@role="button" and .//div[text()="投诉"]]', timeout=overTime)
                time.sleep(0.5)  # 等待举报页面加载
                page.locator('//div[@role="button" and .//div[text()="投诉"]]').click()
                time.sleep(5)  # 等待举报页面加载

            # 获取新打开的标签页
            popup_page = popup_info.value
            log_message("已切换到新标签页")

            # 等待新页面加载完成
            popup_page.wait_for_selector("//h4[text()='侵权投诉专区']", timeout=overTime+5000)

            # 步骤4: 选择举报原因（兼容库文本与页面文字差异）
            main_category = complaint_data.get('category')
            log_message("步骤4: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    popup_page, main_category,
                    click_xpath_tpl="//a[contains(text(),'{text}')]",
                    options_selector="//a",
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                try:
                    popup_page.close()
                except Exception:
                    pass
                return False
            time.sleep(1)

            # 步骤5: 选择子原因（兼容顿号多值“宗教民族问题、历史虚无主义”；空/NULL 跳过）
            sub_category = complaint_data.get('subCategory')
            if normalize_category(sub_category):
                log_message("步骤5: 选择子原因：{}".format(sub_category))
                self._select_reason(
                    popup_page, sub_category,
                    click_xpath_tpl="//a[contains(text(),'{text}')]",
                    options_selector="//a",
                    ready_timeout=overTime, label="子原因")
                time.sleep(0.5)
            else:
                log_message("步骤5: 未找到子原因，跳过选择")


            # 步骤6: 如果有确认弹框信息点击确认。
            try:
                log_message("步骤6: 如果有确认弹框信息点击确认。")
                popup_page.wait_for_selector("//button[contains(text(),'继续投诉')]", timeout=overTime)
                popup_page.locator("//button[contains(text(),'继续投诉')]").click()
                time.sleep(1)
            except Exception as e:
                pass

            # 步骤6.5: 检测是否需要实名信息？
            try:
                popup_page.wait_for_selector("//h4[@style='display: none']", timeout=3000)
                self.errMessage = "该举报类目需要实名信息！"
                log_message(self.errMessage)
                # 关闭新标签页
                popup_page.close()
                log_message("已关闭举报页面并返回主页面")
                return False
            except:
                pass  # 不需要实名信息，继续

            # 步骤6.5: 如果需要文字描述添加文字描述
            try:
                popup_page.wait_for_selector("//textarea[contains(@placeholder,'请详细填写')]", timeout=3000)
                description = complaint_data.get('reason', 'none')
                popup_page.locator("//textarea[contains(@placeholder,'请详细填写')]").fill(description)
                log_message("步骤6.5: 已添加文字描述")
            except:
                pass

            # 步骤7: 勾选确认条约
            log_message("步骤7: 勾选确认条约")
            check_checkbox(popup_page, "//input[@name='chk']", timeout=overTime)
            log_message("步骤7: 已勾选确认条约")
            time.sleep(1)  # 等待举报页面加载


            # 步骤8: 点击提交按钮
            log_message("步骤8: 点击提交按钮")
            popup_page.wait_for_selector("//a[contains(text(),'提交')]", timeout=overTime)
            if not DebugRun:
                popup_page.locator("//a[contains(text(),'提交')]").click()
            log_message("微博投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤9: 截图并上传到OSS
            log_message("步骤9: 截图并上传到OSS")
            self._save_screenshot(popup_page, complaint_data)


            # 步骤10: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(popup_page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            time.sleep(1)

            # 关闭新标签页
            log_message("关闭举报页面并返回主页面")
            popup_page.close()
            log_message("已关闭举报页面并返回主页面")

            return True

        except Exception as e:
            log_message(f"微博投诉流程执行失败: {e}",True)
            # 确保在异常情况下也尝试关闭新标签页
            try:
                if popup_page:
                    popup_page.close()
                log_message("异常情况下已尝试关闭举报页面")
            except:
                pass
            return False
    #endregion
    
    #region 快手投诉流程
    def _kuaishou_complaint_flow(self, page, complaint_data):
        """快手投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.kuaishou.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")
            if 'new-reco' in url:
                log_message("快手投诉流程----短视频！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("(//img[@class='more-img'])[1]", timeout=20000)
                page.locator("(//img[@class='more-img'])[1]").click()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.wait_for_selector("//div[@class='more-item report']", timeout=overTime)
                time.sleep(0.5)  # 等待举报页面加载
                page.locator("//div[@class='more-item report']").click()
                time.sleep(0.5)  # 等待举报页面加载
            else:
                log_message("快手投诉流程----video视频！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("//span[@class='item-text' and text() = '举报']", timeout=20000)
                page.locator("//span[@class='item-text' and text() = '举报']").click()
                time.sleep(0.5)  # 等待菜单展开



            # 步骤4-5: 选择举报原因（兼容库文本与页面文字差异）
            main_category = complaint_data.get('category')
            log_message("步骤4-5: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl="//div[contains(text(),'{text}')]/ancestor::div[@class='report-item-list-item']//label[@class='pl-radio']",
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            time.sleep(1)


            # 步骤6-7: 输入描述文本
            log_message("步骤6-7: 输入描述文本")
            description = complaint_data.get('reason', None)
            if description:
                page.wait_for_selector("//textarea[contains(@placeholder,'请描述举报理由')]", timeout=overTime)
                page.locator("//textarea[contains(@placeholder,'请描述举报理由')]").fill(description)

            # 步骤8: 点击提交按钮
            log_message("步骤8: 点击提交按钮")
            page.wait_for_selector("//button[contains(text(),'提交')]", timeout=overTime)
            if not DebugRun:
                page.locator("//button[contains(text(),'提交')]").click()
            log_message("快手投诉提交按钮已点击")
            time.sleep(0.5)

            # 步骤9: 截图并上传到OSS
            log_message("步骤9: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)


            # 步骤10: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"快手投诉流程执行失败: {e}",True)
            return False
    #endregion
    
    #region B站投诉流程
    def _bilibili_complaint_flow(self, page, complaint_data):
        """B站投诉流程"""
        overTime = 10000  # 超时时间10秒（毫秒）

        try:

            # 步骤1: 进入指定的URL网页
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.bilibili.com/')
            page.goto(url)
            log_message("步骤1: GET完成……")
            if 'video' in url:
                log_message("B站投诉流程----视频！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.wait_for_selector("//span[@class='video-tool-more-reference']", timeout=20000)
                page.locator("//span[@class='video-tool-more-reference']").click()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.wait_for_selector("//span[text()='稿件举报']", timeout=overTime)
                time.sleep(0.5)  # 等待举报页面加载
                page.locator("//span[text()='稿件举报']").click()
                time.sleep(1)  # 等待举报页面加载

                # 步骤4-5: 选择举报原因（在iframe中；兼容库文本差异）
                main_category = complaint_data.get('category')
                log_message("步骤4-5: 选择举报原因：{}".format(main_category))
                # 使用frame_locator定位iframe中的元素（FrameLocator 无 wait_for_selector，逐候选尝试）
                frame = page.locator('iframe[name="appeal"]').content_frame
                clicked = False
                for i, cand in enumerate(self._category_candidates(main_category)):
                    try:
                        loc = frame.get_by_text(cand, exact=False).first
                        loc.wait_for(timeout=overTime if i == 0 else 2000)
                        loc.click()
                        clicked = True
                        log_message(f"举报原因选择：'{main_category}' -> '{cand}'")
                        break
                    except Exception:
                        continue
                if not clicked:
                    self.errMessage = "未找到匹配的举报原因"
                    return False
                time.sleep(1)

                # 步骤6: 输入描述文本
                log_message("步骤6: 输入描述文本")
                description = complaint_data.get('reason', None)
                if description:
                    page.locator("iframe[name=\"appeal\"]").content_frame.get_by_role("textbox", name="详细描述 * 0/").fill(description)

                # 步骤7: 上传图片
                log_message("步骤7: 上传图片")
                self._upload_image(page.locator("iframe[name=\"appeal\"]").content_frame, complaint_data, "input[type='file']")
                time.sleep(5)

                # 步骤8: 点击提交按钮
                log_message("步骤8: 点击提交按钮")
                if not DebugRun:
                    page.locator("iframe[name=\"appeal\"]").content_frame.get_by_text("提交").click()
                log_message("B站投诉提交按钮已点击")
                time.sleep(0.5)

            else:
                log_message("B站投诉流程----文章！")
                # 步骤2: 点击下拉菜单
                log_message("步骤2: 点击下拉菜单")
                page.locator(".bili-dyn-more").hover()
                # page.wait_for_selector("//div[@class='opus-more']", timeout=overTime)
                # page.locator("//div[@class='opus-more']").click()
                time.sleep(0.5)  # 等待菜单展开

                # 步骤3: 点击举报按钮
                log_message("步骤3: 点击举报按钮")
                page.get_by_text("举报", exact=True).first.click()
                # page.wait_for_selector("//div[text()='举报']", timeout=overTime)
                # page.locator("//div[text()='举报']").click()
                time.sleep(1)  # 等待举报页面加载

                # 步骤4-5: 选择举报原因（兼容库文本与页面文字差异）
                main_category = complaint_data.get('category')
                log_message("步骤4-5: 选择举报原因：{}".format(main_category))
                if not self._select_reason(
                        page, main_category,
                        click_xpath_tpl="//span[contains(text(),'{text}')]",
                        ready_timeout=overTime, label="举报原因"):
                    self.errMessage = "未找到匹配的举报原因"
                    return False
                time.sleep(1)


                # 步骤6-7: 输入描述文本
                log_message("步骤6-7: 输入描述文本")
                description = complaint_data.get('reason', None)
                if description:
                    page.wait_for_selector("//textarea[@class='bili-dyn-report__remark__field']", timeout=overTime)
                    page.locator("//textarea[@class='bili-dyn-report__remark__field']").fill(description)


                # 步骤8: 点击提交按钮
                log_message("步骤8: 点击提交按钮")
                if not DebugRun:
                    page.get_by_text("确定", exact=True).click()
                log_message("B站投诉提交按钮已点击")
                time.sleep(0.5)

            # 步骤9: 截图并上传到OSS
            log_message("步骤9: 截图并上传到OSS")
            self._save_screenshot(page, complaint_data)


            # 步骤10: 验证提交结果（10秒内检查成功提示）
            if not DebugRun:
                if self._check_submit_success(page, "//*[contains(text(), '提交成功')]"):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！",True)

            return True

        except Exception as e:
            log_message(f"B站投诉流程执行失败: {e}",True)
            return False
    #endregion

    #region 网易投诉流程
    def _netease_complaint_flow(self, page, complaint_data):
        """网易新闻文章举报流程。"""
        overTime = 15000
        report_page = None
        popup_created = False

        try:
            # 步骤1: 进入待举报的网易文章。
            log_message("步骤1: 进入指定的URL网页")
            url = complaint_data.get('link', 'https://www.163.com/')
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            log_message("步骤1: GET完成……")

            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            # 步骤2: 点击文章举报入口。网易不同文章模板的入口节点可能是链接、按钮或
            # role=button，按可见性从页面末尾向前选择，避开顶部隐藏模板节点。
            log_message("步骤2: 点击举报按钮")
            report_entry = None
            for selector in netease.REPORT_ENTRY_SELECTORS:
                entries = page.locator(selector)
                for index in range(entries.count() - 1, -1, -1):
                    candidate = entries.nth(index)
                    if candidate.is_visible():
                        report_entry = candidate
                        break
                if report_entry is not None:
                    break

            if report_entry is None:
                self.errMessage = "未找到举报入口"
                log_message(self.errMessage, True)
                return False

            pages_before = set(page.context.pages)
            report_entry.click()
            page.wait_for_timeout(2000)
            new_pages = [p for p in page.context.pages if p not in pages_before]
            if new_pages:
                report_page = new_pages[-1]
                popup_created = True
                log_message("举报页已在新标签页打开")
            else:
                report_page = page
                log_message("举报页已在当前标签页打开")

            report_page.get_by_text(netease.REPORT_HEADING, exact=True).wait_for(
                state="visible", timeout=overTime)

            # 步骤3: 选择反馈类型。网易当前使用 tag_code_list 下的自定义 label，
            # 再由统一的类别匹配器做语义归类。
            main_category = complaint_data.get('category')
            log_message("步骤3: 选择举报原因：{}".format(main_category))
            if not self._select_reason(
                    report_page, main_category,
                    click_xpath_tpl="//*[self::label or self::span or self::div][normalize-space()='{text}']",
                    options_selector=netease.REASON_OPTIONS_SELECTOR,
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的举报原因"
                return False
            report_page.wait_for_timeout(500)

            # “涉侵权相关”在网易页面上只展示材料清单和举报邮箱，不提供在线提交按钮。
            # 明确交给人工处理，避免后续找不到文本框时产生含糊的自动化错误。
            selected_reason = report_page.locator(
                netease.SELECTED_REASON_SELECTOR).first
            if (selected_reason.count() > 0 and
                    selected_reason.inner_text().strip() ==
                    netease.INFRINGEMENT_CATEGORY):
                self.errMessage = "网易涉侵权相关举报需按页面说明发送证明材料至举报邮箱"
                log_message(self.errMessage)
                return False

            # 步骤4: 填写意见。网易限制最多100字，超长时截断，避免前端校验拦截提交。
            raw_description = str(complaint_data.get('reason') or '').strip()
            description = netease.prepare_description(raw_description)
            if description:
                if len(raw_description) > netease.DESCRIPTION_MAX_LENGTH:
                    log_message("举报意见超过100字，已按网易限制截断")
                textarea = report_page.locator(netease.TEXTAREA_SELECTOR).first
                textarea.wait_for(state="visible", timeout=overTime)
                textarea.fill(description)
                log_message("步骤4: 已填写举报意见")

            # 步骤5: 上传证据图片（当前数据模型提供一张；网易页面上限为三张）。
            if complaint_data.get('file'):
                log_message("步骤5: 上传举报图片")
                if not self._upload_image(
                        report_page, complaint_data,
                        netease.UPLOAD_INPUT_SELECTOR):
                    self.errMessage = "举报图片上传失败"
                    return False
                try:
                    report_page.locator(
                        netease.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                            state="visible", timeout=30000)
                except Exception:
                    self.errMessage = "网易未确认举报图片上传成功"
                    log_message(self.errMessage, True)
                    return False

            # 步骤6: 提交。DebugRun 下只完成表单填写，不产生外部提交。
            log_message("步骤6: 点击提交按钮")
            submit_button = report_page.get_by_role("button", name="提交", exact=True)
            if submit_button.count() == 0:
                submit_button = report_page.locator(
                    netease.SUBMIT_FALLBACK_SELECTOR)
            submit_button.first.wait_for(state="visible", timeout=overTime)
            if not DebugRun:
                submit_button.first.click()
            log_message("网易投诉提交按钮已点击")
            report_page.wait_for_timeout(500)

            if not DebugRun:
                if self._check_submit_success(
                        report_page, netease.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    log_message(f"{complaint_data['id']}:未检测到成功标志！", True)

            # 步骤7: 保存举报结果截图。
            log_message("步骤7: 截图并上传到OSS")
            self._save_screenshot(report_page, complaint_data)

            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"网易投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
        finally:
            if popup_created and report_page:
                try:
                    report_page.close()
                    log_message("已关闭举报页面并返回主页面")
                except Exception:
                    pass
    #endregion

    #region 东方财富投诉流程
    def _eastmoney_complaint_flow(self, page, complaint_data):
        """东方财富资讯文章举报流程。"""
        overTime = 20000
        report_page = None
        popup_created = False

        try:
            url = complaint_data.get('link', eastmoney.HOME_URL)
            log_message("步骤1: 进入东方财富待举报文章")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)

            if (page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("内容不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            log_message("步骤2: 打开东方财富举报页面")
            report_entry = None
            for selector in eastmoney.REPORT_ENTRY_SELECTORS:
                entries = page.locator(selector)
                for index in range(entries.count() - 1, -1, -1):
                    candidate = entries.nth(index)
                    if candidate.is_visible():
                        report_entry = candidate
                        break
                if report_entry is not None:
                    break
            if report_entry is None:
                self.errMessage = "未找到东方财富举报入口"
                log_message(self.errMessage, True)
                return False

            pages_before = set(page.context.pages)
            report_entry.click()
            page.wait_for_timeout(2000)
            new_pages = [candidate for candidate in page.context.pages
                         if candidate not in pages_before]
            if new_pages:
                report_page = new_pages[-1]
                popup_created = True
            else:
                report_page = page

            report_page.wait_for_load_state("domcontentloaded", timeout=30000)
            report_page.wait_for_timeout(1500)
            if eastmoney.is_login_url(report_page.url):
                self.errMessage = "东方财富未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            report_page.locator(eastmoney.REASON_OPTIONS_SELECTOR).first.wait_for(
                state="visible", timeout=overTime)
            main_category = complaint_data.get('category')
            log_message(f"步骤3: 选择东方财富举报原因：{main_category}")
            if not self._select_reason(
                    report_page, main_category,
                    click_xpath_tpl=(
                        "//label[contains(@class,'typeText') and "
                        "normalize-space()='{text}']"),
                    options_selector=eastmoney.REASON_OPTIONS_SELECTOR,
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的东方财富举报原因"
                return False

            raw_description = str(complaint_data.get('reason') or '').strip()
            description = eastmoney.prepare_description(raw_description)
            if description:
                if len(raw_description) > eastmoney.DESCRIPTION_MAX_LENGTH:
                    log_message("举报描述超过300字，已按东方财富脚本限制截断")
                textarea = report_page.locator(eastmoney.TEXTAREA_SELECTOR).first
                textarea.wait_for(state="visible", timeout=overTime)
                textarea.fill(description)
                log_message("步骤4: 已填写举报描述")

            if complaint_data.get('file'):
                log_message("步骤5: 上传东方财富举报图片")
                report_page.locator(eastmoney.UPLOAD_INPUT_SELECTOR).first.wait_for(
                    state="attached", timeout=overTime)
                if not self._upload_image(
                        report_page, complaint_data,
                        eastmoney.UPLOAD_INPUT_SELECTOR):
                    self.errMessage = "东方财富举报图片上传失败"
                    return False
                try:
                    report_page.locator(
                        eastmoney.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                            state="visible", timeout=30000)
                except Exception:
                    self.errMessage = "东方财富未确认举报图片上传成功"
                    log_message(self.errMessage, True)
                    return False

            submit_button = report_page.locator(eastmoney.SUBMIT_SELECTOR).first
            submit_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤6: 已定位最终提交按钮（调试模式未点击）")
            else:
                log_message("步骤6: 点击东方财富最终提交按钮")
                submit_button.click()
                if self._check_submit_success(
                        report_page, eastmoney.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    self.errMessage = "东方财富未检测到提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(report_page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"东方财富投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
        finally:
            if popup_created and report_page:
                try:
                    report_page.close()
                except Exception:
                    pass
    #endregion

    #region 天天基金投诉流程
    def _tiantianfund_complaint_flow(self, page, complaint_data):
        """天天基金“基金吧”主帖举报流程。"""
        overTime = 20000
        report_page = None
        popup_created = False

        try:
            url = complaint_data.get('link', tiantianfund.HOME_URL)
            expected_target = tiantianfund.extract_post_target(url)
            if not all(expected_target):
                self.errMessage = "当前链接不是可举报的天天基金基金吧主帖"
                log_message(self.errMessage, True)
                return False

            log_message("步骤1: 进入天天基金基金吧待举报主帖")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)

            if (page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("帖子不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            if not tiantianfund.is_fundbar_post_url(
                    page.url, expected_target):
                self.errMessage = "天天基金基金吧跳转后的主帖地址不匹配"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开天天基金主帖举报页面")
            report_entry = page.locator(
                tiantianfund.REPORT_ENTRY_SELECTOR).first
            try:
                report_entry.wait_for(state="visible", timeout=overTime)
            except Exception:
                self.errMessage = "未找到天天基金基金吧主帖举报入口"
                log_message(self.errMessage, True)
                return False

            report_href = report_entry.get_attribute('href') or ''
            if not tiantianfund.report_link_matches_post(
                    report_href, page.url):
                self.errMessage = "天天基金举报入口参数与当前主帖不匹配"
                log_message(self.errMessage, True)
                return False

            pages_before = set(page.context.pages)
            report_entry.click()
            page.wait_for_timeout(2000)
            new_pages = [candidate for candidate in page.context.pages
                         if candidate not in pages_before]
            if new_pages:
                report_page = new_pages[-1]
                popup_created = True
            else:
                report_page = page

            report_page.wait_for_load_state("domcontentloaded", timeout=30000)
            report_page.wait_for_timeout(1500)
            if tiantianfund.is_login_url(report_page.url):
                self.errMessage = "天天基金未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            report_page.locator(
                tiantianfund.REASON_OPTIONS_SELECTOR).first.wait_for(
                    state="visible", timeout=overTime)
            main_category = str(
                complaint_data.get('category') or '').strip()
            raw_description = str(
                complaint_data.get('reason') or '').strip()
            category_source = "{} {}".format(
                main_category, raw_description).strip()

            log_message(f"步骤3: 选择天天基金举报原因：{main_category}")
            if not self._select_reason(
                    report_page, category_source,
                    click_xpath_tpl=(
                        "//label[contains(@class,'typeText') and "
                        "normalize-space()='{text}']"),
                    options_selector=tiantianfund.REASON_OPTIONS_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="举报原因"):
                self.errMessage = "未找到匹配的天天基金举报原因"
                return False

            description = tiantianfund.prepare_description(raw_description)
            if description:
                if len(raw_description) > tiantianfund.DESCRIPTION_MAX_LENGTH:
                    log_message("举报描述超过300字，已按天天基金举报中心限制截断")
                textarea = report_page.locator(
                    tiantianfund.TEXTAREA_SELECTOR).first
                textarea.wait_for(state="visible", timeout=overTime)
                textarea.fill(description)
                log_message("步骤4: 已填写天天基金举报描述")

            if complaint_data.get('file'):
                log_message("步骤5: 上传天天基金举报图片")
                report_page.locator(
                    tiantianfund.UPLOAD_INPUT_SELECTOR).first.wait_for(
                        state="attached", timeout=overTime)
                if not self._upload_image(
                        report_page, complaint_data,
                        tiantianfund.UPLOAD_INPUT_SELECTOR):
                    self.errMessage = "天天基金举报图片上传失败"
                    return False
                try:
                    report_page.locator(
                        tiantianfund.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                            state="visible", timeout=30000)
                except Exception:
                    self.errMessage = "天天基金未确认举报图片上传成功"
                    log_message(self.errMessage, True)
                    return False

            submit_button = report_page.locator(
                tiantianfund.SUBMIT_SELECTOR).first
            submit_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤6: 已定位天天基金最终提交按钮（调试模式未点击）")
            else:
                log_message("步骤6: 点击天天基金最终提交按钮")
                submit_button.click()
                if self._check_submit_success(
                        report_page, tiantianfund.SUCCESS_XPATH,
                        timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    self.errMessage = "天天基金未检测到提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(report_page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"天天基金投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
        finally:
            if popup_created and report_page:
                try:
                    report_page.close()
                except Exception:
                    pass
    #endregion

    #region 同花顺投诉流程
    def _tonghuashun_complaint_flow(self, page, complaint_data):
        """同花顺资讯文章“违法和不良信息”举报流程。"""
        overTime = 20000
        report_page = None
        popup_created = False

        try:
            url = complaint_data.get('link', tonghuashun.HOME_URL)
            log_message("步骤1: 进入同花顺待举报文章")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)

            if (page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("内容不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            entry = page.get_by_text(
                tonghuashun.REPORT_ENTRY_TEXT, exact=True).last
            if entry.count() == 0 or not entry.is_visible():
                self.errMessage = "未找到同花顺违法和不良信息举报入口"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开同花顺举报中心")
            pages_before = set(page.context.pages)
            entry.click()
            page.wait_for_timeout(2000)
            new_pages = [candidate for candidate in page.context.pages
                         if candidate not in pages_before]
            if new_pages:
                report_page = new_pages[-1]
                popup_created = True
            else:
                report_page = page

            if tonghuashun.is_login_url(report_page.url):
                self.errMessage = "同花顺未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            # 官方入口不携带文章地址；把 jump_url 放在 hash 之前，举报详情页会自动
            # 带入该链接，直接分类也会把它作为提交目标。
            report_page.goto(
                tonghuashun.build_report_url(url),
                wait_until="domcontentloaded", timeout=30000)
            report_page.wait_for_timeout(1000)
            if tonghuashun.is_login_url(report_page.url):
                self.errMessage = "同花顺未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            report_page.locator(
                tonghuashun.PRIMARY_REASON_SELECTOR).first.wait_for(
                    state="visible", timeout=overTime)
            main_category = complaint_data.get('category')
            log_message(f"步骤3: 选择同花顺举报原因：{main_category}")
            if not self._select_reason(
                    report_page, main_category,
                    click_xpath_tpl=(
                        "//*[contains(@class,'option-title') and "
                        "normalize-space()='{text}']"),
                    options_selector=tonghuashun.PRIMARY_REASON_SELECTOR,
                    ready_timeout=overTime, label="一级举报原因"):
                self.errMessage = "未找到匹配的同花顺举报原因"
                return False

            selected_primary = report_page.locator(
                ".option-item:has(.circle.choose) .option-title").first
            selected_primary_text = (
                selected_primary.inner_text().strip()
                if selected_primary.count() > 0 else "")
            if selected_primary_text == "涉企侵权":
                self.errMessage = (
                    "同花顺涉企侵权举报还需营业执照、授权书、身份证及联系人资料，"
                    "当前数据不足，需人工处理")
                log_message(self.errMessage)
                return False

            step_button = report_page.locator(
                tonghuashun.STEP_BUTTON_SELECTOR).first
            step_button.wait_for(state="visible", timeout=overTime)
            step_text = step_button.inner_text().strip()

            if step_text == "下一步":
                # “下一步”只做页面导航，不会产生举报请求，可以安全点击。
                log_message("步骤4: 进入同花顺举报详情页")
                step_button.click()
                report_page.locator(
                    tonghuashun.DETAIL_TEXTAREA_SELECTOR).first.wait_for(
                        state="visible", timeout=overTime)

                detail_options = report_page.locator(
                    tonghuashun.DETAIL_REASON_SELECTOR)
                if detail_options.count() > 0:
                    detail_source = "{} {}".format(
                        main_category or "", complaint_data.get('reason') or "")
                    if not self._select_reason(
                            report_page, detail_source,
                            click_xpath_tpl=(
                                "//*[contains(@class,'reason-item-text') and "
                                "normalize-space()='{text}']"),
                            options_selector=tonghuashun.DETAIL_REASON_SELECTOR,
                            ready_timeout=overTime, threshold=0.42,
                            label="具体违规理由"):
                        self.errMessage = "未找到匹配的同花顺具体违规理由"
                        return False

                # jump_url 正常会自动展示；若页面版本没有带入，则通过“添加链接”补填。
                link_items = report_page.locator(".link-item .link-text")
                if link_items.count() == 0:
                    report_page.locator(
                        tonghuashun.ADD_LINK_SELECTOR).first.click()
                    link_input = report_page.locator(
                        tonghuashun.LINK_INPUT_SELECTOR).first
                    link_input.wait_for(state="visible", timeout=overTime)
                    link_input.fill(url)
                    report_page.locator(
                        tonghuashun.LINK_CONFIRM_SELECTOR).first.click()

                raw_description = str(
                    complaint_data.get('reason') or '').strip()
                description = tonghuashun.prepare_description(raw_description)
                if not tonghuashun.description_is_valid(description):
                    self.errMessage = "同花顺举报内容描述不得少于10个字"
                    log_message(self.errMessage, True)
                    return False
                if len(raw_description) > tonghuashun.DESCRIPTION_MAX_LENGTH:
                    log_message("举报描述超过140字，已按同花顺普通举报页限制截断")
                report_page.locator(
                    tonghuashun.DETAIL_TEXTAREA_SELECTOR).first.fill(description)

                if not complaint_data.get('file'):
                    self.errMessage = "同花顺举报详情页要求至少上传一张举报截图"
                    log_message(self.errMessage, True)
                    return False
                log_message("步骤5: 上传同花顺举报图片")
                if not self._upload_image(
                        report_page, complaint_data,
                        tonghuashun.UPLOAD_INPUT_SELECTOR):
                    self.errMessage = "同花顺举报图片上传失败"
                    return False
                try:
                    report_page.locator(
                        tonghuashun.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                            state="visible", timeout=30000)
                except Exception:
                    self.errMessage = "同花顺未确认举报图片上传成功"
                    log_message(self.errMessage, True)
                    return False

                final_button = report_page.get_by_role(
                    "button", name=tonghuashun.FINAL_SUBMIT_TEXT,
                    exact=True).first
                final_button.wait_for(state="visible", timeout=overTime)
                if DebugRun:
                    log_message("步骤6: 已定位确认提交按钮（调试模式未点击）")
                else:
                    log_message("步骤6: 点击同花顺最终提交按钮")
                    final_button.click()
            elif step_text == "提交":
                # 这类一级原因没有详情页；当前按钮已经是最终提交按钮。
                if DebugRun:
                    log_message("步骤4: 已定位最终提交按钮（调试模式未点击）")
                else:
                    log_message("步骤4: 点击同花顺最终提交按钮")
                    step_button.click()
            else:
                self.errMessage = f"无法识别同花顺流程按钮：{step_text}"
                log_message(self.errMessage, True)
                return False

            if not DebugRun:
                if self._check_submit_success(
                        report_page, tonghuashun.SUCCESS_XPATH,
                        timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    self.errMessage = "同花顺未检测到提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(report_page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"同花顺投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
        finally:
            if popup_created and report_page:
                try:
                    report_page.close()
                except Exception:
                    pass
    #endregion

    #region 腾讯网投诉流程
    def _tencent_complaint_flow(self, page, complaint_data):
        """腾讯新闻文章举报流程。"""
        overTime = 15000

        try:
            log_message("步骤1: 进入指定的腾讯新闻文章")
            url = complaint_data.get('link', tencent.HOME_URL)
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)

            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("文章不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            logged_in_panel = page.locator(tencent.LOGGED_IN_SELECTOR)
            login_button = page.locator(tencent.LOGIN_BUTTON_SELECTOR)
            logged_in = tencent.is_logged_in_state(
                logged_in_panel.count() > 0 and
                logged_in_panel.first.is_visible(),
                login_button.count() > 0 and
                login_button.first.is_visible(),
            )
            if not logged_in:
                self.errMessage = "腾讯网未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            report_entry = page.locator(tencent.REPORT_ENTRY_SELECTOR).first
            if report_entry.count() == 0 or not report_entry.is_visible():
                self.errMessage = "未找到腾讯新闻举报入口"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开腾讯新闻举报弹窗")
            report_entry.click()
            page.get_by_text(
                tencent.REPORT_MODAL_TITLE, exact=True).wait_for(
                    state="visible", timeout=overTime)
            page.locator(tencent.REASON_OPTIONS_SELECTOR).first.wait_for(
                state="visible", timeout=overTime)

            main_category = complaint_data.get('category')
            log_message(f"步骤3: 选择腾讯新闻举报原因：{main_category}")
            if not self._select_reason(
                    page, main_category,
                    click_xpath_tpl=(
                        "//*[normalize-space()='{text}' and "
                        "ancestor::*[.//*[normalize-space()='请选择举报原因']]]"
                    ),
                    options_selector=tencent.REASON_OPTIONS_SELECTOR,
                    ready_timeout=overTime, label="举报原因"):
                self.errMessage = "未找到匹配的腾讯新闻举报原因"
                return False

            final_button = page.get_by_text(
                tencent.SUBMIT_TEXT, exact=True).first
            final_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤4: 已定位腾讯最终提交按钮（调试模式未点击）")
            else:
                log_message("步骤4: 点击腾讯最终提交按钮")
                final_button.click()

            if not DebugRun:
                if self._check_submit_success(
                        page, tencent.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    self.errMessage = "腾讯网未检测到举报成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"腾讯网投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
    #endregion

    #region 雪球网投诉流程
    def _xueqiu_complaint_flow(self, page, complaint_data):
        """雪球帖子投诉流程。"""
        overTime = 15000

        try:
            log_message("步骤1: 进入指定的雪球帖子")
            url = complaint_data.get('link', xueqiu.HOME_URL)
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)
            body_text = page.locator("body").inner_text(timeout=3000)[:1500]

            if xueqiu.is_verification_page(page.url, page.title(), body_text):
                self.errMessage = "雪球页面触发安全验证，需人工完成验证后重试"
                log_message(self.errMessage, True)
                return False
            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("帖子不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            user_id = page.evaluate(
                "() => window.SNOWMAN_USER && window.SNOWMAN_USER.id")
            if not xueqiu.is_logged_in_user_id(user_id):
                self.errMessage = "雪球网未登录或登录状态已失效"
                log_message(self.errMessage, True)
                return False

            report_entry = page.locator(xueqiu.REPORT_ENTRY_SELECTOR).first
            if report_entry.count() == 0 or not report_entry.is_visible():
                self.errMessage = "未找到雪球帖子投诉入口"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开雪球帖子投诉弹窗")
            report_entry.click()
            title = page.locator(xueqiu.REPORT_TITLE_SELECTOR).first
            title.wait_for(state="visible", timeout=overTime)
            if title.inner_text().strip() != xueqiu.REPORT_TITLE:
                self.errMessage = "雪球投诉弹窗标题异常"
                return False
            page.locator(xueqiu.PRIMARY_REASON_SELECTOR).first.wait_for(
                state="visible", timeout=overTime)

            main_category = complaint_data.get('category')
            description_source = str(complaint_data.get('reason') or '')
            category_source = "{} {}".format(
                main_category or "", description_source).strip()
            log_message(f"步骤3: 选择雪球投诉原因：{main_category}")
            if not self._select_reason(
                    page, category_source,
                    click_xpath_tpl=(
                        "//*[contains(@class,'confirm--report')]"
                        "//*[contains(@class,'tagStyle') and "
                        "normalize-space()='{text}']"
                    ),
                    options_selector=xueqiu.PRIMARY_REASON_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="一级投诉原因"):
                self.errMessage = "未找到匹配的雪球一级投诉原因"
                return False

            selected_primary_node = page.locator(
                xueqiu.SELECTED_PRIMARY_SELECTOR).first
            selected_primary_node.wait_for(state="visible", timeout=overTime)
            selected_primary = selected_primary_node.inner_text().strip()

            if xueqiu.requires_manual_infringement(selected_primary):
                self.errMessage = (
                    "雪球侵权投诉会进入独立实名及证明材料流程，当前数据不足，"
                    "需人工处理")
                log_message(self.errMessage)
                return False

            selected_secondary = ""
            if selected_primary in xueqiu.SECONDARY_CATEGORIES:
                page.locator(xueqiu.SECONDARY_REASON_SELECTOR).first.wait_for(
                    state="visible", timeout=overTime)
                log_message("步骤4: 选择雪球详细投诉内容")
                if not self._select_reason(
                        page, category_source,
                        click_xpath_tpl=(
                            "//*[contains(@class,'confirm--report')]"
                            "//*[contains(@class,'tagStyle') and "
                            "normalize-space()='{text}']"
                        ),
                        options_selector=xueqiu.SECONDARY_REASON_SELECTOR,
                        ready_timeout=overTime, threshold=0.40,
                        label="详细投诉内容"):
                    self.errMessage = "未找到匹配的雪球详细投诉内容"
                    return False
                selected_secondary_node = page.locator(
                    xueqiu.SELECTED_SECONDARY_SELECTOR).first
                selected_secondary_node.wait_for(
                    state="visible", timeout=overTime)
                selected_secondary = selected_secondary_node.inner_text().strip()

            raw_description = description_source.strip()
            description = xueqiu.prepare_description(raw_description)
            if (xueqiu.description_required(
                    selected_primary, selected_secondary) and
                    not description):
                self.errMessage = "当前雪球投诉原因要求填写投诉描述"
                log_message(self.errMessage, True)
                return False
            if len(raw_description) > xueqiu.DESCRIPTION_MAX_LENGTH:
                log_message("投诉描述超过300字，已按雪球普通投诉弹窗限制截断")
            if description:
                textarea = page.locator(xueqiu.TEXTAREA_SELECTOR).first
                textarea.wait_for(state="visible", timeout=overTime)
                textarea.fill(description)

            if complaint_data.get('file'):
                log_message("步骤5: 上传雪球投诉证明材料")
                if not self._upload_image(
                        page, complaint_data,
                        xueqiu.UPLOAD_INPUT_SELECTOR):
                    self.errMessage = "雪球投诉证明材料上传失败"
                    return False
                try:
                    page.locator(xueqiu.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                        state="visible", timeout=30000)
                except Exception:
                    self.errMessage = "雪球未确认投诉证明材料上传成功"
                    log_message(self.errMessage, True)
                    return False

            final_button = page.locator(xueqiu.SUBMIT_SELECTOR).first
            final_button.wait_for(state="visible", timeout=overTime)
            if "grayBtn" in (final_button.get_attribute("class") or ""):
                self.errMessage = "雪球最终提交按钮仍处于不可用状态"
                log_message(self.errMessage, True)
                return False
            if DebugRun:
                log_message("步骤6: 已定位雪球最终提交按钮（调试模式未点击）")
            else:
                log_message("步骤6: 点击雪球最终提交按钮")
                final_button.click()

            if not DebugRun:
                if self._check_submit_success(
                        page, xueqiu.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:投诉提交成功!")
                else:
                    self.errMessage = "雪球未检测到投诉提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"雪球投诉流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
    #endregion

    #region 富途牛牛投诉流程
    def _futu_complaint_flow(self, page, complaint_data):
        """富途牛牛“牛牛圈”帖子举报流程。"""
        overTime = 20000

        try:
            log_message("步骤1: 进入指定的富途牛牛圈帖子")
            url = complaint_data.get('link', futu.COMMUNITY_HOME_URL)
            expected_feed_id = futu.extract_feed_id(url)
            if not expected_feed_id:
                self.errMessage = "当前链接不是有效的富途牛牛圈帖子地址"
                log_message(self.errMessage, True)
                return False

            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)
            if not futu.is_feed_url(page.url, expected_feed_id):
                self.errMessage = "富途牛牛圈帖子跳转后的地址与原帖子不一致"
                log_message(self.errMessage, True)
                return False
            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("帖子不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            page.wait_for_function(
                "() => Boolean(window.__INITIAL_STATE__ && "
                "window.__INITIAL_STATE__.common && "
                "window.__INITIAL_STATE__.detail)",
                timeout=overTime)
            page_state = page.evaluate(futu.REPORT_PAGE_STATE_SCRIPT)
            if str(page_state.get('feedId') or '') != expected_feed_id:
                self.errMessage = "富途牛牛圈页面 feedId 与目标帖子不一致"
                log_message(self.errMessage, True)
                return False
            if page_state.get('canReport') is not True:
                self.errMessage = "当前富途牛牛圈帖子不提供举报权限"
                log_message(self.errMessage, True)
                return False
            if not self._futu_has_authenticated_session(page):
                self.errMessage = "富途牛牛圈帖子举报必须先登录富途账号"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开富途牛牛圈举报弹层")
            report_entry = page.locator(futu.REPORT_ENTRY_SELECTOR).first
            if (report_entry.count() == 0 or
                    not report_entry.is_visible()):
                more = page.locator(futu.REPORT_MORE_SELECTOR).first
                if more.count() == 0 or not more.is_visible():
                    self.errMessage = "未找到富途牛牛圈帖子更多操作入口"
                    log_message(self.errMessage, True)
                    return False
                more.click()
                page.locator(futu.REPORT_MENU_SELECTOR).wait_for(
                    state="visible", timeout=overTime)
                report_entry = page.locator(
                    futu.REPORT_ENTRY_SELECTOR).last

            report_entry.wait_for(state="visible", timeout=overTime)
            report_entry.click()
            page.locator(futu.REPORT_DIALOG_SELECTOR).wait_for(
                state="visible", timeout=overTime)
            page.locator(futu.REPORT_OPTIONS_SELECTOR).first.wait_for(
                state="visible", timeout=overTime)

            main_category = str(
                complaint_data.get('category') or '').strip()
            description_source = str(
                complaint_data.get('reason') or '').strip()
            category_source = "{} {}".format(
                main_category, description_source).strip()
            log_message(f"步骤3: 选择富途牛牛圈举报原因：{main_category}")
            if not self._select_reason(
                    page, category_source,
                    click_xpath_tpl=(
                        "//*[contains(@class,'report-dialog')]"
                        "//*[contains(@class,'sns-operate-items__item-title') "
                        "and normalize-space()='{text}']"
                    ),
                    options_selector=futu.REPORT_OPTIONS_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="举报原因"):
                self.errMessage = "未找到匹配的富途牛牛圈举报原因"
                return False

            page.wait_for_timeout(350)
            input_content = page.locator(futu.INPUT_CONTENT_SELECTOR).first
            has_extra_step = (
                input_content.count() > 0 and input_content.is_visible()
            )
            if has_extra_step:
                log_message("步骤4: 填写富途举报补充说明或证明材料")
                if not description_source and not complaint_data.get('file'):
                    self.errMessage = (
                        "当前富途举报原因要求提供补充说明或证明材料")
                    log_message(self.errMessage, True)
                    return False

                description = futu.prepare_description(description_source)
                if futu.description_units(description_source.strip()) > \
                        futu.DESCRIPTION_LIMIT_UNITS:
                    log_message(
                        "举报说明超过富途400加权单位限制，已安全截断")
                if description:
                    textarea = page.locator(futu.TEXTAREA_SELECTOR).first
                    textarea.wait_for(state="visible", timeout=overTime)
                    textarea.fill(description)

                if complaint_data.get('file'):
                    log_message("步骤5: 上传富途举报证明图片")
                    if not self._upload_image(
                            page, complaint_data,
                            futu.UPLOAD_INPUT_SELECTOR):
                        self.errMessage = "富途举报证明图片上传失败"
                        return False
                    try:
                        page.locator(
                            futu.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                                state="visible", timeout=30000)
                    except Exception:
                        self.errMessage = "富途未确认举报证明图片上传成功"
                        log_message(self.errMessage, True)
                        return False
            else:
                selected = page.locator(
                    futu.SELECTED_REASON_SELECTOR).first
                selected.wait_for(state="visible", timeout=overTime)
                selected_category = futu.normalize_option_text(
                    selected.inner_text())
                log_message(f"富途已选择举报原因：{selected_category}")
                if description_source:
                    log_message("当前富途举报原因不接收补充说明，将仅使用举报原因")
                if complaint_data.get('file'):
                    log_message("当前富途举报原因不进入证明图片上传步骤")

            final_button = page.locator(futu.SUBMIT_SELECTOR).last
            final_button.wait_for(state="visible", timeout=overTime)
            if not final_button.is_enabled():
                self.errMessage = "富途最终提交按钮仍处于不可用状态"
                log_message(self.errMessage, True)
                return False

            if DebugRun:
                log_message("步骤6: 已定位富途最终提交按钮（调试模式未点击）")
            else:
                # 填写期间会话可能失效；最终点击前再次通过只读接口复核，
                # 失败时绝不触发最终提交。
                if not self._futu_has_authenticated_session(page):
                    self.errMessage = (
                        "富途登录状态只读复核失败，未点击最终提交")
                    log_message(self.errMessage, True)
                    return False
                log_message("步骤6: 点击富途最终提交按钮")
                final_button.click()

            if not DebugRun:
                if self._check_submit_success(
                        page, futu.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:举报提交成功!")
                else:
                    self.errMessage = "富途未检测到举报提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"富途举报流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
    #endregion

    #region 新浪网投诉流程
    def _sina_community_complaint_flow(
            self, page, complaint_data, report_url, post_id, overTime):
        """新浪新闻 shequn/tiezi 社群帖的“我要反馈”流程。"""
        log_message("步骤2: 打开新浪社群帖子反馈表单")
        page.goto(report_url, wait_until="domcontentloaded", timeout=30000)
        page.locator(sina.COMMUNITY_FORM_SELECTOR).wait_for(
            state="visible", timeout=overTime)
        if not sina.is_community_feedback_page(
                page.url, post_id, page.title()):
            self.errMessage = "新浪社群帖子反馈表单地址或标识异常"
            log_message(self.errMessage, True)
            return False

        main_category = str(
            complaint_data.get('category') or '').strip()
        description_source = str(
            complaint_data.get('reason') or '').strip()
        category_source = "{} {}".format(
            main_category, description_source).strip()

        log_message(f"步骤3: 选择新浪社群举报类型：{main_category}")
        if not self._select_reason(
                page, category_source,
                click_xpath_tpl=(
                    "//form[@id='error-form']"
                    "//label[normalize-space()='{text}']"
                ),
                options_selector=sina.COMMUNITY_REPORT_OPTIONS_SELECTOR,
                ready_timeout=overTime, threshold=0.42,
                label="社群举报类型"):
            self.errMessage = "未找到匹配的新浪社群举报类型"
            return False

        selected = page.locator(
            sina.COMMUNITY_SELECTED_REASON_SELECTOR).first
        selected.wait_for(state="attached", timeout=overTime)
        selected_category = sina.normalize_option_text(
            selected.locator("xpath=..").inner_text())
        log_message(f"新浪社群已选择举报类型：{selected_category}")

        description = sina.prepare_community_description(
            description_source)
        if (sina.community_description_units(description_source.strip()) >
                sina.COMMUNITY_DESCRIPTION_LIMIT):
            log_message("新浪社群举报说明超过140字符限制，已安全截断")
        if description:
            page.locator(sina.COMMUNITY_TEXTAREA_SELECTOR).first.fill(
                description)
            log_message("步骤4: 已填写新浪社群举报说明")
        if complaint_data.get('file'):
            log_message("新浪社群反馈表单不提供证明图片上传字段")

        page.wait_for_timeout(200)
        final_button = page.locator(sina.COMMUNITY_SUBMIT_SELECTOR).first
        final_button.wait_for(state="visible", timeout=overTime)
        button_classes = final_button.get_attribute("class") or ""
        if sina.COMMUNITY_READY_SUBMIT_CLASS not in button_classes.split():
            self.errMessage = "新浪社群最终提交按钮仍处于不可用状态"
            log_message(self.errMessage, True)
            return False

        if DebugRun:
            log_message("步骤5: 已定位新浪社群最终提交按钮（调试模式未点击）")
        else:
            log_message("步骤5: 点击新浪社群最终提交按钮")
            final_button.click()
            if self._check_submit_success(
                    page, sina.COMMUNITY_SUCCESS_XPATH, timeout=5000):
                log_message(f"{complaint_data['platform']}:社群帖子举报提交成功!")
            else:
                self.errMessage = "新浪社群未检测到举报提交成功标志"
                log_message(self.errMessage, True)
                return False

        self._save_screenshot(page, complaint_data)
        return True

    def _sina_complaint_flow(self, page, complaint_data):
        """新浪新闻普通文章与 shequn/tiezi 社群帖举报流程。"""
        overTime = 15000

        try:
            log_message("步骤1: 进入指定的新浪文章")
            url = complaint_data.get('link', sina.HOME_URL)
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)

            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("文章不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            community_post_id = sina.extract_community_post_id(page.url)
            if community_post_id:
                script_sources = page.locator(
                    "script:not([src])").all_text_contents()
                report_url = sina.extract_community_feedback_url(
                    script_sources, community_post_id)
                if not report_url:
                    self.errMessage = "未找到新浪社群帖子官方反馈地址"
                    log_message(self.errMessage, True)
                    return False
                return self._sina_community_complaint_flow(
                    page, complaint_data, report_url,
                    community_post_id, overTime)

            metadata = page.locator("meta[name='sudameta']").evaluate_all(
                "els => els.map(el => el.content || '')")
            doc_id = sina.extract_doc_id(page.url, metadata)
            if not doc_id:
                self.errMessage = "无法从新浪文章地址或页面元数据提取docId"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开新浪文章举报表单")
            report_url = sina.build_report_url(page.url, metadata)
            page.goto(report_url, wait_until="domcontentloaded", timeout=30000)
            page.locator(sina.FORM_SELECTOR).wait_for(
                state="visible", timeout=overTime)
            if not sina.is_report_page(page.url, page.title()):
                self.errMessage = "新浪举报表单地址或标题异常"
                log_message(self.errMessage, True)
                return False

            page.wait_for_timeout(1000)
            login_state = page.evaluate(
                "() => Boolean(window.SINA_OUTLOGIN_LAYER && "
                "window.SINA_OUTLOGIN_LAYER.isLogin())")
            if not sina.is_logged_in_state(login_state):
                self.errMessage = "新浪文章举报必须先登录新浪账号"
                log_message(self.errMessage, True)
                return False

            main_category = str(
                complaint_data.get('category') or '').strip()
            description_source = str(
                complaint_data.get('reason') or '').strip()
            category_source = "{} {}".format(
                main_category, description_source).strip()

            log_message(f"步骤3: 选择新浪举报类型：{main_category}")
            if not self._select_reason(
                    page, category_source,
                    click_xpath_tpl=(
                        "//form[@bbs-node-type='reportForm']"
                        "//label[normalize-space()='{text}']"
                    ),
                    options_selector=sina.REPORT_OPTIONS_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="举报类型"):
                self.errMessage = "未找到匹配的新浪举报类型"
                return False

            selected = page.locator(sina.SELECTED_REASON_SELECTOR).first
            selected.wait_for(state="attached", timeout=overTime)
            selected_category = sina.normalize_option_text(
                selected.locator("xpath=..").inner_text())
            log_message(f"新浪已选择举报类型：{selected_category}")

            if description_source:
                log_message("新浪当前文章举报表单不接收文字说明，将仅使用举报类型")
            if complaint_data.get('file'):
                log_message("新浪当前文章举报表单不提供证明图片上传字段")

            final_button = page.locator(sina.SUBMIT_SELECTOR).first
            final_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤4: 已定位新浪最终提交按钮（调试模式未点击）")
            else:
                # 提交脚本本身也会复核登录态；这里再次保守检查，避免会话在表单
                # 填写过程中失效后误触登录弹窗。
                login_state = page.evaluate(
                    "() => Boolean(window.SINA_OUTLOGIN_LAYER && "
                    "window.SINA_OUTLOGIN_LAYER.isLogin())")
                if not sina.is_logged_in_state(login_state):
                    self.errMessage = "新浪登录状态已失效，未点击最终提交"
                    log_message(self.errMessage, True)
                    return False
                log_message("步骤4: 点击新浪最终提交按钮")
                final_button.click()

            if not DebugRun:
                if self._check_submit_success(
                        page, sina.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:举报提交成功!")
                else:
                    self.errMessage = "新浪未检测到举报提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"新浪举报流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
    #endregion

    #region 一点号（一点资讯）投诉流程
    def _yidianzixun_complaint_flow(self, page, complaint_data):
        """一点号内容在一点资讯文章页的举报流程。"""
        overTime = 15000

        try:
            log_message("步骤1: 进入指定的一点资讯文章")
            url = complaint_data.get('link', yidian.HOME_URL)
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)

            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("文章不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            doc_id = yidian.extract_doc_id(page.url)
            if not doc_id or not yidian.is_article_page(page.url, doc_id):
                self.errMessage = "当前链接不是有效的一点资讯文章地址"
                log_message(self.errMessage, True)
                return False

            page.locator(yidian.REPORT_FORM_SELECTOR).wait_for(
                state="attached", timeout=overTime)
            page.wait_for_function(
                "() => Boolean(window.yidian && window.yidian.docinfo)",
                timeout=overTime)
            article_state = page.evaluate("""
                () => ({
                    docid: window.yidian.docinfo.doc &&
                        window.yidian.docinfo.doc.docid,
                    isLogin: window.yidian.docinfo.is_login
                })
            """)
            if str(article_state.get('docid') or '') != doc_id:
                self.errMessage = "一点资讯文章docid与页面状态不一致"
                log_message(self.errMessage, True)
                return False
            if not yidian.is_logged_in_state(article_state.get('isLogin')):
                self.errMessage = "一点资讯文章举报必须先登录一点资讯账号"
                log_message(self.errMessage, True)
                return False

            log_message("步骤2: 打开一点资讯文章举报弹窗")
            report_entry = page.locator(yidian.REPORT_ENTRY_SELECTOR).first
            if report_entry.count() == 0:
                self.errMessage = "未找到一点资讯文章举报入口"
                log_message(self.errMessage, True)
                return False
            report_entry.wait_for(state="visible", timeout=overTime)
            report_entry.click()
            page.locator(yidian.REPORT_POPUP_SELECTOR).wait_for(
                state="visible", timeout=overTime)
            page.locator(yidian.REPORT_OPTIONS_SELECTOR).first.wait_for(
                state="visible", timeout=overTime)

            main_category = str(
                complaint_data.get('category') or '').strip()
            description_source = str(
                complaint_data.get('reason') or '').strip()
            category_source = "{} {}".format(
                main_category, description_source).strip()

            log_message(f"步骤3: 选择一点资讯举报原因：{main_category}")
            if not self._select_reason(
                    page, category_source,
                    click_xpath_tpl=(
                        "//form[contains(@class,'report-article-form')]"
                        "//li[normalize-space()='{text}']"
                    ),
                    options_selector=yidian.REPORT_OPTIONS_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="举报原因"):
                self.errMessage = "未找到匹配的一点资讯举报原因"
                return False

            selected = page.locator(yidian.SELECTED_REASON_SELECTOR).first
            selected.wait_for(state="visible", timeout=overTime)
            selected_category = yidian.normalize_option_text(
                selected.inner_text())
            log_message(f"一点资讯已选择举报原因：{selected_category}")

            if description_source:
                log_message("一点资讯普通文章举报表单不接收文字说明，将仅使用举报原因")
            if complaint_data.get('file'):
                log_message("一点资讯普通文章举报表单不提供证明图片上传字段")

            final_button = page.locator(yidian.SUBMIT_SELECTOR).first
            final_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤4: 已定位一点资讯最终提交按钮（调试模式未点击）")
            else:
                # 填写期间会话可能失效；最终点击前再次以页面公开登录态保守复核。
                login_state = page.evaluate(
                    "() => window.yidian && window.yidian.docinfo && "
                    "window.yidian.docinfo.is_login")
                if not yidian.is_logged_in_state(login_state):
                    self.errMessage = "一点资讯登录状态已失效，未点击最终提交"
                    log_message(self.errMessage, True)
                    return False
                log_message("步骤4: 点击一点资讯最终提交按钮")
                final_button.click()

            if not DebugRun:
                if self._check_submit_success(
                        page, yidian.SUCCESS_XPATH, timeout=10000):
                    log_message(f"{complaint_data['platform']}:举报提交成功!")
                else:
                    self.errMessage = "一点资讯未检测到举报提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"一点资讯举报流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
    #endregion

    #region 搜狐网投诉流程
    def _sohu_complaint_flow(self, page, complaint_data):
        """搜狐文章右上角菜单“举报/反馈”流程，兼容旧 PC 入口。"""
        overTime = 20000
        report_page = None
        popup_created = False

        try:
            url = complaint_data.get('link', sohu.HOME_URL)
            log_message("步骤1: 进入指定的搜狐文章")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)

            if (page.get_by_text("内容不存在", exact=False).count() > 0 or
                    page.get_by_text("页面不存在", exact=False).count() > 0 or
                    page.get_by_text("文章不存在", exact=False).count() > 0):
                self.errMessage = "未找到页面……链接已失效？"
                log_message(self.errMessage)
                return True

            report_entry = page.locator(sohu.REPORT_ENTRY_SELECTOR).first
            if report_entry.count() == 0 or not report_entry.is_visible():
                log_message("步骤2: 打开搜狐文章右上角三点菜单")
                more_button = page.locator(sohu.MOBILE_MORE_SELECTOR).first
                if more_button.count() == 0 or not more_button.is_visible():
                    self.errMessage = "未找到搜狐文章右上角三点菜单"
                    log_message(self.errMessage, True)
                    return False
                more_button.click()
                report_entry = page.locator(
                    sohu.MOBILE_REPORT_ENTRY_SELECTOR).first
                try:
                    report_entry.wait_for(
                        state="visible", timeout=overTime)
                except Exception:
                    self.errMessage = "未找到搜狐菜单中的举报/反馈入口"
                    log_message(self.errMessage, True)
                    return False

            report_href = report_entry.get_attribute('href') or ''
            if not sohu.report_link_matches_article(report_href, page.url):
                self.errMessage = "搜狐举报入口未绑定当前文章"
                log_message(self.errMessage, True)
                return False

            log_message("步骤3: 打开搜狐内容举报页面")
            pages_before = set(page.context.pages)
            report_entry.click()
            page.wait_for_timeout(2500)
            new_pages = [candidate for candidate in page.context.pages
                         if candidate not in pages_before]
            if new_pages:
                report_page = new_pages[-1]
                popup_created = True
            else:
                report_page = page

            report_page.wait_for_load_state(
                "domcontentloaded", timeout=30000)
            report_page.get_by_text(
                sohu.REPORT_HEADING, exact=True).wait_for(
                    state="visible", timeout=overTime)
            if not sohu.is_report_page(report_page.url, report_page.title()):
                self.errMessage = "搜狐内容举报页面地址或标题异常"
                log_message(self.errMessage, True)
                return False

            active_report_tab = report_page.locator(
                sohu.ACTIVE_REPORT_TAB_SELECTOR).first
            if active_report_tab.count() > 0:
                active_report_tab.wait_for(state="visible", timeout=overTime)
                if active_report_tab.inner_text().strip() != sohu.REPORT_HEADING:
                    self.errMessage = "搜狐反馈页当前未处于内容举报标签"
                    log_message(self.errMessage, True)
                    return False

            reasons = report_page.locator(sohu.REASON_OPTIONS_SELECTOR)
            reasons.first.wait_for(state="visible", timeout=overTime)
            actual_categories = tuple(
                text.strip() for text in reasons.all_inner_texts())

            main_category = str(complaint_data.get('category') or '').strip()
            description_source = str(
                complaint_data.get('reason') or '').strip()
            category_source = "{} {}".format(
                main_category, description_source).strip()

            # 侵权和抄袭类别点击后会立即要求登录，并展开身份证、权属材料、
            # 联系方式及承诺协议等字段；现有投诉数据不足，点击前先转人工。
            manual_match = sohu.manual_identity_category_from_input(
                main_category, description_source)
            if manual_match:
                self.errMessage = (
                    f"搜狐{manual_match}举报要求登录并提交身份、权属证明及"
                    "联系方式，当前数据不足，需人工处理")
                log_message(self.errMessage)
                return False

            log_message(f"步骤4: 选择搜狐问题类型：{main_category}")
            if not self._select_reason(
                    report_page, category_source,
                    click_xpath_tpl=(
                        "//*[contains(@class,'report-content')]"
                        "//*[contains(@class,'reason-label') and "
                        "normalize-space()='{text}']"
                    ),
                    options_selector=sohu.REASON_OPTIONS_SELECTOR,
                    ready_timeout=overTime, threshold=0.42,
                    label="问题类型"):
                self.errMessage = "未找到匹配的搜狐问题类型"
                return False

            selected_reason = report_page.locator(
                sohu.SELECTED_REASON_SELECTOR).first
            selected_reason.wait_for(state="visible", timeout=overTime)
            selected_category = selected_reason.inner_text().strip()
            if sohu.requires_manual_identity_flow(selected_category):
                self.errMessage = (
                    f"搜狐{selected_category}举报要求登录并提交身份、权属证明及"
                    "联系方式，当前数据不足，需人工处理")
                log_message(self.errMessage)
                return False

            description = sohu.prepare_description(description_source)
            if description:
                if len(description_source) > sohu.DESCRIPTION_MAX_LENGTH:
                    log_message("问题描述超过300字，已按搜狐页面限制截断")
                textarea = report_page.locator(sohu.TEXTAREA_SELECTOR).first
                textarea.wait_for(state="visible", timeout=overTime)
                textarea.fill(description)
                log_message("步骤5: 已填写搜狐问题描述")

            if complaint_data.get('file'):
                body_text = report_page.locator("body").inner_text(
                    timeout=5000)
                if sohu.is_anonymous_upload_state(body_text):
                    log_message(
                        "搜狐当前为匿名举报状态，截图仅登录后可上传；"
                        "本次继续使用无附件举报")
                else:
                    log_message("步骤6: 上传搜狐举报截图")
                    if not self._upload_image(
                            report_page, complaint_data,
                            sohu.UPLOAD_INPUT_SELECTOR):
                        self.errMessage = "搜狐举报截图上传失败"
                        return False
                    try:
                        report_page.locator(
                            sohu.UPLOAD_SUCCESS_SELECTOR).last.wait_for(
                                state="visible", timeout=30000)
                    except Exception:
                        self.errMessage = "搜狐未确认举报截图上传成功"
                        log_message(self.errMessage, True)
                        return False

            final_button = report_page.locator(sohu.SUBMIT_SELECTOR).first
            final_button.wait_for(state="visible", timeout=overTime)
            if DebugRun:
                log_message("步骤7: 已定位搜狐最终提交按钮（调试模式未点击）")
            else:
                log_message("步骤7: 点击搜狐最终提交按钮")
                final_button.click()

            if not DebugRun:
                report_page.wait_for_timeout(800)
                body_text = report_page.locator("body").inner_text(
                    timeout=5000)
                if sohu.is_captcha_challenge(body_text):
                    self.errMessage = "搜狐提交触发图形验证码，需人工完成后重试"
                    log_message(self.errMessage)
                    return False
                if self._check_submit_success(
                        report_page, sohu.SUCCESS_XPATH, timeout=5000):
                    log_message(f"{complaint_data['platform']}:举报提交成功!")
                else:
                    self.errMessage = "搜狐未检测到举报提交成功标志"
                    log_message(self.errMessage, True)
                    return False

            self._save_screenshot(report_page, complaint_data)
            return True

        except Exception as e:
            self.errMessage = self.errMessage or f"搜狐举报流程执行失败: {e}"
            log_message(self.errMessage, True)
            return False
        finally:
            if popup_created and report_page:
                try:
                    report_page.close()
                except Exception:
                    pass
    #endregion
    
    #region Flow Control Methods
    def _category_candidates(self, raw_text):
        """把数据库类别文本转成一组“待尝试的候选文本”：
        归一化主值优先，其后是拆分出的各多值分量（去重、去空）。
        """
        from category_matcher import normalize_category, split_categories
        candidates = []
        norm = normalize_category(raw_text)
        if norm:
            candidates.append(norm)
        for c in split_categories(raw_text):
            if c and c not in candidates:
                candidates.append(c)
        return candidates

    def _enum_texts(self, scope, selector, cap=120):
        """枚举 selector 命中元素的可见文本，返回 (locator, [文本...])，索引对齐。

        UI 动作词（取消/确认/提交/搜索…）置空，从候选中剔除，避免被误选后提前提交。
        置空而非删除是为了保持与 locator 的索引对齐（loc.nth(i) 仍然有效）。
        """
        loc = scope.locator(selector)
        try:
            n = min(loc.count(), cap)
        except Exception:
            return loc, []
        texts = []
        for i in range(n):
            try:
                t = loc.nth(i).inner_text(timeout=1200).strip()
            except Exception:
                t = ""
            texts.append("" if t in _ACTION_WORDS else t)
        return loc, texts

    def _select_reason(self, scope, raw_text, click_xpath_tpl=None,
                       options_selector=None, options_fallback=None,
                       click_relative=None, ready_timeout=10000,
                       threshold=0.5, label="举报原因"):
        """把（可能被 AI 改写、会漂移的）数据库类别文本，动态归类到“平台当前真实
        存在的选项”并点击。这样即使库里今天写“不实信息”、明天写“虚假、不实信息”，
        也能就近归到平台真实类别。

        路径A（枚举归类，首选）：抓取 options_selector 命中的“平台真实选项”文本，
            对（归一化主值 + 拆分分量）逐个跑 best_match，取全局最优；达阈值即点击
            loc.nth(idx)（可再按 click_relative 落到实际可点节点）。
        路径B（文本直连，兜底）：用 click_xpath_tpl 按候选文本 contains 定位点击，
            用于没有可靠 options_selector 或路径A未达阈值时。

        Args:
            scope:            Page / popup_page（需支持 wait_for_selector、locator）
            raw_text:         数据库里的类别文本（可能带序号/JSON数组/顿号连接/换说法）
            click_xpath_tpl:  含 {text} 占位的 XPath（路径B用），如 "//label[contains(text(),'{text}')]"
            options_selector: 枚举“平台真实选项”文本节点的选择器（路径A用）
            options_fallback: options_selector 抓到过少时的备用枚举选择器（如抖音 '//span'）
            click_relative:   命中后相对点击的节点，如抖音传 'xpath=..' 点父级格子
            threshold:        归类相似度阈值，低于则不自动选（转路径B或判失败）
        Returns:
            True 选中并点击成功；False 未能选择。
        """
        from category_matcher import best_match, semantic_alias_match

        # 候选文本：归一化主值 + 拆分出的各多值分量（去重、去空）
        candidates = self._category_candidates(raw_text)
        if not candidates:
            log_message(f"{label}为空，跳过选择：raw='{raw_text}'")
            return False

        # 等待选项区域渲染（优先用容器选择器，否则用首个候选的直连定位作就绪信号）
        ready_probe = options_selector or (
            click_xpath_tpl.format(text=candidates[0]) if click_xpath_tpl else None)
        if ready_probe:
            try:
                scope.wait_for_selector(ready_probe, timeout=ready_timeout)
            except Exception:
                pass  # 探针未命中也继续

        # 路径A：枚举平台真实选项 + best_match 动态归类
        if options_selector:
            loc, options = self._enum_texts(scope, options_selector)
            if len([o for o in options if o]) < 2 and options_fallback:
                loc, options = self._enum_texts(scope, options_fallback)
            real = [o for o in options if o]
            if real:
                # A1：字符匹配（去标点 精确/前缀/包含/相似度）
                best_opt, best_idx, best_score = None, -1, 0.0
                for cand in candidates:
                    o, i, s = best_match(cand, options, threshold=0.0)
                    if s > best_score:
                        best_opt, best_idx, best_score = o, i, s
                matched_by = "字符"
                # A2：用本地高置信语义别名复核。长篇研判可能顺带提到父类目，
                # 本地规则分数更高时应优先选择具体叶子类目。
                local_opt, local_idx, local_score = semantic_alias_match(raw_text, options)
                if local_idx >= 0 and local_score > best_score:
                    best_opt = local_opt
                    best_idx = local_idx
                    best_score = local_score
                    matched_by = "本地语义"
                # A3：本地规则仍不达阈值时，用 milu 大模型做语义归类兜底
                #（处理“造谣/谣言/消息不属实”这类字面不重叠、但语义=“不实信息”的漂移）
                if best_idx < 0 or best_score < threshold:
                    try:
                        from category_llm import llm_classify
                        llm_opt = llm_classify(raw_text, real)
                    except Exception as e:
                        llm_opt = None
                        log_message(f"{label}语义归类调用失败：{e}", True)
                    if llm_opt:
                        try:
                            best_idx = options.index(llm_opt)
                            best_opt, best_score, matched_by = llm_opt, 1.0, "milu语义"
                        except ValueError:
                            pass
                if best_idx >= 0 and best_score >= threshold:
                    node = loc.nth(best_idx)
                    if click_relative:
                        node = node.locator(click_relative)
                    try:
                        click_non_terminal_option(node)
                        if matched_by == "milu语义":
                            log_message(f"{label}语义归类(milu)：库文本='{raw_text}' -> 平台真实='{best_opt}'")
                        elif matched_by == "本地语义":
                            log_message(f"{label}语义归类(本地)：库文本='{raw_text}' -> 平台真实='{best_opt}'")
                        else:
                            kind = "精确" if best_score >= 0.999 else "归类"
                            log_message(f"{label}{kind}：库文本='{raw_text}' -> 平台真实='{best_opt}' (分{best_score:.2f})")
                        return True
                    except Exception as e:
                        log_message(f"{label}命中'{best_opt}'但点击失败：{e}", True)
                else:
                    log_message(f"{label}枚举+语义均未命中，转文本直连。平台真实选项={real}")

        # 路径B：文本直连兜底
        if click_xpath_tpl:
            for cand in candidates:
                xpath = click_xpath_tpl.format(text=cand)
                try:
                    if scope.locator(xpath).count() > 0:
                        node = scope.locator(xpath).first
                        if click_relative:
                            node = node.locator(click_relative)
                        click_non_terminal_option(node)
                        log_message(f"{label}文本直连：库文本='{raw_text}' -> '{cand}'")
                        return True
                except Exception:
                    continue

        log_message(f"{label}选择失败：库文本='{raw_text}'（候选={candidates}）", True)
        return False

    def _upload_image(self, page, complaint_data, xpath):
        # Direct reporting does not accept arbitrary remote attachments.
        return not complaint_data.get("file")

    def capture_email_complaint_screenshot(
            self, platform, complaint_data, preview_html):
        """把已发送邮件的内容渲染为凭证页，并上传为投诉截图。"""
        page = self.pages.get(platform)
        if page is None:
            log_message(f"{platform} 邮件内容截图失败：浏览器页面未初始化", True)
            return False
        try:
            page.set_content(
                str(preview_html or ''),
                wait_until="load",
                timeout=15000,
            )
            return self._save_screenshot(
                page,
                complaint_data,
                full_page=True,
                image_kind='email',
            )
        except Exception as e:
            log_message(f"{platform} 邮件内容截图失败: {e}", True)
            return False

    def _save_screenshot(self, page, complaint_data, full_page=False, image_kind="complaint"):
        from uuid import uuid4
        directory = os.path.join(get_base_path(), "screenshots")
        os.makedirs(directory, mode=0o700, exist_ok=True)
        try:
            page.screenshot(path=os.path.join(directory, uuid4().hex + ".png"), full_page=full_page)
            return True
        except Exception:
            return False

    def _check_submit_success(self, page, xpath, timeout=3000):
        """检查提交是否成功"""
        try:
            # 检查是否有成功提示元素
            page.wait_for_selector(xpath, timeout=timeout)
            self.submission_confirmed = True
            return True
        except Exception:
            return False
        
    def _check_page_invalid(self, page, role, text):
        """检查页面是否存在"""
        try:
            # 检查是否有成功提示元素
            res = page.get_by_role(role, name=text)
            if(res.count() > 0):
                return True
            else:
                return False
        except Exception:
            return False
            
    def _get_url_with_early_detection(self, driver, url, check_xpath, check_interval=0.5, timeout=30):
        """
        在页面加载过程中实时检查特定元素，如果发现目标元素则提前终止加载
        
        Args:
            driver: WebDriver 实例
            url: 要访问的URL
            check_xpath: 要检查的XPath表达式
            check_interval: 检查间隔（秒）
            timeout: 超时时间（秒）
        
        使用方法（在需要的地方取消注释）：
        # page_invalid = self._get_url_with_early_detection(
        #     driver, 
        #     url, 
        #     "//p[contains(text(),'视频不存在')]",
        #     check_interval=0.3,
        #     timeout=20
        # )
        # if page_invalid:
        #     self.errMessage = "未找到页面……链接已失效？"
        #     log_message(self.errMessage)
        #     return True
        """
        # 设置页面加载策略为none，手动控制加载
        original_load_strategy = driver.capabilities.get('pageLoadStrategy', 'normal')
        driver.execute_script("window.stop();")  # 先停止当前可能正在进行的加载
        
        try:
            # 设置页面加载策略为none，这样get()不会等待页面完全加载
            driver.execute_cdp_cmd('Page.setLifecycleEventsEnabled', {'enabled': True})
            driver.execute_cdp_cmd('Network.setCacheDisabled', {'cacheDisabled': True})
            
            # 注入JavaScript来监控DOM变化
            script = f"""
            // 创建观察器来监控DOM变化
            const observer = new MutationObserver(function(mutations) {{
                mutations.forEach(function(mutation) {{
                    // 检查是否有目标元素出现
                    const targetElement = document.evaluate(`{check_xpath}`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (targetElement) {{
                        // 找到目标元素，停止页面加载
                        window.stop();
                        // 设置标志
                        window.__early_termination_detected = true;
                        observer.disconnect();
                    }}
                }});
            }});
            
            // 开始观察整个文档的变化
            observer.observe(document, {{
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            }});
            
            // 初始检查
            const initialCheck = document.evaluate(`{check_xpath}`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (initialCheck) {{
                window.stop();
                window.__early_termination_detected = true;
                observer.disconnect();
            }}
            """
            
            # 执行脚本
            driver.execute_script(script)
            
            # 开始导航
            driver.get(url)
            
            # 等待页面加载或检测到目标元素
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    # 检查是否检测到目标元素
                    detected = driver.execute_script("return window.__early_termination_detected || false;")
                    if detected:
                        log_message("检测到目标元素，提前终止页面加载")
                        return True
                    
                    # 检查页面加载状态
                    ready_state = driver.execute_script("return document.readyState;")
                    if ready_state == 'complete':
                        log_message("页面加载完成")
                        break
                        
                    time.sleep(check_interval)
                except:
                    time.sleep(check_interval)
            
            # 最终检查目标元素
            return self._check_page_invalid(driver, check_xpath)
            
        finally:
            # 恢复原始页面加载策略
            try:
                driver.execute_script("""
                    if (window.__early_termination_observer) {
                        window.__early_termination_observer.disconnect();
                    }
                    window.__early_termination_detected = false;
                """)
            except:
                pass
    #endregion

# Created explicitly by runner.py; importing this module starts no browser.
