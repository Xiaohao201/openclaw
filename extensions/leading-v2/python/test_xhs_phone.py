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


class PhoneTests(unittest.TestCase):
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
        phone.shell = Mock(return_value='<hierarchy><node package="com.xingin.xhs" text="举报" bounds="[0,0][10,20]"/></hierarchy>')
        with patch('xhs_phone.time.sleep'):
            phone.tap('举报')
        self.assertIn(('input', 'tap', 5, 10), [call.args for call in phone.shell.call_args_list])
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
        clipboard = ['']
        def shell(*args):
            if args[:3] == ('cmd', 'clipboard', 'set'): clipboard[0] = args[3]
            return clipboard[0]
        phone.shell = Mock(side_effect=shell)
        phone.tap = Mock(side_effect=lambda label: clipboard.__setitem__(0, URL))
        phone.texts = Mock(return_value=['更多'])
        self.assertEqual(phone.copied_link(), URL)
        self.assertEqual(phone.tap.call_args.args, ('更多',))
        phone.shell = Mock(return_value='No shell command implementation.')
        with self.assertRaises(PhoneFailure): phone.copied_link()

    def test_chinese_reason_requires_verified_text(self):
        phone = AdbPhone(dict(serial='test'))
        phone.nodes = Mock(return_value=[dict(**{'class': 'android.widget.EditText'}, text='测试')])
        phone.click_node = Mock()
        phone.shell = Mock(return_value='com.android.adbkeyboard/.AdbIME')
        phone.fill_reason('测试')
        with self.assertRaises(PhoneFailure): phone.fill_reason('different')
        phone.shell.return_value = 'other.keyboard'
        with self.assertRaises(PhoneFailure): phone.fill_reason('测试')
        phone.nodes.return_value = []
        with self.assertRaises(PhoneFailure): phone.fill_reason('测试')

    def test_short_links_only_expand_to_public_xhs(self):
        self.assertEqual(expand_share_link(URL), URL)
        with self.assertRaises(PhoneFailure): expand_share_link('https://evil.test/short')
        with patch('network_guard.public_url', return_value=True), patch('xhs_phone.build_opener') as opener:
            opener.return_value.open.return_value.__enter__.return_value.url = URL
            self.assertEqual(expand_share_link('https://xhslink.com/a/test'), URL)
            redirect = opener.call_args.args[0]
            with self.assertRaises(PhoneFailure):
                redirect.redirect_request(None, None, 302, '', {}, 'https://evil.test/')
            opener.return_value.open.return_value.__enter__.return_value.url = 'https://xiaohongshu.com/'
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
