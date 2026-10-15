"""Offline integration of real platform handlers, matcher, and runner outcomes.

Only browser I/O, login preflight, clock, and screenshot storage are replaced.
This deliberately does not claim current live DOM/login/captcha compatibility.
"""

import tempfile
import unittest
from itertools import count
from types import SimpleNamespace
from unittest.mock import Mock, patch

import browser_manager
import config
import eastmoney_platform as eastmoney
import futu_platform as futu
import netease_platform as netease
import tencent_platform as tencent
from browser_manager import BrowserManager
from platform_flow_cases import CASES, build_case
from platform_flow_fakes import role_key, text_key
from runner import execute


class PlatformFlowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        # A missing fixture must never fall through to a browser/network service.
        for target in ("socket.create_connection", "socket.socket.connect",
                       "browser_manager.sync_playwright"):
            blocker = patch(target, side_effect=AssertionError("Offline tests prohibit network/browser startup"))
            blocker.start()
            self.addCleanup(blocker.stop)
        self.logs = []
        for target, value in (
                ("browser_manager.log_message", lambda *args: self.logs.append(args[0])),
                ("browser_manager.time", SimpleNamespace(sleep=lambda _: None,
                                                        time=lambda: next(self.clock))),
                ("browser_manager.DebugRun", False)):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.clock = count()

    def run_case(self, fixture, *, logged_in=True, reason=None, category=None):
        manager = BrowserManager.__new__(BrowserManager)
        manager.pages = {fixture.case.platform: fixture.page}
        manager.contexts = {}
        manager.drivers = set()
        manager.browser = manager.playwright = manager.shared_browser = None
        manager.login_status_errors = {}
        manager.submission_confirmed = False
        manager.errMessage = ""
        manager.self_healing = Mock()
        manager.self_healing.wrap_page.side_effect = lambda platform, page: page
        manager.self_healing.handle_flow_failure.return_value = None
        manager.init_browsers = Mock()
        manager.check_login_status = Mock(return_value=logged_in)
        manager._save_screenshot = Mock(return_value=True)
        self.manager = manager
        self.logs.clear()
        return execute(dict(platform=fixture.case.platform, link=fixture.case.url,
                            category=category or fixture.category,
                            reason=reason or fixture.category,
                            sessionDir=self.directory.name, headless=True,
                            role="Personal"), manager_factory=lambda: manager)

    def detail(self, fixture, result):
        return f"{fixture.case.name}: {result}; logs={self.logs}"

    def test_fixture_inventory_matches_enabled_platforms(self):
        self.assertEqual({case.platform for case in CASES},
                         set(config.PLATFORMS) - {"xiaohongshu", "report12377"})

    def test_all_branches_confirm_only_after_simulated_receipt(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture)
                self.assertEqual(result["state"], "done", self.detail(fixture, result))
                self.assertEqual(fixture.page.state.submissions, 1)
                self.assertTrue(self.manager.submission_confirmed)
                self.assertIn(("click", fixture.final), fixture.page.state.events)
                if fixture.description:
                    self.assertEqual(fixture.form.fields[fixture.description], fixture.category)
                if fixture.page.popup:
                    self.assertTrue(fixture.form.closed)
                    self.assertFalse(fixture.page.closed)

    def test_missing_receipt_never_becomes_done(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case, receipt=False)
                result = self.run_case(fixture)
                self.assertEqual(fixture.page.state.submissions, 1, self.detail(fixture, result))
                self.assertEqual(result["state"], "unknown", self.detail(fixture, result))
                self.assertFalse(self.manager.submission_confirmed)

    def test_debug_mode_fills_forms_without_final_click(self):
        with patch.object(browser_manager, "DebugRun", True):
            for case in CASES:
                with self.subTest(case=case.name):
                    fixture = build_case(case)
                    result = self.run_case(fixture)
                    self.assertEqual(fixture.page.state.stage, 2, self.detail(fixture, result))
                    self.assertEqual(fixture.page.state.submissions, 0)
                    self.assertNotEqual(result["state"], "done")

    def test_missing_reason_never_submits(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                fixture.form.nodes.pop(fixture.options)
                result = self.run_case(fixture)
                self.assertEqual(fixture.page.state.submissions, 0, self.detail(fixture, result))
                self.assertNotEqual(result["state"], "done")

    def test_login_preflight_stops_every_platform_before_navigation(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture, logged_in=False)
                self.assertEqual(result["state"], "manual_required")
                self.assertEqual(fixture.page.state.events, [])

    def test_platform_login_guards_stop_submission(self):
        for platform in ("tencent", "futu", "sina", "yidianzixun", "eastmoney", "tiantianfund"):
            with self.subTest(platform=platform):
                case = next(case for case in CASES if case.platform == platform)
                fixture = build_case(case)
                if platform == "tencent":
                    fixture.page.nodes.pop(tencent.LOGGED_IN_SELECTOR)
                    fixture.page.add(tencent.LOGIN_BUTTON_SELECTOR)
                elif platform == "futu":
                    fixture.page.request.get = lambda *args, **kwargs: SimpleNamespace(
                        status=200, ok=True, json=lambda: {"code": 10888})
                elif platform in ("sina", "yidianzixun"):
                    key = next(key for key in fixture.page.scripts
                               if "isLogin()" in key or key.endswith("docinfo.is_login"))
                    fixture.page.scripts[key] = False
                else:
                    fixture.form.url = "https://passport2.eastmoney.com/pub/login"
                result = self.run_case(fixture)
                self.assertEqual(fixture.page.state.submissions, 0, self.detail(fixture, result))
                self.assertEqual(result["state"], "manual_required", self.detail(fixture, result))

    def test_wrong_content_and_report_targets_never_submit(self):
        for platform in ("douyin", "futu", "tiantianfund", "sohu", "yidianzixun"):
            with self.subTest(platform=platform):
                case = next(case for case in CASES if case.platform == platform)
                fixture = build_case(case)
                if platform == "douyin":
                    fixture.page.redirects[case.url] = "https://www.douyin.com/jingxuan?modal_id=9999999999999999999"
                elif platform == "futu":
                    fixture.page.scripts[futu.REPORT_PAGE_STATE_SCRIPT]["feedId"] = "999999"
                elif platform == "yidianzixun":
                    state = next(value for value in fixture.page.scripts.values() if isinstance(value, dict))
                    state["docid"] = "WRONG"
                else:
                    fixture.page.nodes[fixture.entry][0].attrs["href"] = "https://example.invalid/wrong"
                result = self.run_case(fixture)
                self.assertEqual(fixture.page.state.submissions, 0)
                self.assertNotEqual(result["state"], "done")

    def test_material_requirements_stop_before_submit(self):
        for platform in ("weibo", "netease", "sohu"):
            with self.subTest(platform=platform):
                fixture = build_case(next(case for case in CASES if case.platform == platform))
                category = fixture.category
                if platform == "weibo":
                    fixture.form.add("//h4[@style='display: none']", stage=2)
                elif platform == "netease":
                    fixture.form.nodes[netease.SELECTED_REASON_SELECTOR][0].text = netease.INFRINGEMENT_CATEGORY
                else:
                    category = "涉嫌侵权"
                result = self.run_case(fixture, category=category)
                self.assertEqual(fixture.page.state.submissions, 0, self.detail(fixture, result))
                self.assertEqual(result["state"], "manual_required", self.detail(fixture, result))

    def test_sohu_captcha_after_click_is_manual_not_success(self):
        fixture = build_case(next(case for case in CASES if case.platform == "sohu"))
        fixture.form.nodes["body"][0].text = "请输入图中字符"
        result = self.run_case(fixture)
        self.assertEqual(fixture.page.state.submissions, 1)
        self.assertEqual(result["state"], "manual_required", self.detail(fixture, result))
        self.assertFalse(self.manager.submission_confirmed)

    def test_real_login_probe_for_every_direct_platform(self):
        buttons = dict(toutiao="登录", baidu="登录", weibo="登录/注册",
                       zhihu="登录/注册", kuaishou="立即登录", bilibili="登录")
        for platform in sorted({case.platform for case in CASES}):
            for authenticated in (True, False):
                with self.subTest(platform=platform, authenticated=authenticated):
                    fixture = build_case(next(case for case in CASES if case.platform == platform))
                    page = fixture.page
                    if platform in buttons:
                        if not authenticated:
                            page.add(role_key("button", buttons[platform]))
                    elif platform == "douyin":
                        page.add('a[href*="/user/self"] img')
                        if not authenticated:
                            page.add(text_key("登录"))
                    elif platform == "netease":
                        page.add("#js_N_navLoginAfter", visible=authenticated)
                    elif platform in ("eastmoney", "tiantianfund"):
                        if not authenticated:
                            page.redirects[eastmoney.REPORT_CENTER_URL] = "https://passport2.eastmoney.com/pub/login"
                    elif platform == "tencent":
                        if not authenticated:
                            page.add(tencent.LOGIN_BUTTON_SELECTOR)
                    elif platform == "futu":
                        page.request.get = lambda *args, **kwargs: SimpleNamespace(
                            status=200, ok=True, json=lambda: {"code": 0 if authenticated else 10888})
                    elif platform == "sina":
                        key = next(key for key in page.scripts if "isLogin()" in key)
                        page.scripts[key] = authenticated
                    elif platform == "yidianzixun":
                        page.scripts["() => window.yidian.docinfo.is_login"] = authenticated
                    manager = BrowserManager.__new__(BrowserManager)
                    manager.pages = {platform: page}
                    manager.contexts = {platform: page.context}
                    manager.shared_browser = object()  # Avoid storage writes, as in a shared session.
                    manager.login_status_errors = {}
                    result = manager.check_login_status(platform)
                    # Sohu ordinary reports explicitly support anonymous users.
                    self.assertEqual(result, authenticated or platform == "sohu", self.logs)
                    self.assertEqual(manager.login_status_errors[platform], "")

    def test_sessions_expiring_during_form_fill_never_submit(self):
        for platform in ("sina", "yidianzixun", "futu"):
            with self.subTest(platform=platform):
                fixture = build_case(next(case for case in CASES if case.platform == platform))
                if platform == "sina":
                    values = iter([True, False])
                    key = next(key for key in fixture.page.scripts if "isLogin()" in key)
                    fixture.page.scripts[key] = lambda: next(values)
                elif platform == "yidianzixun":
                    key = next(key for key in fixture.page.scripts if key.endswith("docinfo.is_login"))
                    fixture.page.scripts[key] = False
                else:
                    codes = iter([0, 10888])
                    fixture.page.request.get = lambda *args, **kwargs: SimpleNamespace(
                        status=200, ok=True, json=lambda: {"code": next(codes)})
                result = self.run_case(fixture)
                self.assertEqual(fixture.page.state.stage, 2, self.detail(fixture, result))
                self.assertEqual(fixture.page.state.submissions, 0)
                self.assertEqual(result["state"], "manual_required")

    def test_description_limits_reach_the_actual_field(self):
        for platform, variant, limit in (("netease", "popup", 100),
                                         ("sina", "community", 140),
                                         ("douyin", "video", 190)):
            with self.subTest(platform=platform):
                fixture = build_case(next(case for case in CASES
                                          if case.platform == platform and case.variant == variant))
                result = self.run_case(fixture, reason="测" * 500)
                self.assertEqual(result["state"], "done", self.detail(fixture, result))
                self.assertEqual(fixture.form.fields[fixture.description], "测" * limit)


if __name__ == "__main__":
    unittest.main()
