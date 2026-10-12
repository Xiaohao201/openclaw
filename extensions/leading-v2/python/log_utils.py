"""Diagnostic stream is separate from the stdout result protocol."""
import sys


def log_message(message, is_error=False):
    print(str(message), file=sys.stderr, flush=True)
