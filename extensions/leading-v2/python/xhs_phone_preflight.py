"""Live XHS UI preflight. This entry point has no option to submit a report."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid

from xhs_phone import AdbPhone, PhoneFailure, execute_phone

TEST_REASON = '本地流程适配测试：仅验证中文输入和举报页面交互，不提交举报。'


class PreflightPhone(AdbPhone):
    def __init__(self, config, output_dir):
        super().__init__(config, allow_submit=False)
        self.output_dir = output_dir
        self.cleanup = 'not-needed'

    def close(self):
        # Cleanup has its own bounded budget and still holds the shared device lock.
        self.deadline = time.monotonic() + 30
        if self._bridge is not None:
            self._bridge.deadline = self.deadline
        try:
            if 'reason-verified' in self.events:
                remote = '/sdcard/openclaw-preflight-' + uuid.uuid4().hex + '.png'
                try:
                    self.foreground()
                    self.shell('screencap', '-p', remote)
                    self.run(['pull', remote, str(self.output_dir / 'before-submit.png')])
                finally:
                    self.shell('rm', '-f', remote)
            nodes = self.nodes()
            fields = [node for node in nodes if node.get('class') == 'android.widget.EditText']
            if len(fields) == 1 and fields[0].get('text') == TEST_REASON:
                self.foreground()
                self.bridge().set_text('')
                if '0/400' not in self.texts():
                    raise PhoneFailure('测试说明清理未确认，请在手机核查。')
                self.cleanup = 'reason-cleared'
            # Navigate using the observed report back button, never a guessed coordinate.
            if any('举报' in (n.get('text', '') + n.get('content-desc', '')) for n in self.nodes()):
                self.tap('返回')
                if any(n.get('resource-id') == 'com.xingin.xhs:id/moreOperateIV' for n in self.nodes()):
                    self.cleanup = 'returned-to-note'
        except Exception:
            self.cleanup = 'manual-check-required'
        finally:
            super().close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--user-id', required=True, help='User bound to this reporting phone')
    parser.add_argument('--url', required=True)
    parser.add_argument('--adb-path', default='adb')
    parser.add_argument('--category', default='不实信息、谣言')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    phones = []

    def factory(config):
        phone = PreflightPhone(config, output)
        phones.append(phone)
        return phone

    data = dict(phone=dict(serial=args.serial, userId=args.user_id, adbPath=args.adb_path),
                sessionDir=str(output / hashlib.sha256(args.user_id.encode()).hexdigest()),
                category=args.category, reason=TEST_REASON)
    result = execute_phone(data, args.url, factory=factory, stop_before_submit=True)
    report = dict(result, submitted=False, events=phones[0].events if phones else [],
                  cleanup=phones[0].cleanup if phones else 'not-needed')
    (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))
    return 0 if result['errorCode'] == 'PHONE_PREFLIGHT_READY' and report['cleanup'] == 'returned-to-note' else 1


if __name__ == '__main__':
    sys.exit(main())
