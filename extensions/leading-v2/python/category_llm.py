# -*- coding: utf-8 -*-
"""
AI 文本处理（基于 milu，进程内调用）
=========================================
当 category_matcher 的“字符匹配”兜不住（AI 生成的类别文本换了说法、与平台真实
选项字面重叠很低，如“造谣/谣言/消息不属实”对不上“不实信息”）时，用 milu 调大模型
做**语义归类**，把库文本归到“平台当前真实存在的选项”之一。
同一模型也用于将超过平台限制的举报理由改写为简洁文本。

设计要点：
  - milu 作为 PyPI 依赖包直接 `import`（`pip install milu`）；API Key 由 milu 自动从
    用户级 `~/.milu/.env` 读取，本项目不硬编码密钥。
  - 类别归类仅在字符匹配失败时兜底调用；理由改写仅在超过限制时调用。
  - milu 为 async 接口，这里在**独立事件循环**里同步执行（浏览器流程是同步的）。
  - 任何异常/超时/未安装都返回 None，**绝不阻断投诉主流程**。
  - 进程内缓存相同输入的结果，避免重复调用。
"""
import asyncio
import threading

from log_utils import log_message
from config import MILU_CLASSIFY_ENABLED, MILU_PROVIDER, MILU_MODEL

# 进程内缓存：key=(text, tuple(options)) -> 命中的真实选项 或 None
_cache = {}
_rewrite_cache = {}
_milu_ready = None  # None=未探测, True/False


def _ensure_milu():
    """探测 milu 是否可用，并加载用户级 .env（含各 provider 的 API Key）。只做一次。"""
    global _milu_ready
    if _milu_ready is not None:
        return _milu_ready
    try:
        # 加载 ~/.milu/.env（milu setup 写入），拿到 {PROVIDER}_API_KEY
        from milu._env import ensure_dotenv_loaded
        ensure_dotenv_loaded()
    except Exception:
        pass
    try:
        import milu  # noqa: F401
        _milu_ready = True
    except Exception as e:
        log_message(f"milu 不可用，AI 功能停用（pip install milu 可启用）：{e}")
        _milu_ready = False
    return _milu_ready


async def _classify_async(text, options):
    from milu import ModelRegistry, Message, MessageRole
    llm = ModelRegistry.create(MILU_PROVIDER, model=MILU_MODEL)
    prompt = (
        "你是内容举报类别归类器。下面是某平台举报时可选的“类别”列表，"
        "请从中选出与用户填写的举报理由语义最接近的一个。\n"
        "严格要求：只输出被选中类别的原文，且必须与列表中某一项**完全一致**；"
        "不要加引号、编号、标点或任何解释；如果没有语义相符的类别，就只输出 NONE。\n\n"
        f"类别列表：{options}\n用户理由：{text}\n最匹配类别："
    )
    out = ""
    async for chunk in llm.chat([Message(role=MessageRole.USER, content=prompt)]):
        if getattr(chunk, "content", None):
            out += chunk.content
    return out.strip()


async def _rewrite_reason_async(text, max_length):
    """将过长的举报理由改写为平台可接受的简洁文本。"""
    from milu import ModelRegistry, Message, MessageRole
    llm = ModelRegistry.create(MILU_PROVIDER, model=MILU_MODEL)
    prompt = (
        "你是内容举报文案编辑。请将下面的举报理由压缩改写，"
        "保留关键事实、违规点和必要的证据描述，不要增加原文没有的事实。\n"
        f"严格要求：改写结果不得超过 {max_length} 个字符（含标点和空格）；"
        "只输出改写后的举报理由，不要标题、引号、解释或字数说明。\n\n"
        f"原始举报理由：{text}\n改写结果："
    )
    out = ""
    async for chunk in llm.chat([Message(role=MessageRole.USER, content=prompt)]):
        if getattr(chunk, "content", None):
            out += chunk.content
    return out.strip()


