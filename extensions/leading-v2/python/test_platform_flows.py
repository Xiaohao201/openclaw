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
from platform_flow_fakes import Element, role_key, text_key
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

    def run_case(self, fixture, *, logged_in=True, reason=None, category=None, sub_category=None):
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
                            subCategory=sub_category,
                            reason=reason or fixture.category,
                            sessionDir=self.directory.name, headless=True,
                            role="Personal"), manager_factory=lambda: manager)

    def detail(self, fixture, result):
        return f"{fixture.case.name}: {result}; logs={self.logs}"

    def test_fixture_inventory_matches_enabled_platforms(self):
        self.assertEqual({case.platform for case in CASES},
                         set(config.PLATFORMS) - {"report12377"})

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
                self.assertIs(self.manager.submission_attempted, True)
                self.manager.self_healing.finish_flow.assert_called_once_with(False)

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
                self.assertEqual(result["state"], "failed", self.detail(fixture, result))
                self.assertIn("未点击提交", result["message"])

    def test_every_platform_keeps_the_allegation_in_long_descriptions(self):
        from test_complaint_payload import JUDGMENT
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture, reason=JUDGMENT)
                self.assertEqual(result['state'], 'done', self.detail(fixture, result))
                if fixture.description:
                    self.assertIn('挑动群体对立', fixture.form.fields[fixture.description])
                    self.assertNotIn('事实背景', fixture.form.fields[fixture.description])

    def test_platforms_without_option_enumeration_match_semantic_aliases(self):
        judgment = '事实背景：背景讨论。' * 30 + '举报事由：捏造事实传播谣言。'
        for case in CASES:
            if case.platform not in ('zhihu', 'bilibili', 'kuaishou', 'douyin', 'xiaohongshu'):
                continue
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture, reason=judgment, category=judgment)
                self.assertEqual(result['state'], 'done', self.detail(fixture, result))
                self.assertEqual(fixture.page.state.submissions, 1)

    def test_explicit_subcategory_failure_stops_zhihu_and_xhs(self):
        for case in CASES:
            if case.platform not in ('zhihu', 'xiaohongshu'):
                continue
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture, sub_category='无对应子类的测试文本')
                self.assertEqual(result['state'], 'failed', self.detail(fixture, result))
                self.assertEqual(result['errorCode'], 'FORM_VALIDATION_FAILED')
                self.assertEqual(fixture.page.state.submissions, 0)

    def test_explicit_category_is_not_overridden_by_description(self):
        for case in CASES:
            if case.platform not in ('tiantianfund', 'futu', 'sina', 'sohu', 'yidianzixun'):
                continue
            with self.subTest(case=case.name):
                fixture = build_case(case)
                selected = []
                original = fixture.form.nodes[fixture.options][0].action
                def choose_explicit():
                    selected.append(fixture.category)
                    original()
                fixture.form.nodes[fixture.options][0].action = choose_explicit
                fixture.form.nodes[fixture.options].append(Element(
                    text='不友善言论', stage=1,
                    action=lambda: selected.append('unexpected')))
                result = self.run_case(fixture, reason='挑动群体对立，包含不友善言论。' * 15)
                self.assertEqual(result['state'], 'done', self.detail(fixture, result))
                self.assertEqual(selected, [fixture.category])

    def test_xhs_visible_subcategory_must_match_before_submission(self):
        case = next(case for case in CASES if case.platform == 'xiaohongshu')
        for child, expected in (('虚假信息', 'done'), ('无匹配子类别', 'failed')):
            with self.subTest(child=child):
                fixture = build_case(case)
                chosen = []
                fixture.form.add('//div[@class="choice-item"]', child, stage=2,
                                 action=lambda: chosen.append(child))
                result = self.run_case(fixture, reason='捏造事实传播谣言')
                self.assertEqual(result['state'], expected, self.detail(fixture, result))
                self.assertEqual(fixture.page.state.submissions, 1 if expected == 'done' else 0)
                self.assertEqual(chosen, [child] if expected == 'done' else [])

    def test_lost_final_click_response_is_unknown_and_never_retried(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                def submit_then_disconnect():
                    fixture.form.submit()
                    raise RuntimeError('private browser detail')
                fixture.form.nodes[fixture.final][0].action = submit_then_disconnect
                result = self.run_case(fixture)
                self.assertEqual(result['state'], 'unknown', self.detail(fixture, result))
                self.assertIs(self.manager.submission_attempted, True)
                self.assertEqual(fixture.page.state.submissions, 1)
                self.assertNotIn('private', result['message'])

    def test_weibo_long_judgment_selects_stated_complaint_and_fills_its_intent(self):
        from test_weibo_categories import JUDGMENT
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        fixture.form.nodes[fixture.options][0].text = "不友善言论"
        result = self.run_case(fixture, reason=JUDGMENT, category=JUDGMENT)
        self.assertEqual(result["state"], "done", self.detail(fixture, result))
        self.assertEqual(fixture.page.state.submissions, 1)
        self.assertIn("挑动性别对立", fixture.form.fields[fixture.description])
        self.assertNotIn("事实背景", fixture.form.fields[fixture.description])

    def test_weibo_unmatched_category_is_failed_before_submission(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        result = self.run_case(fixture, category="无对应分类的测试内容")
        self.assertEqual(result["state"], "failed", self.detail(fixture, result))
        self.assertEqual(result["errorCode"], "FORM_VALIDATION_FAILED")
        self.assertIn("未点击提交", result["message"])
        self.assertIn("SELECT_REASON", result["message"])
        self.assertEqual(fixture.page.state.submissions, 0)

    def test_weibo_explicit_subcategory_must_match_before_submission(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        result = self.run_case(fixture, sub_category="无对应分类的测试内容")
        self.assertEqual(result["state"], "failed", self.detail(fixture, result))
        self.assertIn("子原因", result["message"])
        self.assertEqual(fixture.page.state.submissions, 0)

    def test_weibo_final_click_exception_remains_unknown(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        def lost_receipt():
            fixture.form.submit()
            raise RuntimeError("secret browser detail")
        fixture.form.nodes[fixture.final][0].action = lost_receipt
        result = self.run_case(fixture)
        self.assertEqual(result["state"], "unknown", self.detail(fixture, result))
        self.assertEqual(fixture.page.state.submissions, 1)
        self.assertNotIn("secret", result["message"])

    def test_weibo_automatically_selects_a_new_matching_subcategory(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        def expose_subcategory():
            fixture.form.nodes[fixture.options] = [
                Element(text="人身攻击", stage=1, action=fixture.form.choose),
            ]
        fixture.form.nodes[fixture.options] = [
            Element(text="不友善言论", stage=1, action=expose_subcategory),
        ]
        result = self.run_case(fixture, category="挑动群体对立")
        self.assertEqual(result["state"], "done", self.detail(fixture, result))
        self.assertEqual(fixture.page.state.submissions, 1)

    def test_weibo_unmatched_new_subcategory_stops_before_submit(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        def expose_subcategory():
            fixture.form.nodes[fixture.options] = [Element(text="无匹配子类别", stage=1)]
        fixture.form.nodes[fixture.options][0].action = expose_subcategory
        result = self.run_case(fixture)
        self.assertEqual(result["state"], "failed", self.detail(fixture, result))
        self.assertEqual(result["errorCode"], "FORM_VALIDATION_FAILED")
        self.assertEqual(fixture.page.state.submissions, 0)

    def test_weibo_navigation_failure_has_no_submission_uncertainty(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        fixture.page.goto = Mock(side_effect=RuntimeError("secret navigation detail"))
        result = self.run_case(fixture)
        self.assertEqual(result["state"], "failed", self.detail(fixture, result))
        self.assertIn("OPEN_CONTENT", result["message"])
        self.assertNotIn("secret", result["message"])
        self.assertEqual(fixture.page.state.submissions, 0)

    def test_weibo_missing_receipt_is_not_recorded_as_a_successful_flow(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"), receipt=False)
        result = self.run_case(fixture)
        self.assertEqual(result["state"], "unknown", self.detail(fixture, result))
        self.manager.self_healing.finish_flow.assert_called_once_with(False)

    def test_weibo_form_document_links_are_not_required_subcategories(self):
        fixture = build_case(next(case for case in CASES if case.platform == "weibo"))
        def show_form():
            fixture.form.choose()
            fixture.form.nodes[fixture.options].append(Element(text="举报须知", stage=2))
        fixture.form.nodes[fixture.options][0].action = show_form
        result = self.run_case(fixture)
        self.assertEqual(result["state"], "done", self.detail(fixture, result))
        self.assertEqual(fixture.page.state.submissions, 1)

    def test_login_preflight_stops_every_platform_before_report_actions(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                result = self.run_case(fixture, logged_in=False)
                self.assertEqual(result["state"], "manual_required")
                # XHS must first check whether the authorized page requires the app.
                expected = [('goto', case.url)] if case.platform == 'xiaohongshu' else []
                self.assertEqual(fixture.page.state.events, expected)

    def test_final_button_unavailable_fails_before_attempt(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                fixture.form.nodes.pop(fixture.final)
                result = self.run_case(fixture)
                self.assertEqual(result['state'], 'failed', self.detail(fixture, result))
                self.assertIs(self.manager.submission_attempted, False)
                self.assertEqual(fixture.page.state.submissions, 0)

    def test_disabled_final_button_fails_before_attempt(self):
        for case in CASES:
            with self.subTest(case=case.name):
                fixture = build_case(case)
                fixture.form.nodes[fixture.final][0].enabled = False
                result = self.run_case(fixture)
                self.assertEqual(result['state'], 'failed', self.detail(fixture, result))
                self.assertIs(self.manager.submission_attempted, False)
                self.assertEqual(fixture.page.state.submissions, 0)

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
        buttons = dict(xiaohongshu="登录", toutiao="登录", baidu="登录", weibo="登录/注册",
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
