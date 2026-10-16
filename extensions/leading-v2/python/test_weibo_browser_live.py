"""Real Weibo handler and shared Chrome lease against an entirely offline DOM."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


RUNTIME = Path(os.environ.get("OPENCLAW_COMPLAINT_SMOKE_RUNTIME", Path(__file__).resolve().parent)).resolve()
JUDGMENT = (
    "事实背景：评论引用了造谣、谣言等争论。" * 12
    + "研判意见（黄色预警）：该内容挑动性别对立，攻击特定性别群体，"
    "涉嫌煽动不友善、挑动群体对立信息。举报诉求：请平台核查。"
)
CONTENT = """<meta charset="utf-8"><title>Offline report fixture</title>
<script>window.fixtureSubmissions=0;window.fixtureCategories=[];</script>
<i title="更多">更多</i><div role="button" onclick="window.open('/offline-report')"><div>投诉</div></div>"""
REPORT = """<meta charset="utf-8"><h4>侵权投诉专区</h4>
<div id="categories">
  <a onclick="opener.fixtureCategories.push(this.textContent);categories.hidden=true;leaves.hidden=false">不友善言论</a>
  <a onclick="throw Error('Background must not select rumors')">不实信息</a>
</div>
<div id="leaves" hidden>
  <a onclick="opener.fixtureCategories.push(this.textContent);leaves.hidden=true;form.hidden=false">人身攻击</a>
</div>
<div id="form" hidden>
  <a href="#terms">举报须知</a>
  <button>继续投诉</button><textarea placeholder="请详细填写"></textarea>
  <input type="checkbox" name="chk">
  <a onclick="if(!document.querySelector('input').checked)throw Error('Terms unchecked');
      opener.fixtureSubmissions++;opener.fixtureReason=document.querySelector('textarea').value;
      document.getElementById('receipt').textContent='提交成功'">提交</a>
</div><p id="receipt"></p>"""
SCRIPT = """
import io,json,sys
from types import SimpleNamespace
import browser_manager,runner
data=json.load(sys.stdin)
fixture=data.pop('fixture')
OriginalManager=browser_manager.BrowserManager
browser_manager.time=SimpleNamespace(sleep=lambda _: None)
def factory():
    manager=OriginalManager()
    original_init=manager.init_browsers
    def init(platform):
        original_init(platform)
        def route(request):
            if 'resources' in fixture:
                body=fixture['resources'].get(request.request.url)
                if body is None:
                    request.abort()
                    return
            elif request.request.url=='https://weibo.com/offline-fixture':
                body=fixture['content']
            elif request.request.url=='https://weibo.com/offline-report':
                body=fixture['report']
            else:
                request.abort()
                return
            request.fulfill(status=200,content_type='text/html; charset=utf-8',body=body)
        manager.contexts[platform].route('**/*',route)
    manager.init_browsers=init
    manager.check_login_status=lambda platform: True
    return manager
browser_manager.BrowserManager=factory
sys.stdin=io.StringIO(json.dumps(data))
runner.main()
"""


@unittest.skipUnless(os.environ.get("OPENCLAW_COMPLAINT_BROWSER_SMOKE") == "1", "opt-in Chrome smoke")
class WeiboBrowserLiveTest(unittest.TestCase):
    def test_real_handler_classifies_fills_and_submits_only_the_offline_form(self):
        from playwright.sync_api import sync_playwright
        for category, expected in ((JUDGMENT, "done"), ("无对应分类的测试内容", "failed")):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
                profile, session = Path(directory) / "profile", Path(directory) / "session"
                session.mkdir()
                owner = playwright.chromium.launch_persistent_context(
                    str(profile), channel="chrome", headless=True, args=["--remote-debugging-port=0"])
                try:
                    page = owner.pages[0]
                    marker = "12345678-1234-1234-1234-123456789abc"
                    page.evaluate("value => window.__openclaw_session_handoff_v1=value", marker)
                    port = (profile / "DevToolsActivePort").read_text().splitlines()[0]
                    binding = dict(version=1, profileDir=str(profile), cdpUrl=f"http://127.0.0.1:{port}")
                    (session / "browser-binding.json").write_text(json.dumps(binding), encoding="utf-8")
                    payload = dict(platform="weibo", link="https://weibo.com/offline-fixture",
                        category=category, reason=JUDGMENT, sessionDir=str(session),
                        browserHandoff=dict(version=1, targetId="fixture", marker=marker, binding=binding),
                        fixture=dict(content=CONTENT, report=REPORT))
                    result = subprocess.run([sys.executable, "-c", SCRIPT], input=json.dumps(payload),
                        cwd=RUNTIME, text=True, encoding="utf-8", capture_output=True, timeout=60,
                        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    outcome = json.loads(result.stdout)
                    self.assertEqual(outcome["state"], expected, result.stdout + result.stderr)
                    self.assertFalse(page.is_closed())
                    self.assertEqual(len(owner.pages), 1)
                    self.assertFalse((session / "execution.lock").exists())
                    if expected == "done":
                        screenshot = session / 'screenshots' / outcome['screenshot']['fileName']
                        self.assertTrue(screenshot.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))
                        self.assertGreater(screenshot.stat().st_size, 100)
                        self.assertEqual(page.evaluate("window.fixtureCategories"), ["不友善言论", "人身攻击"])
                        self.assertEqual(page.evaluate("window.fixtureSubmissions"), 1)
                        self.assertIn("挑动性别对立", page.evaluate("window.fixtureReason"))
                        self.assertNotIn("事实背景", page.evaluate("window.fixtureReason"))
                    else:
                        self.assertEqual(page.evaluate("window.fixtureSubmissions"), 0)
                        self.assertEqual(page.evaluate("window.fixtureCategories"), [])
                        self.assertEqual(outcome["errorCode"], "FORM_VALIDATION_FAILED")
                        self.assertIn("未点击提交", outcome["message"])
                finally:
                    owner.close()


if __name__ == "__main__":
    unittest.main()
