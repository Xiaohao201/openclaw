"""Shared allegation extraction must precede platform description limits."""
import unittest

from complaint_payload import prepare_complaint_data


JUDGMENT = ("事实背景：引用了侮辱谩骂和造谣的争论。" * 20
            + "研判意见（黄色预警）：该内容挑动群体对立。举报诉求：请平台核查。")


class ComplaintPayloadTest(unittest.TestCase):
    def test_unclassified_judgment_preserves_intent_before_truncation(self):
        original = dict(reason=JUDGMENT)
        prepared = prepare_complaint_data(original)
        self.assertEqual(prepared['category'], '该内容挑动群体对立。')
        self.assertEqual(prepared['reason'], '该内容挑动群体对立。')
        self.assertEqual(original, dict(reason=JUDGMENT))

    def test_explicit_category_is_preserved_and_full_category_is_not_truncated(self):
        prepared = prepare_complaint_data(dict(category='明确分类', reason=JUDGMENT))
        self.assertEqual(prepared['category'], '明确分类')
        intent = '说明' * 150 + '该内容挑动群体对立。'
        prepared = prepare_complaint_data(dict(reason='举报事由：' + intent))
        self.assertEqual(prepared['category'], intent)
        self.assertLessEqual(len(prepared['reason']), 190)

    def test_short_and_unstructured_reasons_remain_compatible(self):
        self.assertEqual(prepare_complaint_data(dict(reason='已核验事实')),
                         dict(reason='已核验事实', category='已核验事实'))
        self.assertEqual(prepare_complaint_data({}), {})
        self.assertEqual(len(prepare_complaint_data(dict(reason='测' * 500))['reason']), 190)
