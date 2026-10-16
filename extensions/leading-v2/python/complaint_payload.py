# -*- coding: utf-8 -*-
"""Helpers for normalizing complaint rows before browser execution."""
import re


COMPLAINT_REASON_MAX_LENGTH = 190


def extract_intent(text):
    """Prefer the stated complaint over background before applying length limits."""
    text = str(text or '').strip()
    for heading in (r"(?:拟定)?(?:举报|投诉)(?:事由|原因)", r"研判(?:意见|结论)"):
        matches = list(re.finditer(heading + r"\s*(?:[（(][^）)\n]{0,40}[）)])?\s*[：:]", text))
        if matches:
            intent = text[matches[-1].end():]
            intent = re.split(r"(?:举报|投诉)诉求\s*[：:]", intent, maxsplit=1)[0].strip()
            if intent:
                return intent
    return text


def limit_complaint_reason(reason, rewriter=None, *, max_length=COMPLAINT_REASON_MAX_LENGTH):
    """Rewrite an overlong complaint reason and enforce the hard limit.

    AI rewriting is best effort.  The final slice is intentional: platform
    validation must never depend on the model following the length request.
    """
    text = str(reason or "").strip()
    if len(text) <= max_length:
        return text

    rewritten = None
    try:
        if rewriter is None:
            # Local integration never loads machine-wide model credentials.
            return text[:max_length]
        rewritten = rewriter(text, max_length)
    except Exception:
        # AI availability must not block complaint submission. The hard slice
        # below is the guaranteed fallback for import, timeout and API errors.
        rewritten = None

    bounded = str(rewritten or "").strip() or text
    return bounded[:max_length]


def prepare_complaint_data(data, *, max_reason_length=COMPLAINT_REASON_MAX_LENGTH):
    """Normalize reason length and category-classification input.

    Explicit category labels remain authoritative. For direct judgments, keep the
    full allegation available for classification even when the form text is capped.
    """
    prepared = dict(data or {})
    reason = extract_intent(prepared.get("reason"))
    if reason:
        prepared["reason"] = limit_complaint_reason(reason, max_length=max_reason_length)

    category = extract_intent(prepared.get("category"))
    if category:
        prepared["category"] = category
        return prepared

    if reason:
        prepared["category"] = reason
    return prepared
