"""Diagnostic stream is separate from the stdout result protocol."""
import sys


def log_message(message, is_error=False):
    print(str(message), file=sys.stderr, flush=True)


def log_diagnostic(stage, error=None):
    """Machine-readable allowlisted metadata; never exception text or page content."""
    import json
    import re
    token = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
    if not re.fullmatch(token, stage):
        return
    event = {"stage": stage}
    if error is not None and re.fullmatch(token, type(error).__name__):
        event["errorType"] = type(error).__name__
    print("OPENCLAW_DIAGNOSTIC " + json.dumps(event), file=sys.stderr, flush=True)
