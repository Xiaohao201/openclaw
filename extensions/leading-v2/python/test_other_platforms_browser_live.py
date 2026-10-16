"""Real web handlers against offline DOMs, through the shared CDP browser lease."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_weibo_browser_live import RUNTIME, SCRIPT


BOOT = '<meta charset="utf-8"><script>window.fixtureSubmissions=0;window.fixtureCategories=[];</script>'
ZH_URL = 'https://zhuanlan.zhihu.com/p/123456789'
XHS_URL = 'https://www.xiaohongshu.com/explore/654321abcdef012345abcdef'
BILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD/'
JUDGMENT = '事实背景：背景讨论。' * 40 + '举报事由：捏造事实传播谣言。'
ZH = BOOT + '''<div class="Post-ActionMenuButton"><button>更多</button></div>
<button onclick="document.getElementById('form').innerHTML=document.getElementById('template').innerHTML;this.remove()">举报</button>
<section id="form"></section><template id="template"><div onclick="fixtureCategories.push(this.textContent)">不实信息</div>
<textarea name="customReason"></textarea>
<button onclick="fixtureSubmissions++;receipt.textContent='提交成功'">提交举报</button>
<p id="receipt"></p></template>'''
XHS = BOOT + '''<button class="reds-icon more">更多</button><button>举报</button>
<div class="list-select-item-option" onclick="fixtureCategories.push(this.textContent)">不实信息</div>
<button onclick="document.getElementById('children').hidden=false">下一步</button>
<section id="children" hidden><div class="choice-item"
onclick="fixtureCategories.push(this.textContent)">虚假信息</div></section>
<textarea class="advice-input"></textarea>
<button onclick="fixtureSubmissions++;receipt.textContent='提交成功'">提交</button><p id="receipt"></p>'''
BILI = BOOT + '''<span class="video-tool-more-reference">更多</span><span>稿件举报</span>
<iframe name="appeal" src="/offline-report"></iframe><p id="receipt"></p>'''
BILI_FRAME = '''<meta charset="utf-8"><div
onclick="parent.fixtureCategories.push(this.textContent)">不实信息</div>
<textarea aria-label="详细描述 * 0/"></textarea><button
onclick="parent.fixtureSubmissions++;parent.document.getElementById('receipt').textContent='提交成功'">提交</button>'''


@unittest.skipUnless(os.environ.get('OPENCLAW_COMPLAINT_BROWSER_SMOKE') == '1', 'opt-in Chrome smoke')
class OtherPlatformsBrowserLiveTest(unittest.TestCase):
    def test_real_text_iframe_and_multilevel_handlers(self):
        from playwright.sync_api import sync_playwright
        cases = (
            ('zhihu', ZH_URL, {ZH_URL: ZH}, 'done', ['不实信息']),
            ('bilibili', BILI_URL, {BILI_URL: BILI,
                'https://www.bilibili.com/offline-report': BILI_FRAME}, 'done', ['不实信息']),
            ('xiaohongshu', XHS_URL, {XHS_URL: XHS}, 'done', ['不实信息', '虚假信息']),
            ('xiaohongshu', XHS_URL, {XHS_URL: XHS.replace('虚假信息', '无匹配子类别')},
                'failed', ['不实信息']),
        )
        for platform, url, resources, expected, categories in cases:
            with self.subTest(platform=platform, expected=expected), tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
                profile, session = Path(directory) / 'profile', Path(directory) / 'session'
                session.mkdir()
                owner = playwright.chromium.launch_persistent_context(
                    str(profile), channel='chrome', headless=True, args=['--remote-debugging-port=0'])
                try:
                    page = owner.pages[0]
                    marker = '12345678-1234-1234-1234-123456789abc'
                    page.evaluate('value => window.__openclaw_session_handoff_v1=value', marker)
                    port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
                    binding = dict(version=1, profileDir=str(profile), cdpUrl=f'http://127.0.0.1:{port}')
                    (session / 'browser-binding.json').write_text(json.dumps(binding), encoding='utf-8')
                    payload = dict(platform=platform, link=url, category=JUDGMENT, reason=JUDGMENT,
                        sessionDir=str(session), fixture=dict(resources=resources),
                        browserHandoff=dict(version=1, targetId='fixture', marker=marker, binding=binding))
                    result = subprocess.run([sys.executable, '-c', SCRIPT], input=json.dumps(payload),
                        cwd=RUNTIME, text=True, encoding='utf-8', capture_output=True, timeout=60,
                        env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    outcome = json.loads(result.stdout)
                    self.assertEqual(outcome['state'], expected, result.stdout + result.stderr)
                    self.assertFalse(page.is_closed())
                    self.assertEqual(len(owner.pages), 1)
                    self.assertFalse((session / 'execution.lock').exists())
                    self.assertEqual(page.evaluate('window.fixtureCategories'), categories)
                    self.assertEqual(page.evaluate('window.fixtureSubmissions'), 1 if expected == 'done' else 0)
                    if expected == 'done':
                        screenshot = session / 'screenshots' / outcome['screenshot']['fileName']
                        self.assertTrue(screenshot.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))
                        self.assertGreater(screenshot.stat().st_size, 100)
                        form = page.frame_locator('iframe') if platform == 'bilibili' else page
                        self.assertEqual(form.locator('textarea').input_value(), '捏造事实传播谣言。')
                    else:
                        self.assertEqual(outcome['errorCode'], 'FORM_VALIDATION_FAILED')
                        self.assertIn('未点击提交', outcome['message'])
                finally:
                    owner.close()


if __name__ == '__main__':
    unittest.main()
