import unittest
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
from xhs_phone import (note_id, mobile_only_target, submit_phone, PhoneFailure,
                       AdbPhone, execute_phone, expand_share_link)

NOTE = '0123456789abcdef01234567'
URL = 'https://www.xiaohongshu.com/explore/' + NOTE


class FakePhone:
    def __init__(self, identity=NOTE, success=True, fail_submit=False):
        self.identity = identity
        self.success = success
        self.fail_submit = fail_submit
        self.stage = 'note'
        self.taps = []
        self.reason = None

    def open(self, note): self.opened = note
    def texts(self):
        return {'note': ['更多'], 'share': ['复制链接', '举报'],
                'report': ['举报', '不实信息'], 'reason': ['举报', '提交'],
                'done': ['举报成功'] if self.success else ['正在提交']}[self.stage]
    def tap(self, label):
        self.taps.append(label)
        if label == '提交' and self.fail_submit: raise RuntimeError('lost connection')
        self.stage = {'更多': 'share', '举报': 'report', '不实信息': 'reason',
                      '提交': 'done'}.get(label, self.stage)
    def copied_link(self): return 'https://www.xiaohongshu.com/explore/' + self.identity
    def fill_reason(self, reason): self.reason = reason
    def open_report(self): self.tap('举报')
    def select_category(self, category, subcategory):
        self.tap(category)
        if subcategory: self.tap(subcategory)
    def check_submit_ready(self): pass
    def close(self): pass


