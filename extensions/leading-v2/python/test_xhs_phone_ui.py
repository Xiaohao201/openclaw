"""Regressions for the Android 9 / XHS 9.49 UI shape observed on the test phone."""
import unittest
from unittest.mock import Mock, patch
from xml.sax.saxutils import quoteattr

from xhs_phone import AdbPhone, PhoneFailure, submit_phone
from xhs_phone_ui import parse_nodes, select_node

PACKAGE = 'com.xingin.xhs'
NOTE = '0123456789abcdef01234567'
URL = 'https://www.xiaohongshu.com/explore/' + NOTE


def node(text='', description='', box='[96,450][984,666]', children='', **attrs):
    values = dict(package=PACKAGE, text=text, **{'content-desc': description},
                  bounds=box, enabled='true', **attrs)
    return '<node ' + ' '.join(f'{key}={quoteattr(value)}' for key, value in values.items()) + '>' + children + '</node>'


def button(label, box):
    return node(description=label, box=box, clickable='true',
                children=node(text=label, box=box, clickable='false'))


def tree(contents):
    return '<hierarchy>' + node(box='[0,0][1080,2190]', children=contents) + '</hierarchy>'


class UiMatchingTests(unittest.TestCase):
    def test_parent_and_child_are_one_button(self):
        nodes = parse_nodes(tree(button('举报', '[663,1980][849,2190]')), PACKAGE)
        self.assertEqual(select_node(nodes, '举报')['clickable'], 'true')

    def test_distinct_siblings_are_ambiguous_even_with_same_bounds(self):
        nodes = parse_nodes(tree(button('提交', '[0,0][100,100]') * 2), PACKAGE)
        with self.assertRaises(PhoneFailure):
            select_node(nodes, '提交')

    def test_disabled_parent_cannot_be_bypassed_via_enabled_child(self):
        xml = tree(node(description='提交', children=node(text='提交')))
        xml = xml.replace('enabled="true"', 'enabled="false"', 1)
        with self.assertRaises(PhoneFailure):
            select_node(parse_nodes(xml, PACKAGE), '提交')

    def test_offscreen_or_clipped_buttons_are_not_clicked(self):
        for box in ('[0,0][0,0]', '[600,2108][894,2088]', '[540,2078][954,2088]'):
            self.assertIsNone(select_node(parse_nodes(tree(button('不实信息、谣言', box)), PACKAGE), '不实信息、谣言'))

    def test_resource_id_locates_unlabelled_more_button(self):
        nodes = parse_nodes(tree(node(box='[954,135][1032,213]', **{'resource-id': PACKAGE + ':id/moreOperateIV'})), PACKAGE)
        self.assertIsNotNone(select_node(nodes, '更多', PACKAGE + ':id/moreOperateIV'))

    def test_preflight_blocks_submit_at_both_action_layers(self):
        phone = AdbPhone(dict(serial='test'), allow_submit=False)
        phone.shell = Mock()
        with self.assertRaises(PhoneFailure):
            phone.tap('提交')
        with self.assertRaises(PhoneFailure):
            phone.click_node(dict(text='提交', bounds='[0,0][100,100]'))
        phone.shell.assert_not_called()

    def test_action_button_is_not_a_category(self):
        phone = AdbPhone(dict(serial='test'))
        phone.tap = Mock()
        for category, subcategory in [('提交', None), ('不实信息', '提交')]:
            with self.assertRaises(PhoneFailure):
                phone.select_category(category, subcategory)
        phone.tap.assert_not_called()

    def test_keyboard_back_is_guarded_by_service_visibility(self):
        for visible in (True, False):
            phone = AdbPhone(dict(serial='test'))
            phone.foreground = Mock()
            phone._bridge = Mock()
            phone.nodes = Mock(return_value=[dict(text='测试', **{'class': 'android.widget.EditText'}),
                                            dict(text='提交', bounds='[0,0][100,100]')])
            phone.shell = Mock(return_value='mInputShown=' + str(visible).lower())
            phone.fill_reason('测试')
            self.assertEqual(unittest.mock.call('input', 'keyevent', '4') in phone.shell.call_args_list,
                             visible)