def _run_sync(coro_factory, timeout):
    """在**独立线程**里用 asyncio.run 执行协程，带超时。

    - 放到独立线程：本函数会在 Playwright 同步会话（主线程跑着自己的 greenlet/loop）
      中被调用，隔离出去可彻底避免 milu 的 asyncio 事件循环与 Playwright 主线程状态互相干扰。
    - asyncio.run 结束时取消残留任务并 shutdown_asyncgens，正确清理 httpx 异步流，
      避免 "Task was destroyed" 告警。
    - coro_factory 是无参可调用，返回协程（在工作线程内创建，避免跨线程绑定 loop）。
    """
    box = {}

    def _worker():
        try:
            box["v"] = asyncio.run(asyncio.wait_for(coro_factory(), timeout=timeout))
        except BaseException as e:  # noqa: BLE001 —— 原样带回主线程处理
            box["e"] = e

    t = threading.Thread(target=_worker, name="milu-worker", daemon=True)
    t.start()
    t.join(timeout + 10)
    if t.is_alive():
        raise asyncio.TimeoutError(f"milu 归类线程超时(>{timeout + 10}s)")
    if "e" in box:
        raise box["e"]
    return box.get("v")


def llm_classify(text, options, timeout=30):
    """用 milu 语义归类，把 text 归到 options 之一。

    Args:
        text:    数据库里的类别文本（可能被 AI 改写、语义漂移）
        options: 平台页面上枚举到的“真实选项”文本列表
        timeout: 单次调用超时（秒）
    Returns:
        命中的真实选项原文（options 中的某一项），或 None（未启用/失败/不匹配）。
    """
    if not MILU_CLASSIFY_ENABLED:
        return None
    text = (text or "").strip()
    real = [o for o in options if o and str(o).strip()]
    if not text or len(real) < 2:
        return None

    key = (text, tuple(real))
    if key in _cache:
        return _cache[key]

    result = None
    if _ensure_milu():
        try:
            ans = _run_sync(lambda: _classify_async(text, real), timeout)
            if ans:
                lines = [ln.strip() for ln in str(ans).splitlines() if ln.strip()]
                ans = lines[-1] if lines else ""
            if ans and ans != "NONE":
                # 校验：必须精确命中某个真实选项（含去标点容错）
                for o in real:
                    if o == ans or str(o).strip() == ans:
                        result = o
                        break
                if result is None:
                    try:
                        from category_matcher import _clean
                        a = _clean(ans)
                        for o in real:
                            if _clean(o) == a:
                                result = o
                                break
                    except Exception:
                        pass
            if result:
                log_message(f"milu语义归类：'{text}' -> '{result}'")
            else:
                log_message(f"milu语义归类未命中：'{text}'（模型返回='{ans}'）")
        except asyncio.TimeoutError:
            log_message(f"milu语义归类超时({timeout}s)：'{text}'", True)
        except Exception as e:
            log_message(f"milu语义归类异常：{e}", True)

    _cache[key] = result
    return result


def llm_rewrite_reason(text, max_length=190, timeout=30):
    """用 milu 压缩过长举报理由；失败时返回 None 交给调用方截断。"""
    text = str(text or "").strip()
    if not text or len(text) <= max_length:
        return text

    key = (text, max_length)
    if key in _rewrite_cache:
        return _rewrite_cache[key]

    result = None
    if _ensure_milu():
        try:
            answer = _run_sync(
                lambda: _rewrite_reason_async(text, max_length), timeout
            )
            answer = str(answer or "").strip()
            if answer:
                result = answer[:max_length]
                log_message(
                    f"milu举报理由改写：{len(text)} -> "
                    f"{len(result)} 个字符"
                )
        except asyncio.TimeoutError:
            log_message(f"milu举报理由改写超时({timeout}s)", True)
        except Exception as e:
            log_message(f"milu举报理由改写异常：{e}", True)

    _rewrite_cache[key] = result
    return result
