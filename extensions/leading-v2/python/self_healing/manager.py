"""Self-healing state machine and safe locator resolution."""

from collections import defaultdict
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import threading
import importlib

from .evidence import EvidenceRecorder
from .llm import LocatorRepairLLM
from .registry import ProfileRegistry
from .sanitizer import collect_page_evidence, sanitize_html
from .schemas import (
    HealingProfile,
    LocatorStrategy,
    QueryDescriptor,
    contains_terminal_action,
    contains_unsafe_healing_action,
)


def descriptor_key(descriptor):
    encoded = json.dumps(
        descriptor.to_dict() if isinstance(descriptor, QueryDescriptor) else descriptor,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]


def infer_step(descriptor, operation=""):
    if isinstance(descriptor, QueryDescriptor):
        text = " ".join((descriptor.kind, descriptor.value, descriptor.role, descriptor.name))
    else:
        text = json.dumps(descriptor or {}, ensure_ascii=False)
    lowered = text.lower()
    if any(marker in lowered for marker in ("textarea", "textbox", "描述", "理由", "说明")):
        return "FILL_DESCRIPTION"
    if any(marker in lowered for marker in ("reason", "option", "原因", "类型", "类别")):
        return "SELECT_REASON"
    if any(marker in lowered for marker in ("report", "举报", "投诉")):
        return "OPEN_REPORT_ENTRY"
    if any(marker in lowered for marker in ("dialog", "modal", "popup", "弹窗")):
        return "VERIFY_REPORT_CONTAINER"
    if operation == "wait_for":
        return "WAIT_FOR_ELEMENT"
    return "LOCATE_ELEMENT"


class DuplicateSubmissionError(RuntimeError):
    pass


