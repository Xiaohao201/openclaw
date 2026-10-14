"""Conservative Android fallback for XHS pages explicitly gated to the app."""
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlsplit
import uuid

from xhs_phone_ui import PhoneFailure, bounds, parse_nodes, select_node

PACKAGE = 'com.xingin.xhs'
GATES = ('当前内容仅支持在小红书app内查看', '请在小红书app内打开',
         '该内容仅支持在app内查看', '请打开小红书app查看完整内容')


def result(state, message, code='NONE'):
    return dict(state=state, message=message, errorCode=code, offline=None)


def note_id(value):
    try:
        url = urlsplit(value)
        if (url.scheme not in ('http', 'https') or url.username or url.password or url.port
                or not (url.hostname == 'xiaohongshu.com' or
                        (url.hostname or '').endswith('.xiaohongshu.com'))):
            return None
        match = re.fullmatch(r'/(?:explore|discovery/item)/([a-fA-F0-9]{24})/?', url.path)
        return match[1].lower() if match else None
    except ValueError:
        return None


def mobile_only_target(page):
    # A normal "open app" banner, deleted page, timeout, or login failure is NOT a gate.
    if not note_id(page.url):
        return None
    text = page.locator('body').inner_text(timeout=5000).lower()
    return page.url if any(gate in text for gate in GATES) else None


def expand_share_link(value):
    from xhs_phone_network import share_redirect, validate_share_url

    # XHS 9.49 copies http short links; upgrade before making any network request.
    parsed = urlsplit(value)
    if (parsed.scheme == 'http' and parsed.hostname in ('xhslink.com', 'xhslink.cn')
            and not parsed.username and not parsed.password and not parsed.port):
        value = parsed._replace(scheme='https').geturl()

    if note_id(value):
        return value
    for _ in range(5):
        validate_share_url(value)
        resolved = urljoin(value, share_redirect(value))
        validate_share_url(resolved)
        if note_id(resolved):
            return resolved
        value = resolved
    raise PhoneFailure('未能从分享链接核实笔记编号。')


def submit_phone(phone, url, category, subcategory, reason, *, stop_before_submit=False):
    submitting = False
    try:
        if stop_before_submit:
            phone.allow_submit = False
        identity = note_id(url)
        if not identity:
            raise PhoneFailure('无法核实小红书笔记编号，请先展开短链接。')
        phone.open(identity)
        phone.tap('更多')
        # Read the current note's share URL, never the launch intent or old clipboard.
        if note_id(phone.copied_link()) != identity:
            raise PhoneFailure('手机分享链接与目标笔记不一致，未举报。')
        phone.open_report()
        phone.select_category(category, subcategory)
        phone.fill_reason(reason)
        visible = phone.texts()
        if '提交' not in visible or not any('举报' in text for text in visible):
            raise PhoneFailure('未确认举报提交页面，请在手机核对。')
        if any(text in ('举报成功', '提交成功') for text in visible):
            raise PhoneFailure('提交前已出现成功文字，不能确认本次操作。')
        phone.check_submit_ready()
        if stop_before_submit:
            return result('not_submitted', '已核验笔记、分类和说明，测试停在提交前，未提交举报。',
                          'PHONE_PREFLIGHT_READY')
        # Set before the side effect: lost ADB responses must never trigger a retry.
        submitting = True
        phone.tap('提交')
        for _ in range(3):
            if any(text in ('举报成功', '提交成功') for text in phone.texts()):
                return result('done', '已观察到小红书手机端举报成功提示；不代表平台处置。')
        return result('unknown', '手机端已点击提交但未观察到成功提示，请核对，勿重投。', 'PHONE_RESULT_UNKNOWN')
    except Exception as error:
        if submitting:
            return result('unknown', '手机提交结果无法确认，请核对，勿重投。', 'PHONE_RESULT_UNKNOWN')
        message = str(error) if isinstance(error, PhoneFailure) else '手机执行失败或界面不受支持，未点击提交。'
        return result('manual_required', message, 'PHONE_MANUAL_REQUIRED')


