"""Conservative Android fallback for XHS pages explicitly gated to the app."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid
import xml.etree.ElementTree as ET

PACKAGE = 'com.xingin.xhs'
GATES = ('当前内容仅支持在小红书app内查看', '请在小红书app内打开',
         '该内容仅支持在app内查看', '请打开小红书app查看完整内容')


class PhoneFailure(Exception):
    pass


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
    from network_guard import public_url

    def allowed(url):
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and not parsed.username and not parsed.password
                and not parsed.port and any(parsed.hostname == host or
                (parsed.hostname or '').endswith('.' + host)
                for host in ('xiaohongshu.com', 'xhslink.com')) and public_url(url))

    if note_id(value):
        return value
    if not allowed(value):
        raise PhoneFailure('分享链接不受支持。')

    class Redirects(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            if not allowed(newurl):
                raise PhoneFailure('分享链接跳转目标不受支持。')
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    with build_opener(Redirects()).open(Request(value), timeout=8) as response:
        resolved = response.url
    if not note_id(resolved):
        raise PhoneFailure('未能从分享链接核实笔记编号。')
    return resolved


def submit_phone(phone, url, category, subcategory, reason):
    submitting = False
    try:
        identity = note_id(url)
        if not identity:
            raise PhoneFailure('无法核实小红书笔记编号，请先展开短链接。')
        phone.open(identity)
        phone.tap('更多')
        # Read the current note's share URL, never the launch intent or old clipboard.
        if note_id(phone.copied_link()) != identity:
            raise PhoneFailure('手机分享链接与目标笔记不一致，未举报。')
        phone.tap('举报')
        phone.tap(category)
        if '下一步' in phone.texts():
            phone.tap('下一步')
        if subcategory:
            phone.tap(subcategory)
        phone.fill_reason(reason)
        visible = phone.texts()
        if '提交' not in visible or not any('举报' in text for text in visible):
            raise PhoneFailure('未确认举报提交页面，请在手机核对。')
        if any(text in ('举报成功', '提交成功') for text in visible):
            raise PhoneFailure('提交前已出现成功文字，不能确认本次操作。')
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
    def __init__(self, config):
        self.adb = config.get('adbPath', 'adb')
        self.serial = config['serial']
        self.deadline = time.monotonic() + 110

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
        remote = '/sdcard/openclaw-report-' + uuid.uuid4().hex + '.xml'
        try:
            self.shell('uiautomator', 'dump', remote)
            xml = self.shell('cat', remote)
        finally:
            self.shell('rm', '-f', remote)
        self.foreground()
        if '<!DOCTYPE' in xml or '<!ENTITY' in xml:
            raise PhoneFailure('手机界面数据无效。')
        nodes = [node.attrib for node in ET.fromstring(xml).iter('node')
                 if node.get('package') == PACKAGE and node.get('visible-to-user') != 'false']
        texts = [node.get('text', '') for node in nodes]
        if any(any(marker in text for marker in ('验证码', '安全验证', '滑块验证', '登录后')) for text in texts):
            raise PhoneFailure('手机需要登录或安全验证，请人工完成。')
        return nodes

    def texts(self):
        return [text for node in self.nodes() for text in
                (node.get('text', ''), node.get('content-desc', '')) if text]

    def click_node(self, node):
        match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
        if not match or node.get('enabled') == 'false':
            raise PhoneFailure('控件坐标无效或不可用。')
        left, top, right, bottom = map(int, match.groups())
        if right <= left or bottom <= top:
            raise PhoneFailure('控件没有可点击区域。')
        self.foreground()
        self.shell('input', 'tap', (left + right) // 2, (top + bottom) // 2)
        time.sleep(0.4)

    def tap(self, label):
        matches = [node for node in self.nodes() if label in
                   (node.get('text'), node.get('content-desc'))]
        if len(matches) != 1:
            raise PhoneFailure('手机界面未找到唯一选项：' + label[:80])
        self.click_node(matches[0])

    def copied_link(self):
        # Clear first so a stale clipboard can never confirm the requested identity.
        sentinel = 'openclaw-' + uuid.uuid4().hex
        self.shell('cmd', 'clipboard', 'set', sentinel)
        if self.shell('cmd', 'clipboard', 'get').strip() != sentinel:
            raise PhoneFailure('此 Android 不支持安全读取分享链接，请人工核对。')
        self.tap('复制链接')
        copied = self.shell('cmd', 'clipboard', 'get')
        links = re.findall(r'https?://[^\s<>"，。]+', copied)
        if len(links) != 1:
            raise PhoneFailure('分享链接不可读取，无法核实笔记身份。')
        resolved = expand_share_link(links[0])
        # Copy usually dismisses the share sheet. Reopen only when it is absent.
        if '举报' not in self.texts():
            self.tap('更多')
        return resolved

    def fill_reason(self, reason):
        fields = [node for node in self.nodes() if node.get('class') == 'android.widget.EditText']
        if len(fields) != 1:
            raise PhoneFailure('未找到唯一举报说明输入框，请人工填写。')
        if self.shell('settings', 'get', 'secure', 'default_input_method').strip() != 'com.android.adbkeyboard/.AdbIME':
            raise PhoneFailure('请先手动启用 ADBKeyboard 输入法以填写中文举报说明。')
        self.click_node(fields[0])
        encoded = base64.b64encode(reason.encode('utf-8')).decode('ascii')
        self.shell('am', 'broadcast', '-a', 'ADB_CLEAR_TEXT', '-p', 'com.android.adbkeyboard')
        self.shell('am', 'broadcast', '-a', 'ADB_INPUT_B64', '-p', 'com.android.adbkeyboard', '--es', 'msg', encoded)
        if not any(node.get('class') == 'android.widget.EditText' and node.get('text') == reason for node in self.nodes()):
            raise PhoneFailure('举报说明未准确写入，未提交。')


def execute_phone(data, url, factory=AdbPhone):
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
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(dict(pid=os.getpid(), createdAt=datetime.now(timezone.utc).isoformat()), file)
        return submit_phone(factory(config), url, data['category'], data.get('subCategory'), data['reason'])
    except Exception:
        return result('manual_required', '手机初始化失败，请检查 ADB 和设备授权。', 'PHONE_UNAVAILABLE')
    finally:
        lock.unlink(missing_ok=True)
