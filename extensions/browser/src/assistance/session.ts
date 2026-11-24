import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "../core-api.js";
import { AssistanceRequest } from "./state.js";
import type { BrowserAssistanceNotice, BrowserAssistanceSessionOptions } from "./types.js";

type ManagedBrowser = Awaited<
  ReturnType<(typeof import("./managed.runtime.js"))["createManagedAssistanceBrowser"]>
>;
const sessions = new Map<string, AssistanceSession>();
const observedActions = new Set(["open", "navigate", "snapshot", "act", "handoff"]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

class AssistanceSession {
  private browser?: Promise<ManagedBrowser>;
  private current?: AssistanceRequest;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly options: BrowserAssistanceSessionOptions) {}

  async binding() {
    if (this.closed || this.options.signal?.aborted) {
      throw new Error("Browser session ended");
    }
    this.browser ??= import("./managed.runtime.js").then(({ createManagedAssistanceBrowser }) =>
      createManagedAssistanceBrowser(() => this.closed || this.current?.active === true),
    );
    return await this.browser;
  }

  execute(tool: AnyAgentTool, args: Parameters<AnyAgentTool["execute"]>) {
    const run = this.tail.then(() => this.run(tool, args));
    this.tail = run.catch(() => {});
    return run;
  }

  private async run(tool: AnyAgentTool, args: Parameters<AnyAgentTool["execute"]>) {
    const params = record(args[1]);
    if (!params) {
      throw new Error("Invalid browser parameters");
    }
    if (params.node || (params.target && params.target !== "host")) {
      throw new Error(
        "This interactive session uses its isolated local browser; node/sandbox targets are unavailable",
      );
    }
    const binding = await this.binding();
    const action = String(params.action);
    // Browser schema remains identical across turns. Handoff is an explicit manual fallback.
    const forwarded = {
      ...params,
      target: "host",
      profile: binding.profile,
      ...(action === "handoff" ? { action: "snapshot" } : {}),
    };
    const execution = await tool
      .execute(...([args[0], forwarded, ...args.slice(2)] as Parameters<AnyAgentTool["execute"]>))
      .then(
        (result) => ({ ok: true, result }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
    if (this.closed || this.options.signal?.aborted) {
      throw new Error("Browser session ended");
    }
    const originalResult = () => {
      if (!execution.ok) {
        throw execution.error;
      }
      return execution.result;
    };
    if (!observedActions.has(action)) {
      return originalResult();
    }
    const details = execution.ok ? record(execution.result.details) : undefined;
    const targetId = details?.targetId ?? params.targetId ?? record(params.request)?.targetId;
    if (typeof targetId !== "string") {
      return originalResult();
    }
    const { AssistancePage } = await import("./page.runtime.js");
    const page = await AssistancePage.connect(binding.cdpUrl, targetId);
    const reason = action === "handoff" ? "manual" : await page.reason();
    if (!reason) {
      return originalResult();
    }
    const signals = [this.options.signal, args[2]].filter(
      (value): value is AbortSignal => value instanceof AbortSignal,
    );
    const request = new AssistanceRequest({
      timeoutMs: Math.min(300_000, Math.max(10_000, this.options.timeoutMs ?? 180_000)),
      signal: signals.length ? AbortSignal.any(signals) : undefined,
      verify: async () => (await page.reason()) === null,
    });
    this.current = request;
    const tabClosed = () => request.finish("unavailable");
    page.page.on("close", tabClosed);
    const notice: BrowserAssistanceNotice = {
      version: 1,
      requestId: randomUUID(),
      status: "waiting",
      reason,
      origin: new URL(page.page.url()).origin,
      expiresAt: request.expiresAt,
    };
    const emit = async () => this.options.onState({ ...notice, status: request.status });
    try {
      if (!request.active) {
        throw new Error("Browser assistance was cancelled");
      }
      await this.options.onRequest({
        notice,
        startFrames: async (send) => {
          if (request.active) {
            await page.startFrames(send);
          }
        },
        stopFrames: () => page.stopFrames(),
        input: async (value) => {
          if (request.status !== "waiting") {
            throw new Error("Browser is not accepting input");
          }
          await page.input(value);
        },
        complete: async () => {
          const completed = await request.complete();
          await emit();
          return completed;
        },
        cancel: () => request.cancel(),
      });
      const outcome = await request.done;
      await emit();
      if (outcome !== "resumed") {
        throw new Error(
          `Browser assistance ended: ${outcome}. Do not retry the previous action automatically.`,
        );
      }
    } catch (error) {
      request.finish("unavailable");
      await emit().catch(() => {});
      throw error;
    } finally {
      this.current = undefined;
      page.page.off("close", tabClosed);
      await page.stopFrames();
    }
    // Return fresh evidence after the user's actions; never replay the original mutation.
    const result = await tool.execute(
      ...([
        args[0],
        { action: "snapshot", target: "host", profile: binding.profile, targetId },
        ...args.slice(2),
      ] as Parameters<AnyAgentTool["execute"]>),
    );
    const browserAssistance = {
      version: 1,
      requestId: notice.requestId,
      status: "resumed",
      reason,
      trigger: action === "handoff" ? "manual" : "automatic",
      humanAssisted: true,
      originalAction: action,
      snapshotPhase: "after-human-assistance",
    } as const;
    // Details alone are not model-visible. Preserve the fresh page result and
    // tell the model why it now differs from the page that paused this call.
    return {
      ...result,
      content: [
        {
          type: "text" as const,
          text: [
            "Browser assistance completed during this tool call.",
            JSON.stringify({ browserAssistance }),
            "The tool paused for human input and resumed after the user completed assistance. The browser result below is from after assistance, not the page's initial state.",
          ].join("\n"),
        },
        ...result.content,
      ],
      details: { ...record(result.details), browserAssistance },
    };
  }

  async dispose() {
    this.closed = true;
    this.current?.cancel();
    if (this.browser) {
      await (await this.browser).dispose();
    }
  }
}

export function registerBrowserAssistanceSession(
  options: BrowserAssistanceSessionOptions,
): () => Promise<void> {
  if (!options.sessionKey || sessions.has(options.sessionKey)) {
    throw new Error("Browser assistance session already registered");
  }
  const session = new AssistanceSession(options);
  sessions.set(options.sessionKey, session);
  return async () => {
    if (sessions.get(options.sessionKey) === session) {
      sessions.delete(options.sessionKey);
    }
    await session.dispose();
  };
}

export async function resolveAssistanceBinding(sessionKey?: string) {
  return sessionKey ? sessions.get(sessionKey)?.binding() : undefined;
}

export function withBrowserAssistance(tool: AnyAgentTool, sessionKey?: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (...args) => {
      const session = sessionKey ? sessions.get(sessionKey) : undefined;
      if (session) {
        return session.execute(tool, args);
      }
      if (record(args[1])?.action === "handoff") {
        throw new Error("Human browser assistance is not configured for this session");
      }
      return tool.execute(...args);
    },
  };
}
