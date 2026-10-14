"""Lazy Android 9 clipboard/text bridge; never installs or switches an IME."""
import time


class UiAutomatorBridge:
    def __init__(self, serial, deadline):
        import uiautomator2

        self.deadline = deadline
        # The pinned package ships its server jar. No APK/keyboard bootstrap is used.
        self.device = uiautomator2.connect(serial)

    def call(self, method, *args):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Phone deadline exceeded')
        return self.device.jsonrpc_call(method, list(args), timeout=min(10, remaining))

    def hierarchy(self):
        return self.call('dumpWindowHierarchy', False, 50)

    def clipboard(self):
        return self.call('getClipboard') or ''

    def set_clipboard(self, text):
        self.call('setClipboard', 'OpenClaw', text)

    def set_text(self, text):
        selector = self.device(packageName='com.xingin.xhs',
                               className='android.widget.EditText').selector
        if self.call('count', selector) != 1:
            raise ValueError('Expected exactly one XHS text field')
        if text:
            self.call('setText', selector, text)
        else:
            self.call('clearTextField', selector)

    def close(self):
        self.device.stop_uiautomator()
