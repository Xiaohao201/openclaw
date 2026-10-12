# -*- coding: utf-8 -*-
"""
类别文本兼容层
================
解决“数据库里生成的投诉主类别/子类别文字”与“平台页面上可选类别文字”不一致，
导致选择器匹配失败、投诉流程中断的问题。

设计要点：
  1. 本模块是**纯函数**，不 import 任何有副作用的模块（database/browser_manager 等），
     可以安全地被 import、单元测试。
  2. `normalize_category` 只做“确定安全”的清洗：去掉序号前缀、解析 JSON 数组。
     **不**盲目按顿号 `、` 拆分——因为 `、` 可能是单个选项名的一部分
     （例如头条“重复、旧闻”、小红书“虚假、不实内容”）。
  3. 真正的兼容匹配交给 `best_match`：它拿**页面上真实存在的选项文本**做
     “去标点清洗后”的 精确 / 包含 / 相似度 匹配，从而同时兼容：
        - 序号前缀     "9. 标题党"          -> "标题党"
        - JSON 数组     '["不友善","不实信息"]' -> "不友善"
        - 顿号多值      "歧视他人、其他"      -> "歧视他人"（页面里真实存在的那个）
        - 标点差异      "重复、旧闻" == "重复旧闻"
"""

import re
import json
from difflib import SequenceMatcher

# 用于比较时需要剔除的“噪音字符”：各类空白与标点（包含中英文）。
# 剔除后 "重复、旧闻" 与 "重复旧闻" 相等，"9. 标题党" 与 "标题党" 前缀可比。
_PUNCT_RE = re.compile(
    r"[\s、，,。.·・…\-—_/\\|｜（）()\[\]【】{}<>《》\"“”'’`：:；;!！?？~～*※#]+"
)

# 形如 "9. xxx" / "11、xxx" / "3) xxx" / "2．xxx" 的前导序号
_LEADING_INDEX_RE = re.compile(r"^\s*\d{1,3}\s*[\.、．)）\]\:：]\s*")

# 大模型研判文本常描述“违规事实”，而不是直接给出平台类目。这里仅维护含义明确、
# 跨平台稳定的少量别名；具体叶子类目排在父类目前，避免只点到仍需二次选择的父节点。
_SEMANTIC_ALIAS_RULES = (
    (
        ("侮辱谩骂", "不友善言论", "人身攻击"),
        ("侮辱", "谩骂", "辱骂", "名誉贬损", "人格贬损", "贬损性"),
    ),
    (
        (
            "虚假谣言", "造谣传谣", "传播谣言信息、有害信息和虚假信息", "传播虚假信息", "网络谣言", "不实信息", "内容不实", "其他不实信息", "谣言",
            "虚假不实信息", "虚假新闻", "谣言诽谤", "谣言虚假",
            "AI生成虚假信息",
        ),
        (
            "造谣", "传谣", "谣言", "捏造事实", "虚构事实", "虚假事实",
            "虚假新闻", "不实报道", "消息不实",
        ),
    ),
    (
        ("侵犯隐私", "人身权益"),
        ("侵犯隐私", "泄露隐私", "隐私权", "个人隐私"),
    ),
)


def _clean(text):
    """比较用清洗：转字符串、去所有空白与标点。"""
    if text is None:
        return ""
    return _PUNCT_RE.sub("", str(text)).strip()


def normalize_category(text):
    """把数据库里的类别/子类别文本，归一化为“主类别”文本（用于展示与首选匹配）。

    只做安全清洗：
      - None / 空 / 字面量 "none" -> ""
      - JSON 数组 '["A","B"]' -> "A"
      - 去掉前导序号 "9. 标题党" -> "标题党"
    **保留**顿号等选项名内部标点，交给 best_match 去做去标点比对。
    """
    if text is None:
        return ""
    s = str(text).strip()
    if not s or s.lower() == "none":
        return ""

    # JSON 数组（多选被序列化成了字符串）：取第一个作为主类别
    if s.startswith("[") and s.endswith("]"):
        try:
            arr = json.loads(s)
            if isinstance(arr, list) and arr:
                s = str(arr[0]).strip()
        except Exception:
            pass

    # 去掉前导序号
    s = _LEADING_INDEX_RE.sub("", s)
    return s.strip()


