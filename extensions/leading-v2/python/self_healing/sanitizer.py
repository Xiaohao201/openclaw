"""Remove credentials and personal data before retaining or sending page evidence."""

import re


_BLOCK_RE = re.compile(
    r"(?is)<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>"
)
_EVENT_RE = re.compile(r"(?i)\s+on[a-z]+\s*=\s*(['\"]).*?\1")
_VALUE_RE = re.compile(
    r"(?i)(<(?:input|textarea)\b[^>]*?\svalue\s*=\s*)(['\"])(.*?)\2"
)
_TEXTAREA_RE = re.compile(r"(?is)(<textarea\b[^>]*>).*?(</textarea\s*>)")
_SECRET_RE = re.compile(
    r"(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"cookie|session(?:id)?)(\s*[=:]\s*)(['\"]?)[^'\"\s<]{6,}"
)
_JWT_RE = re.compile(
    r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"
)
_EMAIL_RE = re.compile(r"(?<![\w.-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
_PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
_ID_RE = re.compile(r"(?<!\d)\d{6}(?:19|20)\d{2}[01]\d[0-3]\d\d{3}[0-9Xx](?!\d)")
_UPLOAD_PATH_RE = re.compile(
    r"(?i)(?:[a-z]:\\|/home/|/users/|/tmp/)[^\s'\"<>]+\.(?:png|jpe?g|gif|webp|pdf)"
)
_WHITESPACE_RE = re.compile(r"[ \t]{2,}")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def sanitize_html(html, max_chars=60000):
    """Return a bounded, deterministic and strongly redacted HTML snapshot."""
    output = str(html or "")
    output = _BLOCK_RE.sub("", output)
    output = _EVENT_RE.sub("", output)
    output = _VALUE_RE.sub(r"\1\2[REDACTED]\2", output)
    output = _TEXTAREA_RE.sub(r"\1[REDACTED]\2", output)
    output = _SECRET_RE.sub(r"\1\2[REDACTED]", output)
    output = _JWT_RE.sub("[REDACTED_JWT]", output)
    output = _EMAIL_RE.sub("[REDACTED_EMAIL]", output)
    output = _PHONE_RE.sub("[REDACTED_PHONE]", output)
    output = _ID_RE.sub("[REDACTED_ID]", output)
    output = _UPLOAD_PATH_RE.sub("[REDACTED_FILE]", output)
    output = _WHITESPACE_RE.sub(" ", output)
    output = _BLANK_LINES_RE.sub("\n\n", output).strip()
    return output[:max(1000, min(200000, int(max_chars)))]


def collect_page_evidence(page, max_chars=60000):
    """Put visible interactive DOM before the bounded full document.

    Large news pages often place the report dialog after the first 60k HTML
    characters.  A deterministic interactive-element index keeps relevant,
    evidence-grounded targets in the model input without granting the model any
    browser capability.
    """
    interactive = ""
    try:
        interactive = page.locator(
            "button,a,input,textarea,select,label,[role='button'],[role='dialog']"
        ).evaluate_all("""
            elements => elements.filter(element => {
                const style = getComputedStyle(element);
                return !element.hidden && style.display !== 'none' &&
                       style.visibility !== 'hidden';
            }).slice(0, 300).map(element => element.outerHTML).join('\\n')
        """)
    except Exception:
        interactive = ""
    try:
        full = page.content()
    except Exception:
        full = ""
    combined = (
        "<self-healing-interactive-index>\n" + str(interactive or "") +
        "\n</self-healing-interactive-index>\n" + str(full or "")
    )
    return sanitize_html(combined, max_chars=max_chars)


def safe_network_summary(method, url, status=0):
    """Keep only non-secret request metadata; query strings and bodies are discarded."""
    from urllib.parse import urlsplit

    parsed = urlsplit(str(url or ""))
    return {
        "method": str(method or "GET").upper(),
        "origin": f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else "",
        "path": parsed.path,
        "status": int(status or 0),
    }