class AdbPhone:
    def __init__(self, config, *, allow_submit=True):
        self.adb = config.get('adbPath', 'adb')
        self.serial = config['serial']
        self.deadline = time.monotonic() + 110
        self.allow_submit = allow_submit
        self._bridge = None
        self.events = []

    def bridge(self):
        if self._bridge is None:
            try:
                from xhs_phone_bridge import UiAutomatorBridge
                self._bridge = UiAutomatorBridge(self.serial, self.deadline)
            except ImportError as error:
                raise PhoneFailure('请在举报执行器的 Python 环境安装 requirements-phone.txt。') from error
        return self._bridge

    def close(self):
        if self._bridge is not None:
            self._bridge.close()

    def run(self, args):
        if time.monotonic() >= self.deadline:
            raise PhoneFailure('手机操作超时，请核对当前页面。')
        completed = subprocess.run([self.adb, '-s', self.serial, *args],
                                   capture_output=True, encoding='utf-8', errors='replace',
                                   timeout=min(10, max(0.1, self.deadline - time.monotonic())),
                                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if len(completed.stdout) > 2_000_000:
            raise PhoneFailure('手机返回内容过大。')
        return completed.stdout

    def shell(self, *args):
        return self.run(['shell', ' '.join(shlex.quote(str(arg)) for arg in args)])

    def foreground(self):
        windows = self.shell('dumpsys', 'window', 'windows')
        if not re.search(r'mCurrentFocus=[^\n]*\scom\.xingin\.xhs/', windows):
            raise PhoneFailure('小红书不在前台或出现其他窗口，请人工处理。')

    def open(self, identity):
        policy = self.shell('dumpsys', 'window', 'policy')
        if re.search(r'(?:mShowingLockscreen|isStatusBarKeyguard|showing|mKeyguardShowing)=true', policy):
            raise PhoneFailure('请手动解锁手机。')
        opened = self.shell('am', 'start', '-W', '-a', 'android.intent.action.VIEW',
                            '-d', 'xhsdiscover://item/' + identity + '?type=normal', '-p', PACKAGE)
        if re.search(r'Error:|Exception|unable to resolve', opened, re.I):
            raise PhoneFailure('无法在小红书打开目标笔记。')
        time.sleep(2)
        self.foreground()

    def nodes(self):
        self.foreground()
        if self._bridge is not None:
            xml = self._bridge.hierarchy()
        else:
            remote = '/sdcard/openclaw-report-' + uuid.uuid4().hex + '.xml'
            try:
                self.shell('uiautomator', 'dump', remote)
                xml = self.shell('cat', remote)
            finally:
                self.shell('rm', '-f', remote)
        self.foreground()
        return parse_nodes(xml, PACKAGE)

    def texts(self):
        return [text for node in self.nodes() for text in
                (node.get('text', ''), node.get('content-desc', '')) if text]

    def wait_nodes(self, predicate, message):
        until = min(self.deadline, time.monotonic() + 8)
        while time.monotonic() < until:
            nodes = self.nodes()
            if predicate(nodes):
                return nodes
            time.sleep(0.3)
        raise PhoneFailure(message)

    def click_node(self, node):
        if not self.allow_submit and '提交' in (node.get('text'), node.get('content-desc')):
            raise PhoneFailure('预检模式禁止点击提交。')
        box = bounds(node)
        if not box or node.get('enabled') == 'false' or node.get('_disabled'):
            raise PhoneFailure('控件坐标无效或不可用。')
        left, top, right, bottom = box
        self.foreground()
        self.shell('input', 'tap', (left + right) // 2, (top + bottom) // 2)
        time.sleep(0.4)

    def tap(self, label, *, scroll=None):
        if label == '提交' and not self.allow_submit:
            raise PhoneFailure('预检模式禁止点击提交。')
        resource = PACKAGE + ':id/moreOperateIV' if label == '更多' else None
        previous = None
        for attempt in range(5 if scroll else 1):
            nodes = self.nodes()
            node = select_node(nodes, label, resource)
            if node is not None:
                self.click_node(node)
                self.events.append('tap:' + label)
                return
            signature = [(n.get('text'), n.get('content-desc'), n.get('bounds')) for n in nodes]
            if not scroll or signature == previous or attempt == 4:
                break
            previous = signature
            self.scroll(nodes, scroll)
        raise PhoneFailure('手机界面未找到可点击选项：' + label[:80])

    def scroll(self, nodes, direction):
        boxes = [box for node in nodes if (box := bounds(node))]
        if not boxes:
            raise PhoneFailure('无法确定滚动区域。')
        left, top, right, bottom = max(boxes, key=lambda b: (b[2]-b[0]) * (b[3]-b[1]))
        width, height = right - left, bottom - top
        if direction == 'horizontal':
            labels = ('复制链接', '生成分享图', '建群分享', '举报', '保存图片', '不喜欢', '为ta加热')
            row = [bounds(n) for n in nodes if bounds(n) and any(
                label in (n.get('text'), n.get('content-desc')) for label in labels)]
            if not row or '分享至' not in [n.get('text') for n in nodes]:
                raise PhoneFailure('未确认分享菜单，不能横向滚动。')
            row_top, row_bottom = min(b[1] for b in row), max(b[3] for b in row)
            y = (row_top + row_bottom) // 2
            points = (left + width * 9 // 10, y, left + width // 10, y)
        elif direction == 'vertical':
            if not any('举报' in (n.get('text', '') + n.get('content-desc', '')) for n in nodes):
                raise PhoneFailure('未确认举报表单，不能纵向滚动。')
            # Stay beside the sticky submit button, within the observed app bounds.
            x = left + width * 93 // 100
            points = (x, top + height * 85 // 100, x, top + height * 40 // 100)
        else:
            raise ValueError('Unsupported scroll direction')
        self.foreground()
        self.shell('input', 'swipe', *points, 500)
        self.events.append('scroll:' + direction)
        time.sleep(0.4)

    def open_report(self):
        self.tap('举报', scroll='horizontal')

    def select_category(self, category, subcategory):
        if any(value in ('提交', '下一步', '返回', '举报', '更多')
               for value in (category, subcategory)):
            raise PhoneFailure('举报分类不能是流程操作按钮。')
        group = '对他人造成困扰或危害'
        choices = (group, category, '不实信息、谣言' if category == '不实信息' else category)
        nodes = self.wait_nodes(lambda rows: any(label in (n.get('text'), n.get('content-desc'))
                                                for n in rows for label in choices),
                                '举报分类页尚未就绪，请核查手机。')
        visible = [text for n in nodes for text in (n.get('text', ''), n.get('content-desc', ''))]
        if category == '侵犯我/我的组织的权益':
            raise PhoneFailure('侵权投诉需要身份及材料，请人工选择并处理。')
        if group in visible:
            self.tap(group)
            if category == group:
                category, subcategory = subcategory, None
            if not category:
                raise PhoneFailure('请选择明确的举报原因。')
            self.wait_nodes(lambda rows: any(
                category in (n.get('text'), n.get('content-desc')) or
                '选择举报原因' in n.get('text', '') or
                (category == '不实信息' and n.get('text') == '不实信息、谣言')
                for n in rows), '举报原因列表尚未展开，请核查手机。')
        # A version-specific exact alias, not fuzzy classification of user claims.
        if category == '不实信息' and '不实信息、谣言' in self.texts():
            category = '不实信息、谣言'
        self.tap(category, scroll='vertical')
        if '下一步' in self.texts():
            self.tap('下一步')
        if subcategory:
            self.tap(subcategory, scroll='vertical')

    def check_submit_ready(self):
        if select_node(self.nodes(), '提交') is None:
            raise PhoneFailure('未找到可用的提交按钮。')

    def copied_link(self):
        bridge = self.bridge()
        original = bridge.clipboard()
        sentinel = 'openclaw-' + uuid.uuid4().hex
        copied = sentinel
        try:
            bridge.set_clipboard(sentinel)
            if bridge.clipboard() != sentinel:
                raise PhoneFailure('无法安全读写剪贴板，请人工核对笔记。')
            self.tap('复制链接')
            for _ in range(5):
                copied = bridge.clipboard()
                if copied != sentinel:
                    break
                time.sleep(0.3)
        finally:
            # Do not overwrite clipboard changes made by someone else during execution.
            if bridge.clipboard() in (sentinel, copied):
                bridge.set_clipboard(original)
        links = re.findall(r'https?://[^\s<>"，。]+', copied)
        if len(links) != 1:
            raise PhoneFailure('分享链接不可读取，无法核实笔记身份。')
        resolved = expand_share_link(links[0])
        # Copy usually dismisses the share sheet. Reopen only when it is absent.
        if '分享至' not in self.texts():
            self.tap('更多')
        self.events.append('note-link-copied')
        return resolved

    def fill_reason(self, reason):
        if not reason.strip() or len(reason.encode('utf-16-le')) // 2 > 400:
            raise PhoneFailure('手机举报说明须为1至400字符，未提交。')
        fields = [node for node in self.nodes() if node.get('class') == 'android.widget.EditText']
        if not fields:
            self.tap('补充更多举报信息', scroll='vertical')
            nodes = self.wait_nodes(lambda rows: any(n.get('class') == 'android.widget.EditText' for n in rows),
                                    '举报描述框尚未展开，请核查手机。')
            fields = [node for node in nodes if node.get('class') == 'android.widget.EditText']
        if len(fields) != 1:
            raise PhoneFailure('未找到唯一举报说明输入框，请人工填写。')
        self.foreground()
        self.bridge().set_text(reason)
        if not any(node.get('class') == 'android.widget.EditText' and node.get('text') == reason for node in self.nodes()):
            raise PhoneFailure('举报说明未准确写入，未提交。')
        self.events.append('reason-verified')
        # setText may open the user's existing IME and obscure the sticky submit
        # button. A blind Back could leave the form; consult the service state first.
        keyboard = self.shell('dumpsys', 'input_method')
        if re.search(r'\bmInputShown=true\b', keyboard):
            self.foreground()
            self.shell('input', 'keyevent', '4')
            self.events.append('keyboard-hidden')
            self.wait_nodes(lambda rows: any('提交' in (n.get('text'), n.get('content-desc'))
                                             for n in rows), '收起键盘后未找到提交按钮。')


def execute_phone(data, url, factory=AdbPhone, *, stop_before_submit=False):
    config = data.get('phone')
    if not isinstance(config, dict) or not config.get('serial') or not config.get('userId'):
        return result('manual_required', '此内容需要手机 App；请配置绑定用户的 phone.serial 和 phone.userId。', 'PHONE_NOT_CONFIGURED')
    owner = hashlib.sha256(config['userId'].encode()).hexdigest()
    if Path(data['sessionDir']).name != owner:
        return result('manual_required', '当前用户未绑定该举报手机。', 'PHONE_OWNER_MISMATCH')
    # Same file-lock protocol as phone_read; fail closed on existing/stale locks.
    key = hashlib.sha256(config['serial'].encode()).hexdigest()
    lock = Path(tempfile.gettempdir()) / ('openclaw-phone-' + key + '.lock')
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return result('manual_required', '手机正在使用或存在中断锁，请核查后处理。', 'PHONE_BUSY')
    phone = None
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(dict(pid=os.getpid(), createdAt=datetime.now(timezone.utc).isoformat()), file)
        phone = factory(config)
        phone.allow_submit = not stop_before_submit
        return submit_phone(phone, url, data['category'], data.get('subCategory'), data['reason'],
                            stop_before_submit=stop_before_submit)
    except Exception:
        return result('manual_required', '手机初始化失败，请检查 ADB 和设备授权。', 'PHONE_UNAVAILABLE')
    finally:
        try:
            if phone is not None:
                phone.close()
        except Exception:
            # A shutdown failure must not erase an already observed platform receipt.
            logging.getLogger(__name__).warning('手机自动化服务停止失败，请人工核查。')
        finally:
            lock.unlink(missing_ok=True)
