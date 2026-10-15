"""Offline execution of the real 12377 form and receipt listener workflow."""

import unittest
from collections import namedtuple
from types import SimpleNamespace
from unittest.mock import patch

from platform_flow_fakes import Locator, Page
from report_12377 import ANONYMOUS_PATH, LABELS, NOTICES, SUBMIT_PATH, run_browser_flow


class FormLocator(Locator):
    def select_option(self, value, **kwargs):
        self.fill(value)

    def evaluate(self, script):
        if self.key == "#report_platform" and script == "el => window.jQuery(el).niceSelect('update')":
            self.page.select_updated = True
            return None
        return super().evaluate(script)


class FormPage(Page):
    def __init__(self, category, event="idle"):
        super().__init__()
        self.handlers = {}
        self.ticks = 0
        self.event = event
        self.select_updated = False
        self.receipt_payload = {"code": "1000", "result": {"retrievalCode": "OFFLINE-TEST-RECEIPT"}}
        for selector in ("#isee", "#agree:not(.grey)", "#agree", "#nmjb_tabs",
                         "#report_platform", "#website_name", "#website_address", "#report_content"):
            self.add(selector)
        self.nodes["#nmjb_tabs"][0].action = self.open_anonymous
        self.add("#big_HAEM", LABELS[category] + "举报")

    def locator(self, key):
        return FormLocator(self, key, self.nodes.get(key, []))

    def open_anonymous(self):
        self.url = "https://www.12377.cn" + ANONYMOUS_PATH
        if self.event == "realname":
            self.url = "https://www.12377.cn/jbxzxq/jbxx/smjb/smjb.html"

    def wait_for_url(self, pattern, **kwargs):
        if not self.url.endswith(pattern.removeprefix("**")):
            raise RuntimeError("Unexpected anonymous navigation")

    def on(self, name, callback):
        self.handlers[name] = callback

    def remove_listener(self, name, callback):
        if self.handlers[name] is not callback:
            raise AssertionError("Wrong listener removed")
        del self.handlers[name]

    def wait_for_timeout(self, milliseconds):
        self.ticks += 1
        if self.ticks != 1 or self.event in ("idle", "realname"):
            return
        Request = namedtuple("Request", "url method")
        domain = "https://example.invalid" if self.event == "foreign" else "https://www.12377.cn"
        request = Request(domain + SUBMIT_PATH, "POST")
        if self.event != "orphan-response":
            self.handlers["request"](request)
        if self.event == "timeout":
            return
        self.handlers["response"](SimpleNamespace(
            url=request.url, request=request, ok=True, json=lambda: self.receipt_payload))


class Report12377FlowTest(unittest.TestCase):
    def setUp(self):
        for target in ("socket.create_connection", "socket.socket.connect"):
            blocker = patch(target, side_effect=AssertionError("Offline tests prohibit network"))
            blocker.start()
            self.addCleanup(blocker.stop)

    def run_flow(self, page, category="fraud"):
        self.updates = []
        payload = dict(mode="anonymous", category=category,
                       url="https://example.invalid/authorized-fixture",
                       description="仅用于本地模拟测试", websiteName="本地测试站点")
        run_browser_flow(page, payload, lambda *args: self.updates.append(args),
                         lambda: None, timeout=3, now=lambda: page.ticks)
        self.assertEqual(page.handlers, {})
        # Navigation only: no captcha, attachment, or final submission actions.
        clicks = [key for action, key in page.state.events if action == "click"]
        self.assertEqual(clicks, ["#agree", "#nmjb_tabs"])
        return self.updates[-1][0]

    def test_all_seven_categories_fill_and_wait_for_manual_action(self):
        for category in NOTICES:
            with self.subTest(category=category):
                page = FormPage(category)
                self.assertEqual(self.run_flow(page, category), "manual_expired")
                self.assertEqual(self.updates[0][0], "awaiting_manual")
                self.assertTrue(page.nodes["#isee"][0].checked)
                self.assertTrue(page.select_updated)
                self.assertEqual(page.fields, {
                    "#report_platform": "WEBSITE", "#website_name": "本地测试站点",
                    "#website_address": "https://example.invalid/authorized-fixture",
                    "#report_content": "仅用于本地模拟测试"})

    def test_observed_official_manual_submission_receipt_is_confirmed(self):
        page = FormPage("fraud", "receipt")
        self.assertEqual(self.run_flow(page), "submitted")
        self.assertEqual(self.updates[-1][2], "OFFLINE-TEST-RECEIPT")

    def test_rejected_or_missing_receipts_remain_unknown(self):
        for payload in ({"code": "500"}, {"code": "1000", "result": {}},
                        {"code": "1000", "result": {"retrievalCode": "invalid code"}}):
            with self.subTest(payload=payload):
                page = FormPage("fraud", "receipt")
                page.receipt_payload = payload
                self.assertEqual(self.run_flow(page), "unknown")

    def test_manual_submit_timeout_is_unknown_without_retry(self):
        page = FormPage("fraud", "timeout")
        self.assertEqual(self.run_flow(page), "unknown")
        self.assertEqual([update[0] for update in self.updates],
                         ["awaiting_manual", "submitting", "unknown"])

    def test_foreign_and_unmatched_responses_cannot_confirm_submission(self):
        for event in ("foreign", "orphan-response"):
            with self.subTest(event=event):
                self.assertEqual(self.run_flow(FormPage("fraud", event)), "manual_expired")

    def test_realname_navigation_stops_before_filling(self):
        page = FormPage("fraud", "realname")
        self.assertEqual(self.run_flow(page), "failed")
        self.assertEqual(page.fields, {})

    def test_wrong_category_stops_before_filling(self):
        page = FormPage("rumor")
        self.assertEqual(self.run_flow(page), "failed")
        self.assertEqual(page.fields, {})


if __name__ == "__main__":
    unittest.main()
