"""Match stated complaint intent against Weibo's visible, non-terminal choices."""

from dataclasses import dataclass

from browser_actions import click_non_terminal_option
from category_matcher import best_match, normalize_category, semantic_alias_match
from complaint_payload import extract_intent
from self_healing.schemas import contains_terminal_action


_GROUP_ATTACK_WORDS = (
    "不友善", "群体对立", "性别对立", "群体攻击", "攻击特定性别群体", "引战",
)
_GROUP_ATTACK_OPTIONS = (
    "不友善言论", "不友善", "人身攻击", "恶意引战", "引战", "侮辱谩骂",
)
_NAVIGATION = frozenset((
    "取消", "确认", "确定", "完成", "关闭", "搜索", "登录", "注册", "关注",
    "更多", "首页", "下一步", "上一步", "继续", "返回", "继续投诉", "投诉", "举报",
))


def match_category(target, options):
    """Return an observed option index, never an invented or generic fallback."""
    intent = extract_intent(target)
    if not intent:
        return None
    _, index, score = best_match(intent, options, threshold=0.75)
    if score == 1:
        return index
    if any(word in intent for word in _GROUP_ATTACK_WORDS):
        normalized = [normalize_category(option) for option in options]
        for preferred in _GROUP_ATTACK_OPTIONS:
            if preferred in normalized:
                return normalized.index(preferred)
    _, alias_index, alias_score = semantic_alias_match(intent, options)
    if alias_score > score:
        return alias_index
    return index if index >= 0 else None


@dataclass(frozen=True)
class ReasonSelection:
    selected: str | None
    options: tuple[str, ...]


def select_reason(page, target, *, previous_options=()):
    """Select only visible enabled category links; optionally restrict to new leaves."""
    links = page.locator("//a")
    if not links.count():
        try:
            page.wait_for_selector("//a", timeout=10000)
        except Exception:
            return ReasonSelection(None, ())
        links = page.locator("//a")
    nodes, options = [], []
    for index in range(min(links.count(), 120)):
        node = links.nth(index)
        if not node.is_visible() or not node.is_enabled():
            continue
        text = node.inner_text(timeout=1000).strip()
        if (not text or len(text) > 80 or text in _NAVIGATION
                or text in previous_options or contains_terminal_action(text)):
            continue
        nodes.append(node)
        options.append(text)
    selected_index = match_category(target, options)
    if selected_index is None:
        return ReasonSelection(None, tuple(options))
    click_non_terminal_option(nodes[selected_index])
    return ReasonSelection(options[selected_index], tuple(options))