def split_categories(text):
    """把可能的“多值”类别拆成列表（JSON 数组或顿号/逗号连接）。

    用于将来支持“多选”场景；当前单选流程主要用 normalize_category 取首值。
    """
    if text is None:
        return []
    s = str(text).strip()
    if not s or s.lower() == "none":
        return []
    if s.startswith("[") and s.endswith("]"):
        try:
            arr = json.loads(s)
            if isinstance(arr, list):
                return [str(x).strip() for x in arr if str(x).strip()]
        except Exception:
            pass
    parts = re.split(r"[、，,/]", _LEADING_INDEX_RE.sub("", s))
    return [p.strip() for p in parts if p.strip()]


def similarity(a, b):
    """两个文本去标点清洗后的相似度（0~1）。"""
    return SequenceMatcher(None, _clean(a), _clean(b)).ratio()


def semantic_alias_match(target, options):
    """用本地关键词把长篇研判文本归到平台真实选项。

    仅匹配 ``_SEMANTIC_ALIAS_RULES`` 中的高置信语义。若文本同时出现多组词，选择
    命中关键词最多的一组；同组内优先返回更具体的叶子类目。无可靠命中时返回
    ``(None, -1, 0.0)``，让调用方继续使用大模型兜底。
    """
    tgt = _clean(normalize_category(target))
    if not tgt:
        return (None, -1, 0.0)

    option_index = {}
    for index, option in enumerate(options):
        cleaned = _clean(option)
        if cleaned and cleaned not in option_index:
            option_index[cleaned] = index

    matches = []
    for rule_index, (preferred_options, keywords) in enumerate(_SEMANTIC_ALIAS_RULES):
        hit_count = sum(1 for keyword in keywords if _clean(keyword) in tgt)
        if not hit_count:
            continue
        for preference, option_name in enumerate(preferred_options):
            index = option_index.get(_clean(option_name))
            if index is not None:
                matches.append((hit_count, -rule_index, -preference, index))
                break

    if not matches:
        return (None, -1, 0.0)

    hit_count, _, _, index = max(matches)
    score = min(0.99, 0.90 + hit_count * 0.02)
    return (options[index], index, score)


def best_match(target, options, threshold=0.5):
    """在 options（页面真实存在的可选项文本）中，为 target 找最匹配的一项。

    匹配优先级（去标点清洗后比较）：
        完全相等 > 前缀包含 > 相互包含 > 序列相似度
    Args:
        target: 数据库里的类别文本（会自动 normalize + clean）
        options: 页面上抓到的候选项文本列表
        threshold: 相似度阈值，低于该值认为“没匹配上”，返回 (None, -1, score)
    Returns:
        (matched_option_text, index, score)
        matched_option_text 为 options 中原始文本（未清洗），便于直接用于点击。
        没匹配上时返回 (None, -1, best_score)。
    """
    tgt = _clean(normalize_category(target))
    if not tgt:
        return (None, -1, 0.0)

    best_opt, best_idx, best_score = None, -1, 0.0
    for i, opt in enumerate(options):
        opt_c = _clean(opt)
        if not opt_c:
            continue

        if tgt == opt_c:
            return (opt, i, 1.0)

        if tgt.startswith(opt_c):
            # 选项是 target 的前缀：多值 "不友善、不实信息" 的主类别 "不友善" 走这里，
            # 给最高的非精确分，确保主类别优先于后续被连接的次类别。
            score = 0.95
        elif opt_c.startswith(tgt):
            # target 是选项的前缀（页面选项更长）
            score = 0.9
        elif opt_c in tgt or tgt in opt_c:
            # 一般包含关系：按长度占比给分
            ratio = min(len(tgt), len(opt_c)) / max(len(tgt), len(opt_c))
            score = 0.6 + 0.3 * ratio
        else:
            score = SequenceMatcher(None, tgt, opt_c).ratio()

        if score > best_score:
            best_opt, best_idx, best_score = opt, i, score

    if best_score >= threshold:
        return (best_opt, best_idx, best_score)
    return (None, -1, best_score)
