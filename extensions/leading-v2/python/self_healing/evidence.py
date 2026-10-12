"""In-memory step tracing and bounded on-disk evidence snapshots."""

from collections import defaultdict, deque
from datetime import datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import re
import threading

from .sanitizer import sanitize_html


class EvidenceRecorder:
    def __init__(self, root, retention_per_platform=5, retention_days=30):
        self.root = Path(root)
        self.retention_per_platform = max(1, int(retention_per_platform))
        self.retention_days = max(1, int(retention_days))
        self._events = defaultdict(lambda: deque(maxlen=200))
        self._lock = threading.Lock()

    def record(self, platform, event):
        payload = dict(event or {})
        payload["at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._lock:
            self._events[str(platform)].append(payload)

    def recent(self, platform, limit=50):
        with self._lock:
            values = list(self._events.get(str(platform), ()))
        return values[-max(1, min(200, int(limit))):]

    def last_failed_query(self, platform):
        for event in reversed(self.recent(platform, 100)):
            if event.get("event") in {"operation_failed", "zero_count"}:
                if isinstance(event.get("descriptor"), dict):
                    return event
        return None

    def capture(self, platform, html, reason, metadata=None, bucket=""):
        safe = sanitize_html(html)
        digest = hashlib.sha256(safe.encode("utf-8")).hexdigest()
        platform_name = str(platform or "unknown").lower()
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,31}", platform_name):
            platform_name = "unknown"
        bucket_name = str(bucket or "").lower()
        if bucket_name and not re.fullmatch(r"[a-z0-9_-]{4,80}", bucket_name):
            bucket_name = ""
        directory = self.root / platform_name
        if bucket_name:
            directory = directory / bucket_name
        resolved_root = self.root.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        resolved_directory = directory.resolve()
        if resolved_root != resolved_directory and resolved_root not in resolved_directory.parents:
            raise RuntimeError("evidence directory escaped configured root")
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
        path = directory / f"{stamp}_{digest[:12]}.html.gz"
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            handle.write(safe)
        manifest = {
            "evidence_id": digest[:20],
            "platform": platform_name,
            "path": str(path),
            "content_hash": digest,
            "reason": str(reason or "")[:500],
            "metadata": dict(metadata or {}),
            "bucket": bucket_name,
        }
        with (path.with_suffix(path.suffix + ".json")).open("w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
        self._prune(directory)
        return manifest

    def recent_html(self, platform, bucket="", limit=3, required_reason=""):
        platform_name = str(platform or "unknown").lower()
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,31}", platform_name):
            return []
        bucket_name = str(bucket or "").lower()
        if bucket_name and not re.fullmatch(r"[a-z0-9_-]{4,80}", bucket_name):
            return []
        directory = self.root / platform_name
        if bucket_name:
            directory = directory / bucket_name
        root = self.root.resolve()
        resolved = directory.resolve()
        if root != resolved and root not in resolved.parents:
            return []
        output = []
        paths = sorted(
                resolved.glob("*.html.gz"),
                key=lambda item: item.stat().st_mtime,
                reverse=True)
        for path in paths:
            if len(output) >= max(1, min(10, int(limit))):
                break
            try:
                if required_reason:
                    manifest_path = path.with_suffix(path.suffix + ".json")
                    with manifest_path.open("r", encoding="utf-8") as handle:
                        manifest = json.load(handle)
                    if manifest.get("reason") != required_reason:
                        continue
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    output.append({"path": str(path), "html": handle.read()})
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
        return output

    def _prune(self, directory):
        root = self.root.resolve()
        resolved = Path(directory).resolve()
        if root != resolved and root not in resolved.parents:
            raise RuntimeError("evidence directory escaped configured root")
        cutoff = datetime.now() - timedelta(days=self.retention_days)
        files = sorted(
            resolved.glob("*.html.gz"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for index, path in enumerate(files):
            stale = datetime.fromtimestamp(path.stat().st_mtime) < cutoff
            if index >= self.retention_per_platform or stale:
                path.resolve().relative_to(root)
                path.unlink(missing_ok=True)
                path.with_suffix(path.suffix + ".json").unlink(missing_ok=True)
