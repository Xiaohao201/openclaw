"""Bounded receipt screenshots stored in the current user's browser session."""
from datetime import datetime, timezone
import os
from pathlib import Path
from uuid import uuid4


def capture_screenshot(capture, session_dir):
    image = capture()
    if (not isinstance(image, bytes) or not image.startswith(b'\x89PNG\r\n\x1a\n')
            or len(image) > 10 * 1024 * 1024):
        raise ValueError('Invalid receipt screenshot')
    directory = Path(session_dir) / 'screenshots'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = uuid4().hex + '.png'
    target = directory / name
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(image)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return dict(fileName=name, capturedAt=datetime.now(timezone.utc).isoformat())


def attach_screenshot(result, capture, session_dir):
    """Evidence failures must not erase an observed submission or cause a retry."""
    try:
        result['screenshot'] = capture_screenshot(capture, session_dir)
    except Exception:
        result['evidenceError'] = 'SCREENSHOT_CAPTURE_FAILED'
    return result
