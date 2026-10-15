import type { OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { UserBrowserProfiles } from "./complaint-user-browser.js";

type Context = { agentId?: string; sessionKey?: string; sessionId?: string };
export type BrowserHandoff = {
  version: 1;
  targetId: string;
  marker: string;
  binding: Record<string, unknown>;
};
type Identity = { profile: string; binding: Record<string, unknown> };
type Selection = Identity & { targetId: string; marker: string; expires: number };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function owner(ctx: Context) {
  if (
    !extractUserId(ctx.agentId) ||
    !ctx.sessionId ||
    !ctx.sessionKey?.startsWith(`agent:${ctx.agentId}:`)
  ) {
    throw new Error("当前对话缺少可信 session 身份，不能交接浏览器。");
  }
  return JSON.stringify([ctx.agentId, ctx.sessionKey, ctx.sessionId]);
}

/** Process-local selection, derived only from completed browser tool calls. */
export class SessionBrowserHandoffs {
  private selections = new Map<string, Selection>();
  private claims = new Map<string, string>();
  private busy = new Set<string>();
  constructor(private resolve: (ctx: Context, profile?: string) => Promise<Identity>) {}

  async before(ctx: Context, params: Record<string, unknown>) {
    const key = owner(ctx);
    if (params.node || (params.target && params.target !== "host")) {
      throw new Error("当前用户的浏览器仅支持本机 host，不支持 node 或 sandbox。");
    }
    const identity = await this.resolve(
      ctx,
      typeof params.profile === "string" ? params.profile : undefined,
    );
    if (this.busy.has(identity.profile)) {
      throw new Error("此浏览器已交给举报执行器，完成前请勿操作或关闭。");
    }
    const pageAction = [
      "focus",
      "close",
      "snapshot",
      "screenshot",
      "navigate",
      "console",
      "pdf",
      "upload",
      "dialog",
      "act",
    ].includes(String(params.action));
    let target =
      typeof params.targetId === "string" ? params.targetId : object(params.request)?.targetId;
    if (pageAction && typeof target !== "string") {
      // Do not let the browser's global last-tab fallback select another conversation's page.
      const selected = this.selections.get(key);
      if (!selected || selected.profile !== identity.profile) {
        throw new Error("当前对话还没有目标标签页，请先用 browser open 打开网页。");
      }
      target = selected.targetId;
    }
    if (typeof target === "string") {
      const claimed = this.claims.get(`${identity.profile}\0${target}`);
      if (claimed && claimed !== key) {
        throw new Error("此标签页属于另一个对话，不能交接或操作。");
      }
    }
    return {
      ...params,
      profile: identity.profile,
      target: "host",
      ...(pageAction && typeof target === "string"
        ? {
            targetId: target,
            ...(object(params.request)
              ? { request: { ...object(params.request), targetId: target } }
              : {}),
          }
        : {}),
    };
  }

  async observe(ctx: Context, params: Record<string, unknown>, result: unknown, error?: string) {
    const key = owner(ctx);
    // A failed or unsupported selection must not leave a stale target available.
    if (
      error ||
      object(result)?.isError ||
      params.node ||
      params.target === "node" ||
      params.target === "sandbox"
    ) {
      this.selections.delete(key);
      return;
    }
    const action = params.action;
    if (
      !["open", "focus", "snapshot", "navigate", "act", "screenshot", "close", "stop"].includes(
        String(action),
      )
    ) {
      return;
    }
    const identity = await this.resolve(
      ctx,
      typeof params.profile === "string" ? params.profile : undefined,
    );
    const details = object(object(result)?.details);
    const proof = object(details?.sessionHandoff);
    const target = details?.targetId ?? params.targetId ?? object(params.request)?.targetId;
    if (action === "close" || action === "stop") {
      this.selections.delete(key);
      return;
    }
    if (
      typeof target !== "string" ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(target) ||
      proof?.version !== 1 ||
      typeof proof.marker !== "string" ||
      !/^[a-f0-9-]{36}$/.test(proof.marker)
    ) {
      this.selections.delete(key);
      return;
    }
    const claim = `${identity.profile}\0${target}`;
    if (this.claims.has(claim) && this.claims.get(claim) !== key) {
      this.selections.delete(key);
      throw new Error("标签页已经属于另一个 session。");
    }
    this.claims.set(claim, key);
    this.selections.set(key, {
      ...identity,
      targetId: target,
      marker: proof.marker,
      expires: Date.now() + 600_000,
    });
  }

  async acquire(ctx: Context): Promise<{ handoff: BrowserHandoff; release: () => void }> {
    const key = owner(ctx);
    const selected = this.selections.get(key);
    if (!selected || selected.expires < Date.now()) {
      throw new Error("当前对话没有可交接的浏览器标签页，请先用 browser 打开或查看目标页面。");
    }
    // Re-read the binding so changes cannot silently select another account.
    const current = await this.resolve(ctx, selected.profile);
    if (
      JSON.stringify(current.binding) !== JSON.stringify(selected.binding) ||
      this.busy.has(current.profile)
    ) {
      throw new Error("浏览器绑定已变化或正在使用，请重新确认当前页面。");
    }
    this.busy.add(current.profile);
    this.selections.delete(key);
    let released = false;
    return {
      handoff: {
        version: 1,
        targetId: selected.targetId,
        marker: selected.marker,
        binding: current.binding,
      },
      release: () => {
        if (!released) {
          this.busy.delete(current.profile);
        }
        released = true;
      },
    };
  }
}

const runtime = globalThis as typeof globalThis & {
  __leadingSessionHandoffs?: Map<string, SessionBrowserHandoffs>;
};
const registries = (runtime.__leadingSessionHandoffs ??= new Map<string, SessionBrowserHandoffs>());

export function sessionBrowserHandoffs(api: OpenClawPluginApi) {
  const state = api.runtime.state.resolveStateDir();
  let registry = registries.get(state);
  if (!registry) {
    const profiles = new UserBrowserProfiles(state, api.runtime.config);
    registry = new SessionBrowserHandoffs(async (ctx, requested) => {
      const userId = extractUserId(ctx.agentId)!;
      return profiles.resolve(userId, requested);
    });
    registries.set(state, registry);
  }
  return registry;
}

export function registerComplaintBrowserHandoff(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, ctx) => {
    if (event.toolName !== "browser" || !extractUserId(ctx.agentId)) {
      return undefined;
    }
    try {
      return { params: await sessionBrowserHandoffs(api).before(ctx, event.params) };
    } catch (error) {
      return {
        block: true,
        blockReason: error instanceof Error ? error.message : "浏览器会话校验失败。",
      };
    }
  });
  api.on("after_tool_call", async (event, ctx) => {
    if (event.toolName !== "browser" || !extractUserId(ctx.agentId)) {
      return;
    }
    await sessionBrowserHandoffs(api).observe(ctx, event.params, event.result, event.error);
  });
}
