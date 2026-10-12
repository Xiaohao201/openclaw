"""Reusable browser actions that can be unit-tested without launching Chromium."""

from self_healing.schemas import contains_terminal_action


def check_checkbox(scope, selector, timeout=10000):
    """Check a native checkbox, including controls hidden by a styled label.

    Playwright's normal ``check`` action requires the input itself to be visible.
    Some legacy pages hide the native input and expose only a styled label.  In
    that case a DOM click preserves the element's native click/input/change
    events without relying on its layout box.
    """
    checkbox = scope.locator(selector).first
    checkbox.wait_for(state="attached", timeout=timeout)

    if checkbox.is_checked():
        return
    if not checkbox.is_enabled():
        raise RuntimeError("复选框处于禁用状态")

    if checkbox.is_visible():
        checkbox.check(timeout=timeout)
    else:
        checkbox.evaluate("element => element.click()")

    if not checkbox.is_checked():
        raise RuntimeError("复选框未能进入选中状态")


def click_non_terminal_option(node, timeout=10000):
    """Click a verified intermediate option, with a DOM-event fallback for overlays.

    The fallback is deliberately unavailable for final actions.  It is intended
    for reason/category choices whose visible node is occasionally covered by a
    decorative image even though the page's own handler is attached to it.
    """
    text = ""
    try:
        text = node.inner_text(timeout=min(1000, timeout)).strip()
    except Exception:
        pass
    if contains_terminal_action(text):
        raise RuntimeError("最终提交类按钮禁止使用 DOM 点击回退")
    if not node.is_visible():
        raise RuntimeError("中间选项不可见")
    if not node.is_enabled():
        raise RuntimeError("中间选项不可用")
    try:
        node.click(timeout=timeout)
    except Exception:
        node.evaluate("element => element.click()")
