"""Strict declarative schema for model-generated locator repairs."""

from dataclasses import asdict, dataclass
import re


ALLOWED_KINDS = frozenset({"css", "role", "text", "label", "placeholder"})
_PLATFORM_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
_STEP_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
_DANGEROUS_TEXT_RE = re.compile(
    r"(?:提交(?:举报|反馈|投诉)?|确认提交|立即举报|发送举报|form\s*submit)",
    re.I,
)
_DANGEROUS_SELECTOR_RE = re.compile(
    r"(?:type\s*=\s*['\"]?submit|submit|confirmbtn)",
    re.I,
)
_UNSAFE_HEALING_RE = re.compile(
    r"(?:login|log[_-]?in|sign[_-]?in|password|captcha|verify|verification|"
    r"security|auth|upload|set_input_files|type\s*=\s*['\"]?(?:file|password)|"
    r"登录|登陆|验证码|安全验证|上传)",
    re.I,
)


def contains_terminal_action(value):
    text = str(value or "")
    compact = re.sub(r"[\s'\"=(),\[\]]", "", text).lower()
    ambiguous_terminal = (
        compact in {"确认", "确定"}
        or "text确认" in compact
        or "text确定" in compact
        or "name确认" in compact
        or "name确定" in compact
    )
    return bool(
        ambiguous_terminal
        or _DANGEROUS_TEXT_RE.search(text)
        or _DANGEROUS_SELECTOR_RE.search(text)
    )


def contains_unsafe_healing_action(value):
    """Return true for immutable submit, authentication and upload targets."""
    text = str(value or "")
    return contains_terminal_action(text) or bool(_UNSAFE_HEALING_RE.search(text))


@dataclass(frozen=True)
class QueryDescriptor:
    kind: str
    value: str = ""
    role: str = ""
    name: str = ""
    exact: bool = False

    def to_dict(self):
        return asdict(self)

    @property
    def dangerous(self):
        return contains_terminal_action(" ".join((self.value, self.role, self.name)))

    @property
    def unsafe_to_heal(self):
        return contains_unsafe_healing_action(
            " ".join((self.value, self.role, self.name))
        )


@dataclass(frozen=True)
class LocatorStrategy:
    kind: str
    selector: str = ""
    role: str = ""
    name: str = ""
    text: str = ""
    exact: bool = True

    @classmethod
    def from_dict(cls, payload):
        if not isinstance(payload, dict):
            raise ValueError("locator strategy must be an object")
        kind = str(payload.get("kind", "")).strip().lower()
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unsupported locator strategy: {kind}")
        strategy = cls(
            kind=kind,
            selector=str(payload.get("selector", "")).strip(),
            role=str(payload.get("role", "")).strip(),
            name=str(payload.get("name", "")).strip(),
            text=str(payload.get("text", "")).strip(),
            exact=payload.get("exact", True) is not False,
        )
        strategy.validate()
        return strategy

    def validate(self):
        values = (self.selector, self.role, self.name, self.text)
        if any(len(value) > 300 for value in values):
            raise ValueError("locator value is too long")
        if self.kind == "css":
            if not self.selector:
                raise ValueError("css strategy requires selector")
            if self.selector.startswith("/") or "xpath=" in self.selector.lower():
                raise ValueError("AI-generated XPath is not allowed")
        elif self.kind == "role":
            if not self.role or not self.name:
                raise ValueError("role strategy requires role and name")
        elif self.kind == "text" and not self.text:
            raise ValueError("text strategy requires text")
        elif self.kind in {"label", "placeholder"} and not self.text:
            raise ValueError(f"{self.kind} strategy requires text")
        if contains_unsafe_healing_action(" ".join(values)):
            raise ValueError(
                "submit, authentication and upload locators cannot be healed"
            )

    def to_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class HealingProfile:
    platform: str
    step_id: str
    query_key: str
    strategies: tuple
    notes: str = ""
    base_version: int = 0

    @classmethod
    def from_dict(cls, payload, *, platform, step_id, query_key):
        if not isinstance(payload, dict):
            raise ValueError("healing profile must be an object")
        actual_platform = str(payload.get("platform") or platform).strip().lower()
        actual_step = str(payload.get("step_id") or step_id).strip().upper()
        if actual_platform != platform or not _PLATFORM_RE.fullmatch(actual_platform):
            raise ValueError("profile platform mismatch")
        if actual_step != step_id or not _STEP_RE.fullmatch(actual_step):
            raise ValueError("profile step mismatch")
        raw_strategies = payload.get("strategies")
        if not isinstance(raw_strategies, list) or not 1 <= len(raw_strategies) <= 5:
            raise ValueError("profile requires 1 to 5 strategies")
        strategies = tuple(LocatorStrategy.from_dict(item) for item in raw_strategies)
        return cls(
            platform=actual_platform,
            step_id=actual_step,
            query_key=query_key,
            strategies=strategies,
            notes=str(payload.get("notes", ""))[:500],
            base_version=max(0, int(payload.get("base_version", 0))),
        )

    def to_dict(self):
        return {
            "platform": self.platform,
            "step_id": self.step_id,
            "query_key": self.query_key,
            "strategies": [item.to_dict() for item in self.strategies],
            "notes": self.notes,
            "base_version": self.base_version,
        }
