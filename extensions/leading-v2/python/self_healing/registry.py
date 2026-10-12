"""SQLite-backed version registry for healing profiles and audit events."""

from datetime import datetime
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading

from .schemas import HealingProfile


def _now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


class ProfileRegistry:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS healing_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    query_key TEXT NOT NULL,
                    step_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    profile_json TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '',
                    dom_hash TEXT NOT NULL DEFAULT '',
                    validation_json TEXT NOT NULL DEFAULT '{}',
                    success_count INTEGER NOT NULL DEFAULT 0,
                    failure_count INTEGER NOT NULL DEFAULT 0,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    activated_at TEXT NOT NULL DEFAULT '',
                    UNIQUE(platform, query_key, version)
                );
                CREATE INDEX IF NOT EXISTS idx_healing_profile_active
                    ON healing_profiles(platform, query_key, status, version);
                CREATE TABLE IF NOT EXISTS healing_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    query_key TEXT NOT NULL DEFAULT '',
                    action TEXT NOT NULL,
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS submission_idempotency (
                    idempotency_key TEXT PRIMARY KEY,
                    complaint_id TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    content_id TEXT NOT NULL,
                    account_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    profile_version INTEGER NOT NULL DEFAULT 0,
                    result_evidence TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );
            """)

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        result = dict(row)
        result["profile"] = json.loads(result.pop("profile_json"))
        result["validation"] = json.loads(result.pop("validation_json"))
        return result

    def save_candidate(self, profile, *, model="", dom_hash="", validation=None):
        if not isinstance(profile, HealingProfile):
            raise TypeError("profile must be HealingProfile")
        with self._lock, self._connection() as connection:
            version = connection.execute(
                "SELECT COALESCE(MAX(version),0)+1 FROM healing_profiles "
                "WHERE platform=? AND query_key=?",
                (profile.platform, profile.query_key),
            ).fetchone()[0]
            cursor = connection.execute(
                "INSERT INTO healing_profiles(platform,query_key,step_id,version,status,"
                "profile_json,model,dom_hash,validation_json,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    profile.platform,
                    profile.query_key,
                    profile.step_id,
                    version,
                    "candidate",
                    json.dumps(profile.to_dict(), ensure_ascii=False, separators=(",", ":")),
                    str(model or ""),
                    str(dom_hash or ""),
                    json.dumps(validation or {}, ensure_ascii=False, separators=(",", ":")),
                    _now(),
                ),
            )
            profile_id = cursor.lastrowid
            self._audit(connection, profile.platform, profile.query_key, "candidate_created", {
                "profile_id": profile_id,
                "version": version,
                "model": model,
            })
            row = connection.execute(
                "SELECT * FROM healing_profiles WHERE id=?", (profile_id,)
            ).fetchone()
        return self._decode(row)

    def activate(self, platform, query_key, version):
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? AND version=?",
                (platform, query_key, int(version)),
            ).fetchone()
            if row is None:
                raise KeyError(f"healing profile not found: {platform} v{version}")
            connection.execute(
                "UPDATE healing_profiles SET status='retired' "
                "WHERE platform=? AND query_key=? AND status='active'",
                (platform, query_key),
            )
            connection.execute(
                "UPDATE healing_profiles SET status='active',activated_at=?,"
                "consecutive_failures=0,last_error='' WHERE id=?",
                (_now(), row["id"]),
            )
            self._audit(connection, platform, query_key, "profile_activated", {
                "profile_id": row["id"], "version": int(version)
            })
            active = connection.execute(
                "SELECT * FROM healing_profiles WHERE id=?", (row["id"],)
            ).fetchone()
        return self._decode(active)

    def active(self, platform, query_key):
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? "
                "AND status='active' ORDER BY version DESC LIMIT 1",
                (platform, query_key),
            ).fetchone()
        return self._decode(row)

    def reject(self, platform, query_key, version, reason=""):
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? AND version=?",
                (platform, query_key, int(version)),
            ).fetchone()
            if row is None:
                raise KeyError(f"healing profile not found: {platform} v{version}")
            if row["status"] == "active":
                raise ValueError("active profile must be rolled back, not rejected")
            connection.execute(
                "UPDATE healing_profiles SET status='rejected',last_error=? WHERE id=?",
                (str(reason or "")[:1000], row["id"]),
            )
            self._audit(connection, platform, query_key, "profile_rejected", {
                "profile_id": row["id"], "version": int(version), "reason": reason,
            })

    def rollback(self, platform, query_key):
        with self._lock, self._connection() as connection:
            active = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? "
                "AND status='active' ORDER BY version DESC LIMIT 1",
                (platform, query_key),
            ).fetchone()
            if active is None:
                raise KeyError(f"active healing profile not found: {platform}")
            previous = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? "
                "AND status='retired' ORDER BY version DESC LIMIT 1",
                (platform, query_key),
            ).fetchone()
            if previous is None:
                raise KeyError(f"previous healing profile not found: {platform}")
            connection.execute(
                "UPDATE healing_profiles SET status='rolled_back' WHERE id=?",
                (active["id"],),
            )
            connection.execute(
                "UPDATE healing_profiles SET status='active',activated_at=?,"
                "consecutive_failures=0,last_error='' WHERE id=?",
                (_now(), previous["id"]),
            )
            self._audit(connection, platform, query_key, "manual_rollback", {
                "failed_version": active["version"],
                "restored_version": previous["version"],
            })
            restored = connection.execute(
                "SELECT * FROM healing_profiles WHERE id=?", (previous["id"],)
            ).fetchone()
        return self._decode(restored)

    def list_profiles(self, platform="", status=""):
        clauses = []
        params = []
        if platform:
            clauses.append("platform=?")
            params.append(platform)
        if status:
            clauses.append("status=?")
            params.append(status)
        sql = "SELECT * FROM healing_profiles"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY platform,query_key,version DESC"
        with self._connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [self._decode(row) for row in rows]

    def record_result(self, profile_id, success, error="", rollback_threshold=2):
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM healing_profiles WHERE id=?", (int(profile_id),)
            ).fetchone()
            if row is None:
                return None
            if success:
                connection.execute(
                    "UPDATE healing_profiles SET success_count=success_count+1,"
                    "consecutive_failures=0,last_error='' WHERE id=?",
                    (row["id"],),
                )
                return None
            connection.execute(
                "UPDATE healing_profiles SET failure_count=failure_count+1,"
                "consecutive_failures=consecutive_failures+1,last_error=? WHERE id=?",
                (str(error or "")[:1000], row["id"]),
            )
            failures = int(row["consecutive_failures"]) + 1
            if row["status"] != "active" or failures < max(1, int(rollback_threshold)):
                return None
            previous = connection.execute(
                "SELECT * FROM healing_profiles WHERE platform=? AND query_key=? "
                "AND status='retired' ORDER BY version DESC LIMIT 1",
                (row["platform"], row["query_key"]),
            ).fetchone()
            connection.execute(
                "UPDATE healing_profiles SET status='quarantined' WHERE id=?", (row["id"],)
            )
            if previous is not None:
                connection.execute(
                    "UPDATE healing_profiles SET status='active',activated_at=?,"
                    "consecutive_failures=0,last_error='' WHERE id=?",
                    (_now(), previous["id"]),
                )
            self._audit(connection, row["platform"], row["query_key"], "auto_rollback", {
                "failed_version": row["version"],
                "restored_version": previous["version"] if previous else None,
            })
            restored = previous
        return self._decode(restored)

    def reserve_submission(self, key, complaint_id, platform, content_id, account_id="", version=0):
        with self._lock, self._connection() as connection:
            existing = connection.execute(
                "SELECT status FROM submission_idempotency WHERE idempotency_key=?", (key,)
            ).fetchone()
            if existing is not None:
                if existing["status"] != "FAILED_BEFORE_SUBMIT":
                    return False
                connection.execute(
                    "UPDATE submission_idempotency SET status='RESERVED',updated_at=? "
                    "WHERE idempotency_key=?",
                    (_now(), key),
                )
                return True
            connection.execute(
                "INSERT INTO submission_idempotency(idempotency_key,complaint_id,platform,"
                "content_id,account_id,status,profile_version,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (key, str(complaint_id), platform, str(content_id), str(account_id),
                 "RESERVED", int(version), _now()),
            )
        return True

    def finish_submission(self, key, status, evidence=""):
        allowed = {"SUCCEEDED", "FAILED_BEFORE_SUBMIT", "UNKNOWN_SUBMIT_RESULT"}
        if status not in allowed:
            raise ValueError("invalid submission status")
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE submission_idempotency SET status=?,result_evidence=?,updated_at=? "
                "WHERE idempotency_key=?",
                (status, str(evidence or "")[:1000], _now(), key),
            )

    @staticmethod
    def _audit(connection, platform, query_key, action, detail):
        connection.execute(
            "INSERT INTO healing_audit(platform,query_key,action,detail_json,created_at) "
            "VALUES(?,?,?,?,?)",
            (platform, query_key, action,
             json.dumps(detail or {}, ensure_ascii=False, separators=(",", ":")), _now()),
        )
