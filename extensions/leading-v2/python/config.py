"""Local-only runtime configuration. Never imports deployment credentials."""
import os
from pathlib import Path


def get_base_path():
    value = os.environ.get("OPENCLAW_COMPLAINT_SESSION_DIR")
    if not value or not Path(value).is_absolute():
        raise RuntimeError("A user-scoped session directory is required")
    return value


DebugRun = False
HEADLESS = os.environ.get("OPENCLAW_COMPLAINT_HEADLESS") == "1"
ALL_PLATFORMS = ["wechat", "baidu", "bilibili", "douyin", "eastmoney", "futu",
                 "kuaishou", "netease", "sina", "sohu", "tencent", "tiantianfund",
                 "tonghuashun", "toutiao", "weibo", "xiaohongshu", "xueqiu",
                 "yidianzixun", "zhihu", "report12377"]
PLATFORMS = ALL_PLATFORMS
UC_PLATFORMS = []
CHROMEDRIVER_PATH = ""
# Use deterministic local matching by default; optional milu is administrator configured.
MILU_CLASSIFY_ENABLED = False
MILU_PROVIDER = "qwen"
MILU_MODEL = "qwen3.8-flash"
SELF_HEALING_ENABLED = False
SELF_HEALING_AUTO_ACTIVATE = False
SELF_HEALING_MODEL = MILU_MODEL
SELF_HEALING_MAX_ATTEMPTS = 1
SELF_HEALING_FAILURE_THRESHOLD = 2
SELF_HEALING_COOLDOWN_MINUTES = 360
SELF_HEALING_SNAPSHOT_RETENTION = 5
SELF_HEALING_SNAPSHOT_DAYS = 30
SELF_HEALING_ALLOW_VISION = False