class SelfHealingManager:
    def __init__(
        self,
        *,
        enabled=False,
        auto_activate=False,
        model="qwen3.8-flash",
        provider="qwen",
        max_attempts=2,
        failure_threshold=2,
        cooldown_minutes=360,
        snapshot_retention=5,
        snapshot_days=30,
        data_dir=None,
        registry=None,
        llm=None,
    ):
        self.enabled = bool(enabled)
        self.auto_activate = bool(auto_activate)
        self.model = str(model or "qwen3.8-flash")
        self.max_attempts = max(1, min(3, int(max_attempts)))
        self.failure_threshold = max(1, min(5, int(failure_threshold)))
        self.cooldown = timedelta(minutes=max(1, int(cooldown_minutes)))
        root = Path(data_dir or Path.cwd() / "data" / "self_healing")
        self.registry = registry or ProfileRegistry(root / "self_healing.db")
        self.evidence = EvidenceRecorder(
            root / "snapshots",
            retention_per_platform=snapshot_retention,
            retention_days=snapshot_days,
        )
        self.llm = llm or LocatorRepairLLM(provider=provider, model=self.model)
        self._failures = defaultdict(int)
        self._cooldowns = {}
        self._page_cache = {}
        self._successful_snapshots = set()
        self._lock = threading.RLock()
        self._flow = threading.local()

    def wrap_page(self, platform, page):
        from .proxy import HealingPage

        if isinstance(page, HealingPage):
            return page
        key = (str(platform), id(page))
        cached = self._page_cache.get(key)
        if cached is None or cached.raw is not page:
            cached = HealingPage(self, str(platform), page)
            self._page_cache[key] = cached
        return cached

    def begin_flow(self, platform, complaint_data, page_url=""):
        data = dict(complaint_data or {})
        complaint_id = str(data.get("id") or "")
        content_id = str(
            data.get("content_id") or data.get("article_id") or
            data.get("post_id") or data.get("url") or page_url or ""
        )
        account_id = str(data.get("account_id") or "")
        raw_key = "|".join((str(platform), content_id, complaint_id, account_id))
        self._flow.value = {
            "platform": str(platform),
            "complaint_id": complaint_id,
            "content_id": content_id,
            "account_id": account_id,
            "key": hashlib.sha256(raw_key.encode("utf-8")).hexdigest(),
            "reserved": False,
            "terminal_clicked": False,
        }

    def is_terminal(self, descriptor, platform=""):
        if descriptor.dangerous:
            return True
        module_names = {
            "netease": "netease_platform",
            "eastmoney": "eastmoney_platform",
            "tiantianfund": "tiantianfund_platform",
            "tonghuashun": "tonghuashun_platform",
            "tencent": "tencent_platform",
            "xueqiu": "xueqiu_platform",
            "futu": "futu_platform",
            "sohu": "sohu_platform",
            "sina": "sina_platform",
            "yidianzixun": "yidian_platform",
        }
        flow = getattr(self._flow, "value", None) or {}
        module_name = module_names.get(str(platform or flow.get("platform", "")))
        if module_name is None or descriptor.kind != "css":
            return False
        try:
            module = importlib.import_module(module_name)
        except Exception:
            return False
        selectors = []
        for name in ("SUBMIT_SELECTOR", "SUBMIT_FALLBACK_SELECTOR"):
            value = getattr(module, name, "")
            if isinstance(value, (tuple, list)):
                selectors.extend(str(item) for item in value)
            elif value:
                selectors.append(str(value))
        return descriptor.value in selectors

    def before_terminal_action(self, platform, descriptor):
        if not self.is_terminal(descriptor, platform):
            return
        flow = getattr(self._flow, "value", None)
        if not flow or flow.get("platform") != str(platform):
            raise DuplicateSubmissionError("重复提交保护缺少当前任务上下文")
        if flow["reserved"]:
            return
        reserved = self.registry.reserve_submission(
            flow["key"],
            flow["complaint_id"],
            flow["platform"],
            flow["content_id"],
            flow["account_id"],
        )
        if not reserved:
            raise DuplicateSubmissionError("重复提交保护阻止再次点击最终提交")
        flow["reserved"] = True

    def after_terminal_action(self, platform, attempted=True):
        flow = getattr(self._flow, "value", None)
        if flow and flow.get("platform") == str(platform) and attempted:
            flow["terminal_clicked"] = True

    def finish_flow(self, succeeded):
        flow = getattr(self._flow, "value", None)
        if not flow:
            return
        try:
            if not flow["reserved"]:
                return
            if succeeded:
                status = "SUCCEEDED"
            elif flow["terminal_clicked"]:
                status = "UNKNOWN_SUBMIT_RESULT"
            else:
                status = "FAILED_BEFORE_SUBMIT"
            self.registry.finish_submission(flow["key"], status)
        finally:
            self._flow.value = None

    def active_locator(self, platform, scope, descriptor):
        if descriptor.unsafe_to_heal:
            return None, None
        key = descriptor_key(descriptor)
        active = self.registry.active(platform, key)
        if active is None:
            return None, None
        try:
            profile = HealingProfile.from_dict(
                active["profile"],
                platform=platform,
                step_id=active["step_id"],
                query_key=key,
            )
            locator, validation = self._first_valid(scope, profile.strategies)
            if locator is None:
                self.registry.record_result(
                    active["id"], False,
                    "; ".join(validation.get("issues", [])),
                )
                return None, None
            return locator, active["id"]
        except Exception as exc:
            self.registry.record_result(active["id"], False, str(exc))
            return None, None

    def record_query(self, platform, descriptor, event, **details):
        self.evidence.record(platform, {
            "event": event,
            "descriptor": descriptor.to_dict(),
            "query_key": descriptor_key(descriptor),
            **details,
        })

    def record_locator_success(self, platform, descriptor, page, operation):
        if not self.enabled or descriptor.unsafe_to_heal:
            return
        if operation not in {"click", "fill", "hover", "wait_for", "check"}:
            return
        try:
            html = sanitize_html(page.content())
        except Exception:
            html = ""
        if not html:
            return
        query_key = descriptor_key(descriptor)
        dom_hash = hashlib.sha256(html.encode("utf-8")).hexdigest()
        cache_key = (platform, query_key, dom_hash)
        with self._lock:
            if cache_key in self._successful_snapshots:
                return
            self._successful_snapshots.add(cache_key)
        self.evidence.capture(
            platform,
            html,
            "LOCATOR_SUCCEEDED",
            {"query_key": query_key, "operation": operation, "dom_hash": dom_hash},
            bucket=query_key,
        )

    def repair_locator(self, platform, scope, page, descriptor, operation, error=""):
        if (
                not self.enabled
                or descriptor.unsafe_to_heal
                or contains_unsafe_healing_action(operation)):
            return None, None
        query_key = descriptor_key(descriptor)
        try:
            safe_html = sanitize_html(page.content())
        except Exception:
            safe_html = ""
        model_html = collect_page_evidence(page)
        dom_hash = hashlib.sha256(safe_html.encode("utf-8")).hexdigest()
        failure_key = (platform, query_key, dom_hash)
        with self._lock:
            self._failures[failure_key] += 1
            failures = self._failures[failure_key]
        self.record_query(
            platform,
            descriptor,
            "operation_failed",
            operation=operation,
            error=str(error or "")[:500],
            dom_hash=dom_hash,
            failures=failures,
        )
        evidence = None
        if safe_html:
            evidence = self.evidence.capture(
                platform,
                safe_html,
                str(error or "locator operation failed"),
                {"query_key": query_key, "operation": operation, "dom_hash": dom_hash},
                bucket=query_key,
            )

        if failures < self.failure_threshold or not safe_html or not self.llm.available:
            return None, None
        last_generated = self._cooldowns.get(failure_key)
        now = datetime.now()
        if last_generated and now - last_generated < self.cooldown:
            return None, None
        self._cooldowns[failure_key] = now
        feedback = ""
        step_id = infer_step(descriptor, operation)
        descriptor_payload = descriptor.to_dict()
        descriptor_payload["query_key"] = query_key
        for attempt in range(1, self.max_attempts + 1):
            try:
                profile = self.llm.generate(
                    platform=platform,
                    step_id=step_id,
                    descriptor=descriptor_payload,
                    operation=operation,
                    html=model_html,
                    feedback=feedback,
                )
                locator, validation = self._first_valid(scope, profile.strategies)
                history = self._validate_history(
                    page, platform, query_key, profile.strategies
                )
                history_passed = (
                    len(history) >= 3
                    and all(item["passed"] for item in history)
                )
                validation.update({
                    "attempt": attempt,
                    "evidence_id": evidence["evidence_id"],
                    "current_page_passed": locator is not None,
                    "history": history,
                    "historical_regression_required": True,
                    "historical_regression_passed": history_passed,
                    "hard_gate_passed": locator is not None and history_passed,
                })
                if locator is None:
                    feedback = "; ".join(validation["issues"])
                    continue
                saved = self.registry.save_candidate(
                    profile,
                    model=self.model,
                    dom_hash=dom_hash,
                    validation=validation,
                )
                if self.auto_activate and history_passed:
                    active = self.registry.activate(platform, query_key, saved["version"])
                    return locator, active["id"]
                return None, None
            except Exception as exc:
                feedback = f"{type(exc).__name__}: {exc}"[:500]
        return None, None

    def capture_flow_failure(self, platform, page, message):
        try:
            html = sanitize_html(page.content())
        except Exception:
            return ""
        manifest = self.evidence.capture(
            platform,
            html,
            message,
            {"recent_events": self.evidence.recent(platform, 20)},
        )
        return manifest["evidence_id"]

    def handle_flow_failure(self, platform, page, message, healable=False):
        if healable:
            event = self.evidence.last_failed_query(platform)
            if event and event.get("event") == "zero_count":
                payload = event["descriptor"]
                allowed = {
                    key: payload.get(key)
                    for key in ("kind", "value", "role", "name", "exact")
                    if key in payload
                }
                try:
                    descriptor = QueryDescriptor(**allowed)
                    self.repair_locator(
                        platform, page, page, descriptor,
                        "flow_failure", message,
                    )
                except Exception:
                    pass
        return self.capture_flow_failure(platform, page, message)

    def _validate_history(self, page, platform, query_key, strategies):
        results = []
        snapshots = self.evidence.recent_html(
            platform,
            query_key,
            limit=max(3, self.failure_threshold),
            required_reason="LOCATOR_SUCCEEDED",
        )
        for snapshot in snapshots:
            test_page = None
            try:
                test_page = page.context.new_page()
                test_page.set_content(snapshot["html"], wait_until="domcontentloaded")
                locator, report = self._first_valid(test_page, strategies)
                results.append({
                    "path": snapshot["path"],
                    "passed": locator is not None,
                    "issues": report.get("issues", []),
                })
            except Exception as exc:
                results.append({
                    "path": snapshot["path"],
                    "passed": False,
                    "issues": [f"{type(exc).__name__}: {exc}"[:300]],
                })
            finally:
                if test_page is not None:
                    try:
                        test_page.close()
                    except Exception:
                        pass
        return results

    @staticmethod
    def _strategy_locator(scope, strategy):
        if not isinstance(strategy, LocatorStrategy):
            strategy = LocatorStrategy.from_dict(strategy)
        if strategy.kind == "css":
            return scope.locator(strategy.selector)
        if strategy.kind == "role":
            return scope.get_by_role(
                strategy.role, name=strategy.name, exact=strategy.exact
            )
        if strategy.kind == "text":
            return scope.get_by_text(strategy.text, exact=strategy.exact)
        if strategy.kind == "label":
            return scope.get_by_label(strategy.text, exact=strategy.exact)
        if strategy.kind == "placeholder":
            return scope.get_by_placeholder(strategy.text, exact=strategy.exact)
        raise ValueError(f"unsupported strategy: {strategy.kind}")

    def _first_valid(self, scope, strategies):
        issues = []
        for index, strategy in enumerate(strategies):
            try:
                locator = self._strategy_locator(scope, strategy)
                count = locator.count()
                if count != 1:
                    issues.append(f"strategy[{index}] count={count}, expected 1")
                    continue
                node = locator.first
                if not node.is_visible():
                    issues.append(f"strategy[{index}] element is hidden")
                    continue
                try:
                    if not node.is_enabled():
                        issues.append(f"strategy[{index}] element is disabled")
                        continue
                except Exception:
                    pass
                try:
                    text = node.inner_text(timeout=1000).strip()
                except Exception:
                    text = ""
                try:
                    fingerprint = node.evaluate("""
                        element => [
                            element.tagName || '', element.getAttribute('type') || '',
                            element.id || '', element.className || '',
                            element.getAttribute('name') || '',
                            element.getAttribute('role') || '',
                            element.getAttribute('aria-label') || ''
                        ].join(' ')
                    """)
                except Exception:
                    fingerprint = ""
                if contains_unsafe_healing_action(f"{text} {fingerprint}"):
                    issues.append(
                        f"strategy[{index}] resolved to immutable or unsafe action"
                    )
                    continue
                return locator, {"passed": True, "issues": issues, "strategy_index": index}
            except Exception as exc:
                issues.append(f"strategy[{index}] {type(exc).__name__}: {exc}"[:300])
        return None, {"passed": False, "issues": issues}