class PhoneTests(unittest.TestCase):
    def test_phone_entrypoint_extracts_intent_before_filling(self):
        from test_complaint_payload import JUDGMENT
        with tempfile.TemporaryDirectory() as directory:
            user_id = 'fixture-user'
            data = dict(sessionDir=str(Path(directory) / hashlib.sha256(user_id.encode()).hexdigest()),
                        category='不实信息', reason=JUDGMENT,
                        phone=dict(serial='fixture-phone', userId=user_id))
            phone = FakePhone()
            with patch('xhs_phone.tempfile.gettempdir', return_value=directory):
                result = execute_phone(data, URL, lambda config: phone)
            self.assertEqual(result['state'], 'done')
            self.assertIn('挑动群体对立', phone.reason)
            self.assertNotIn('事实背景', phone.reason)

    def test_phone_matches_a_judgment_only_to_observed_category_aliases(self):
        phone = AdbPhone(dict(serial='fixture'))
        pages = [['对他人造成困扰或危害'], ['选择举报原因', '不实信息、谣言'], ['举报', '提交']]
        index = [0]
        taps = []
        def tap(label, **kwargs):
            self.assertIn(label, pages[index[0]])
            taps.append(label)
            index[0] += 1
        def wait(predicate, message):
            rows = [dict(text=text) for text in pages[index[0]]]
            if not predicate(rows):
                raise PhoneFailure(message)
            return rows
        phone.tap = tap
        phone.wait_nodes = wait
        phone.texts = lambda: pages[index[0]]
        phone.select_category('事实背景：其他争论。举报事由：捏造事实传播谣言。', None)
        self.assertEqual(taps, ['对他人造成困扰或危害', '不实信息、谣言'])

    def test_binding_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            data = dict(sessionDir=directory, category='不实信息', reason='测试')
            self.assertEqual(execute_phone(data, URL)['errorCode'], 'PHONE_NOT_CONFIGURED')
            data['phone'] = dict(serial='test-serial', userId='test-user')
            self.assertEqual(execute_phone(data, URL)['errorCode'], 'PHONE_OWNER_MISMATCH')
            data['sessionDir'] = str(Path(directory) / hashlib.sha256(b'test-user').hexdigest())
            with patch('xhs_phone.tempfile.gettempdir', return_value=directory):
                self.assertEqual(execute_phone(data, URL, lambda config: FakePhone())['state'], 'done')
                lock = Path(directory) / ('openclaw-phone-' + hashlib.sha256(b'test-serial').hexdigest() + '.lock')
                self.assertFalse(lock.exists())
                lock.write_text('busy')
                self.assertEqual(execute_phone(data, URL)['errorCode'], 'PHONE_BUSY')

    def test_adb_navigation_and_focus(self):
        phone = AdbPhone(dict(serial='test'))
        phone.shell = Mock(return_value='mCurrentFocus=Window{ x com.xingin.xhs/.DetailActivity}')
        with patch('xhs_phone.time.sleep'):
            phone.open(NOTE)
        args = phone.shell.call_args_list[1].args
        self.assertIn('xhsdiscover://item/' + NOTE + '?type=normal', args)
        phone.shell.return_value = 'mCurrentFocus=Window{ x other.app/.Activity}'
        with self.assertRaises(PhoneFailure): phone.foreground()
        phone.shell.return_value = 'mKeyguardShowing=true'
        with self.assertRaises(PhoneFailure): phone.open(NOTE)

    def test_ui_guard_and_exact_taps(self):
        phone = AdbPhone(dict(serial='test'))
        phone.foreground = Mock()
        phone.shell = Mock(return_value='<hierarchy><node package="com.xingin.xhs" text="举报" bounds="[0,0][40,60]"/></hierarchy>')
        with patch('xhs_phone.time.sleep'):
            phone.tap('举报')
        self.assertIn(('input', 'tap', 20, 30), [call.args for call in phone.shell.call_args_list])
        with self.assertRaises(PhoneFailure): phone.tap('missing')
        phone.shell.return_value = '<hierarchy><node package="com.xingin.xhs" text="安全验证"/></hierarchy>'
        with self.assertRaises(PhoneFailure): phone.nodes()
        phone.shell.return_value = '<!DOCTYPE invalid>'
        with self.assertRaises(PhoneFailure): phone.nodes()
        for bounds in ['bad', '[0,0][0,0]']:
            with self.assertRaises(PhoneFailure): phone.click_node(dict(bounds=bounds))

    def test_shell_has_no_host_shell_and_quotes_remote_arguments(self):
        phone = AdbPhone(dict(serial='test'))
        with patch('xhs_phone.subprocess.run', return_value=Mock(stdout='ok')) as run:
            self.assertEqual(phone.shell('input', 'text', 'a; rm x'), 'ok')
            self.assertEqual(run.call_args.args[0][-1], "input text 'a; rm x'")
            self.assertNotIn('shell', run.call_args.kwargs)
        phone.deadline = 0
        with self.assertRaises(PhoneFailure): phone.run([])

    def test_clipboard_freshness_and_share_sheet(self):
        phone = AdbPhone(dict(serial='test'))
        clipboard = ['original clipboard']
        phone._bridge = Mock()
        phone._bridge.clipboard.side_effect = lambda: clipboard[0]
        phone._bridge.set_clipboard.side_effect = lambda text: clipboard.__setitem__(0, text)
        phone.tap = Mock(side_effect=lambda label: clipboard.__setitem__(0, URL))
        phone.texts = Mock(return_value=['更多'])
        self.assertEqual(phone.copied_link(), URL)
        self.assertEqual(phone.tap.call_args.args, ('更多',))
        self.assertIn(unittest.mock.call('original clipboard'), phone._bridge.set_clipboard.call_args_list)
        phone._bridge.clipboard.side_effect = None
        phone._bridge.clipboard.return_value = 'stale'
        with self.assertRaises(PhoneFailure): phone.copied_link()

    def test_chinese_reason_requires_verified_text(self):
        phone = AdbPhone(dict(serial='test'))
        phone.nodes = Mock(return_value=[dict(**{'class': 'android.widget.EditText'}, text='测试')])
        phone.foreground = Mock()
        phone.shell = Mock(return_value='mInputShown=false')
        phone._bridge = Mock()
        phone.fill_reason('测试')
        phone._bridge.set_text.assert_called_once_with('测试')
        with self.assertRaises(PhoneFailure): phone.fill_reason('different')
        with self.assertRaises(PhoneFailure): phone.fill_reason('测' * 401)
        phone.tap = Mock()
        phone.nodes.return_value = []
        with self.assertRaises(PhoneFailure): phone.fill_reason('测试')

    def test_short_links_only_expand_to_public_xhs(self):
        self.assertEqual(expand_share_link(URL), URL)
        with self.assertRaises(PhoneFailure): expand_share_link('https://evil.test/short')
        with patch('xhs_phone_network.share_redirect', return_value=URL) as redirect:
            self.assertEqual(expand_share_link('https://xhslink.com/a/test'), URL)
            self.assertEqual(expand_share_link('http://xhslink.com/a/test'), URL)
            redirect.assert_called_with('https://xhslink.com/a/test')
            self.assertEqual(expand_share_link('https://xhslink.cn/o/test'), URL)
            redirect.assert_called_with('https://xhslink.cn/o/test')
            redirect.return_value = 'https://evil.test/'
            with self.assertRaises(PhoneFailure):
                expand_share_link('https://xhslink.com/a/test')
            redirect.return_value = 'https://xiaohongshu.com/'
            with self.assertRaises(PhoneFailure): expand_share_link('https://xhslink.com/a/test')

    def test_strict_identity(self):
        self.assertEqual(note_id(URL), NOTE)
        self.assertEqual(note_id('https://www.xiaohongshu.com/discovery/item/' + NOTE), NOTE)
        for url in ['https://xiaohongshu.com.evil.test/explore/' + NOTE,
                    'https://user@xiaohongshu.com/explore/' + NOTE,
                    'https://xiaohongshu.com:444/explore/' + NOTE,
                    'https://xhslink.com/a/short']:
            self.assertIsNone(note_id(url))

    def test_success_after_exact_share_identity(self):
        phone = FakePhone()
        result = submit_phone(phone, URL, '不实信息', None, '已核验的测试举报理由')
        self.assertEqual(result['state'], 'done')
        self.assertEqual(phone.taps.count('提交'), 1)
        self.assertEqual(phone.reason, '已核验的测试举报理由')

    def test_wrong_identity_never_reports(self):
        phone = FakePhone(identity='a' * 24)
        self.assertEqual(submit_phone(phone, URL, '不实信息', None, 'reason')['state'], 'manual_required')
        self.assertNotIn('举报', phone.taps)

    def test_missing_category_never_submits(self):
        phone = FakePhone()
        self.assertEqual(submit_phone(phone, URL, '猜测分类', None, 'reason')['state'], 'manual_required')
        self.assertNotIn('提交', phone.taps)

    def test_submit_uncertainty_is_not_retried(self):
        for phone in [FakePhone(success=False), FakePhone(fail_submit=True)]:
            self.assertEqual(submit_phone(phone, URL, '不实信息', None, 'reason')['state'], 'unknown')
            self.assertEqual(phone.taps.count('提交'), 1)

    def test_no_short_link_guessing(self):
        phone = FakePhone()
        self.assertEqual(submit_phone(phone, 'https://xhslink.com/a/short', '不实信息', None, 'reason')['state'], 'manual_required')
        self.assertEqual(phone.taps, [])

    def test_gate_does_not_match_normal_app_banner(self):
        class Page:
            url = URL
            def locator(self, value): return self
            def inner_text(self, **kwargs): return self.text
        page = Page()
        for text in ['打开App', '你访问的页面不见了', '普通正文']:
            page.text = text
            self.assertIsNone(mobile_only_target(page))
        page.text = '当前内容仅支持在小红书App内查看'
        self.assertEqual(mobile_only_target(page), URL)


if __name__ == '__main__': unittest.main()
