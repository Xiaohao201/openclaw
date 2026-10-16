"""Local category matching excludes background and handles XPath quoting."""
import unittest

from category_matcher import (
    best_match, category_alias_candidates, format_category_xpath,
    normalize_category, semantic_alias_match, similarity, split_categories,
)
from test_complaint_payload import JUDGMENT


class CategoryMatcherTest(unittest.TestCase):
    def test_group_attack_is_matched_using_only_stated_intent(self):
        self.assertEqual(semantic_alias_match(JUDGMENT, ['不实信息', '不友善言论'])[0], '不友善言论')
        self.assertIsNone(semantic_alias_match(JUDGMENT, ['不实信息', '广告'])[0])
        self.assertIn('人身攻击', category_alias_candidates(JUDGMENT))
        self.assertNotIn('不实信息', category_alias_candidates(JUDGMENT))

    def test_aliases_only_describe_recognized_claims(self):
        self.assertIn('不实信息', category_alias_candidates('捏造事实传播谣言'))
        self.assertEqual(category_alias_candidates('没有对应分类的测试文本'), [])

    def test_xpath_literals_cannot_change_the_selector(self):
        template = "//label[normalize-space()='{text}']"
        self.assertEqual(format_category_xpath(template, '不实信息'), "//label[normalize-space()='不实信息']")
        self.assertEqual(format_category_xpath(template, "带'引号"), '//label[normalize-space()="带\'引号"]')
        self.assertIn('concat(', format_category_xpath(template, '两种\'"引号'))
        with self.assertRaises(ValueError):
            format_category_xpath('//label[text()={text}]', '分类')

    def test_legacy_category_formats_keep_their_meaning(self):
        self.assertEqual(normalize_category('9. 重复、旧闻'), '重复、旧闻')
        self.assertEqual(normalize_category('["不友善", "不实信息"]'), '不友善')
        self.assertEqual(split_categories('["不友善", "不实信息"]'), ['不友善', '不实信息'])
        for empty in (None, '', 'none'):
            self.assertEqual(normalize_category(empty), '')
            self.assertEqual(split_categories(empty), [])
            self.assertIsNone(best_match(empty, ['不实信息'])[0])
            self.assertIsNone(semantic_alias_match(empty, ['不实信息'])[0])
        for malformed in ('[broken]', '[]'):
            self.assertEqual(normalize_category(malformed), malformed)
        self.assertEqual(split_categories('[broken]'), ['[broken]'])
        self.assertEqual(similarity('重复、旧闻', '重复旧闻'), 1.0)
        self.assertIsNone(best_match('完全无关', ['广告', ''])[0])