class ReplayPhone(AdbPhone):
    """Replay transport only; use real parser, navigation, matching and flow methods."""
    def __init__(self, *, copied_url=URL, confirm=True):
        super().__init__(dict(serial='fixture'))
        self.stage = 'note'
        self.clipboard = 'previous user clipboard'
        self.reason = ''
        self.submits = 0
        self.copied_url = copied_url
        self.confirm = confirm
        self._bridge = Mock()
        self._bridge.hierarchy.side_effect = self.hierarchy
        self._bridge.clipboard.side_effect = lambda: self.clipboard
        self._bridge.set_clipboard.side_effect = lambda text: setattr(self, 'clipboard', text)
        self._bridge.set_text.side_effect = lambda text: setattr(self, 'reason', text)

    def hierarchy(self):
        more = node(box='[954,135][1032,213]', **{'resource-id': PACKAGE + ':id/moreOperateIV'})
        if self.stage == 'note':
            return tree(more)
        if self.stage.startswith('share'):
            label = '复制链接' if self.stage == 'share' else '举报'
            return tree(node(text='分享至') + button(label, '[663,1980][849,2190]'))
        if self.stage == 'groups':
            return tree(button('对他人造成困扰或危害', '[96,450][984,666]'))
        if self.stage.startswith('categories'):
            box = '[540,2078][954,2088]' if self.stage == 'categories' else '[540,1638][954,1758]'
            return tree(node(text='选择举报原因') + button('不实信息、谣言', box))
        if self.stage == 'selected':
            return tree(button('补充更多举报信息', '[48,1980][1032,2040]'))
        if self.stage == 'form':
            return tree(node(text='举报描述') + node(text=self.reason, **{'class': 'android.widget.EditText'})
                        + button('提交', '[168,2112][912,2190]'))
        return tree(node(text='举报成功' if self.confirm else '正在提交'))

    def shell(self, *args):
        if args[:3] == ('dumpsys', 'window', 'windows'):
            return 'mCurrentFocus=Window{ test com.xingin.xhs/.DetailActivity}'
        if args[:2] == ('input', 'swipe'):
            self.stage = {'share': 'share-scrolled', 'categories': 'categories-scrolled'}[self.stage]
        elif args[:2] == ('input', 'tap'):
            if self.stage == 'share':
                self.clipboard = self.copied_url
            if self.stage == 'form':
                self.submits += 1
            self.stage = {'note': 'share', 'share': 'note', 'share-scrolled': 'groups',
                          'groups': 'categories', 'categories-scrolled': 'selected',
                          'selected': 'form', 'form': 'done'}[self.stage]
        return ''


class FlowReplayTests(unittest.TestCase):
    @patch('xhs_phone.time.sleep')
    def test_report_transition_waits_for_categories_before_acting(self, sleep):
        phone = ReplayPhone()
        hierarchy = phone.hierarchy
        pending = [2]

        def delayed():
            if phone.stage == 'groups' and pending[0]:
                pending[0] -= 1
                return tree(node(text='正在加载'))
            return hierarchy()

        phone._bridge.hierarchy.side_effect = delayed
        result = submit_phone(phone, URL, '不实信息', None, '测试', stop_before_submit=True)
        self.assertEqual(result['errorCode'], 'PHONE_PREFLIGHT_READY')
        self.assertEqual(phone.submits, 0)

    @patch('xhs_phone.time.sleep')
    def test_android9_flow_stops_before_submit_and_preserves_clipboard(self, sleep):
        phone = ReplayPhone()
        result = submit_phone(phone, URL, '不实信息', None, '中文预检说明，不提交。', stop_before_submit=True)
        self.assertEqual(result['errorCode'], 'PHONE_PREFLIGHT_READY')
        self.assertEqual(result['state'], 'not_submitted')
        self.assertEqual(phone.submits, 0)
        self.assertEqual(phone.reason, '中文预检说明，不提交。')
        self.assertEqual(phone.clipboard, 'previous user clipboard')
        self.assertIn('scroll:horizontal', phone.events)
        self.assertIn('scroll:vertical', phone.events)
        self.assertIn('tap:补充更多举报信息', phone.events)

    @patch('xhs_phone.time.sleep')
    def test_wrong_shared_note_stops_before_report(self, sleep):
        phone = ReplayPhone(copied_url=URL.replace(NOTE, 'a' * 24))
        result = submit_phone(phone, URL, '不实信息', None, '测试', stop_before_submit=True)
        self.assertEqual(result['state'], 'manual_required')
        self.assertNotIn('tap:举报', phone.events)
        self.assertEqual(phone.submits, 0)

    @patch('xhs_phone.time.sleep')
    def test_normal_execution_still_requires_fresh_receipt(self, sleep):
        for confirm, state in [(True, 'done'), (False, 'unknown')]:
            phone = ReplayPhone(confirm=confirm)
            result = submit_phone(phone, URL, '不实信息、谣言', None, 'fixture reason')
            self.assertEqual(result['state'], state)
            self.assertEqual(phone.submits, 1)


if __name__ == '__main__':
    unittest.main()
