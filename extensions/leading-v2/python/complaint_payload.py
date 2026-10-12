# -*- coding: utf-8 -*-
"""Helpers for normalizing complaint rows before browser execution."""


COMPLAINT_REASON_MAX_LENGTH = 190


def limit_complaint_reason(reason, rewriter=None):
    """Rewrite an overlong complaint reason and enforce the hard limit.

    AI rewriting is best effort.  The final slice is intentional: platform
    validation must never depend on the model following the length request.
    """
    text = str(reason or "").strip()
    if len(text) <= COMPLAINT_REASON_MAX_LENGTH:
        return text

    rewritten = None
    try:
        if rewriter is None:
            # Local integration never loads machine-wide model credentials.
            return text[:COMPLAINT_REASON_MAX_LENGTH]
        rewritten = rewriter(text, COMPLAINT_REASON_MAX_LENGTH)
    except Exception:
        # AI availability must not block complaint submission. The hard slice
        # below is the guaranteed fallback for import, timeout and API errors.
        rewritten = None

    bounded = str(rewritten or "").strip() or text
    return bounded[:COMPLAINT_REASON_MAX_LENGTH]


def prepare_complaint_data(data):
    """Normalize reason length and category-classification input.

    Legacy tasks already carry ``category`` after the dispatcher classifies the
    linked detection job. Direct AgentJudgment tasks intentionally skip that
    dispatcher, so their bounded ``reason`` text is the best available semantic
    input for the browser flow's existing option matcher.
    """
    prepared = dict(data or {})
    reason = str(prepared.get("reason") or "").strip()
    if reason:
        reason = limit_complaint_reason(reason)
        prepared["reason"] = reason

    category = str(prepared.get("category") or "").strip()
    if category:
        return prepared

    if reason:
        prepared["category"] = reason
    return prepared
