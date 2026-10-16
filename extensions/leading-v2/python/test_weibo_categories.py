"""Weibo classification uses the complaint's stated intent and visible choices."""

import unittest
from unittest.mock import Mock

from platform_flow_fakes import Element, Page
from weibo_categories import extract_intent, match_category, select_reason


JUDGMENT = (
    "已核对原文。事实背景：评论引用了造谣、谣言等争论。" * 12
    + "研判意见（黄色预警）：该内容挑动性别对立，攻击特定性别群体，"
    "涉嫌煽动不友善、挑动群体对立信息。举报诉求：请平台核查相关内容。"
)


class WeiboCategoriesTest(unittest.TestCase):
    def test_conclusion_takes_priority_over_background_rumor_keywords(self):
        self.assertEqual(match_category(JUDGMENT, ["不实信息", "不友善言论"]), 1)
        self.assertNotIn("事实背景", extract_intent(JUDGMENT))
        self.assertNotIn("举报诉求", extract_intent(JUDGMENT))

    def test_explicit_reason_takes_priority_over_general_analysis(self):
        text = "研判意见：传播谣言。举报事由：挑动群体对立。举报诉求：核查。"
        self.assertEqual(match_category(text, ["不实信息", "人身攻击"]), 1)

    def test_explicit_categories_and_existing_aliases_still_match(self):
        for target, options, expected in (
                ("不实信息", ["人身攻击", "不实信息"], 1),
                ("9. 人身攻击", ["人身攻击", "不实信息"], 0),
                ("捏造事实传播谣言", ["人身攻击", "不实信息"], 1),
                ("侵犯个人隐私", ["侵犯隐私", "不实信息"], 0),
                ("挑动群体对立", ["广告营销", "垃圾信息"], None),
                ("", ["人身攻击"], None)):
            with self.subTest(target=target):
                self.assertEqual(match_category(target, options), expected)

    def test_hidden_disabled_and_terminal_links_are_not_choices(self):
        page = Page()
        page.nodes["//a"] = [
            Element(text="不友善言论", visible=False),
            Element(text="不友善言论", enabled=False),
            Element(text="提交不友善举报"),
            Element(text="继续投诉"),
            Element(text="人身攻击"),
        ]
        result = select_reason(page, JUDGMENT)
        self.assertEqual(result.selected, "人身攻击")
        self.assertEqual(result.options, ("人身攻击",))
        self.assertEqual(len(page.state.events), 1)

    def test_missing_or_unrelated_options_never_click(self):
        for label in (None, "广告营销", "提交举报"):
            with self.subTest(label=label):
                page = Page()
                if label:
                    page.add("//a", label)
                self.assertIsNone(select_reason(page, JUDGMENT).selected)
                self.assertEqual(page.state.events, [])

    def test_subcategory_only_uses_new_choices(self):
        page = Page()
        page.nodes["//a"] = [Element(text="不友善言论"), Element(text="人身攻击")]
        result = select_reason(page, JUDGMENT, previous_options=("不友善言论",))
        self.assertEqual(result.selected, "人身攻击")
        self.assertEqual(result.options, ("人身攻击",))

    def test_empty_heading_does_not_erase_the_original_reason(self):
        self.assertEqual(extract_intent("举报原因："), "举报原因：")
        self.assertEqual(extract_intent(None), "")

    def test_waits_for_options_that_arrive_after_the_form_heading(self):
        page = Page()
        page.wait_for_selector = Mock(side_effect=lambda *args, **kwargs: page.add("//a", "人身攻击"))
        self.assertEqual(select_reason(page, JUDGMENT).selected, "人身攻击")


if __name__ == "__main__":
    unittest.main()
