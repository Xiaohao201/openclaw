import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { localPlatforms, resolveLocalConfig } from "./complaint-local-contract.js";
import { complaintProcessEnv } from "./complaint-local-process.js";
import { sessionBrowserHandoffs } from "./complaint-session-handoff.js";

const resultSchema = z
  .object({
    state: z.enum(["awaiting_login", "saved", "cancelled", "expired", "busy", "failed"]),
    message: z.string().max(2000),
    screenshot: z.string().max(4_000_000).optional(),
  })
  .strict();
type BrowserResult = z.infer<typeof resultSchema>;
type Session = {
  child: ChildProcessWithoutNullStreams;
  platform: string;
  latest: BrowserResult;
  pending?: (result: BrowserResult) => void;
  closed: boolean;
  received: boolean;
  sessionKey: string;
  sessionId: string;
  browserTargetId: string;
};
const runtime = globalThis as typeof globalThis & { __leadingBrowserSetup?: Map<string, Session> };
const sessions = (runtime.__leadingBrowserSetup ??= new Map<string, Session>());
const failure: BrowserResult = {
  state: "failed",
  message: "登录进程中断或返回无效结果，未执行举报。请重新检查会话。",
};

function sessionResult(session: Session, result: BrowserResult) {
  return {
    ...result,
    browserTargetId: session.browserTargetId,
    instruction: session.closed
      ? "原 OpenClaw 浏览器和标签页保持打开。继续操作时先调用 browser snapshot，并传入 browserTargetId 作为 targetId，刷新当前对话页面；旧举报批次不会自动重提。"
      : "正在复用当前对话的 OpenClaw 标签页；登录结束前不要并发操作或关闭该浏览器。",
  };
}

function waitForResponse(session: Session, send: () => void): Promise<BrowserResult> {
  if (session.pending) {
    return Promise.resolve({ state: "busy", message: "此用户的登录操作正在处理，请稍后查询。" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ state: "busy", message: "浏览器仍在响应，请稍后查询状态；不要重复开启登录。" });
    }, 45000);
    session.pending = (result) => {
      clearTimeout(timer);
      session.pending = undefined;
      resolve(result);
    };
    send();
  });
}

function deliver(session: Session, result: BrowserResult) {
  // Do not retain screenshots of login pages in process-global status history.
  session.latest = { state: result.state, message: result.message };
  session.received = true;
  // Terminal results are delivered after the worker releases the user's execution lock.
  if (result.state === "awaiting_login") {
    session.pending?.(result);
  }
}

export async function stopComplaintBrowserSessions() {
  await Promise.all(
    [...sessions.values()]
      .filter((s) => !s.closed)
      .map(
        (session) =>
          new Promise<void>((resolve) => {
            session.child.once("close", () => resolve());
            session.child.stdin.end(JSON.stringify({ action: "cancel" }) + "\n");
            const timer = setTimeout(() => session.child.kill(), 45000);
            session.child.once("close", () => clearTimeout(timer));
          }),
      ),
  );
  sessions.clear();
}

export function createComplaintBrowserToolFactory(api: OpenClawPluginApi) {
  return (ctx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_browser",
      label: "举报账号登录与会话",
      description:
        "复用当前对话的 OpenClaw 浏览器及标签页管理举报账号登录。先用 browser open 打开平台页面或 snapshot 查看当前页，再 login；不会另开独立浏览器。status 查询配置；login 需用户明确授权并传 confirmed=true；screenshot 查看登录页以扫码；finish 仅在用户明确说已完成登录后确认；cancel 结束登录流程。finish/cancel 保留原浏览器和标签页，登录态留在同一 profile，取消不会撤销登录变化。结束后用返回的 browserTargetId 调用 browser snapshot。不会提交举报或重提旧批次。不得指定其他用户ID、任意资料目录或自行绑定机器上其他账号。扫码/验证码需本人完成；确认保存不保证平台登录验证或举报成功。",
      parameters: Type.Object(
        {
          action: Type.Union(
            ["status", "login", "screenshot", "finish", "cancel"].map((v) => Type.Literal(v)),
          ),
          platform: Type.Optional(Type.String()),
          confirmed: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, raw: Record<string, unknown>) {
        const parsed = z
          .object({
            action: z.enum(["status", "login", "screenshot", "finish", "cancel"]),
            platform: z.string().optional(),
            confirmed: z.boolean().optional(),
          })
          .strict()
          .safeParse(raw);
        if (!parsed.success) {
          return jsonResult({ success: false, error: "无效会话参数。" });
        }
        const { action, platform, confirmed } = parsed.data;
        const config = resolveLocalConfig(api.pluginConfig ?? {}, api.rootDir, api.config);
        if (config.mode !== "local") {
          return jsonResult({ success: false, error: "当前使用后端举报模式，不管理本机浏览器。" });
        }
        const directory = new ComplaintBatchStore(() =>
          api.runtime.state.resolveStateDir(),
        ).sessionDirectory(userId);
        let session = sessions.get(directory);
        const ownsSession =
          session && session.sessionId === ctx.sessionId && session.sessionKey === ctx.sessionKey;
        if (action === "status") {
          let binding: "unprepared" | "bound" | "invalid" = "unprepared";
          let bindingAllowsFakeIp = false;
          try {
            const value: unknown = JSON.parse(
              await readFile(join(directory, "browser-binding.json"), "utf8"),
            );
            binding = value && typeof value === "object" ? "bound" : "invalid";
            bindingAllowsFakeIp = Boolean(
              value &&
              typeof value === "object" &&
              "allowRfc2544BenchmarkRange" in value &&
              value.allowRfc2544BenchmarkRange === true,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              binding = "invalid";
            }
          }
          return jsonResult({
            success: true,
            userId,
            binding,
            allowFakeIp: config.allowFakeIp || bindingAllowsFakeIp,
            session:
              session && ownsSession
                ? {
                    platform: session.platform,
                    active: !session.closed,
                    ...sessionResult(session, session.latest),
                  }
                : null,
            instruction:
              "先用当前对话的 browser open 打开平台页面，再调用 login 并指定平台。登录和举报复用 OpenClaw 同一浏览器，不启动独立浏览器；已有登录态可直接使用。",
          });
        }
        if ((action === "login" || action === "finish") && confirmed !== true) {
          return jsonResult({
            success: false,
            error: "请先取得用户对在当前 OpenClaw 标签页登录或确认登录会话的明确授权。",
          });
        }
        if (action === "login") {
          if (!platform || !Object.hasOwn(localPlatforms, platform)) {
            return jsonResult({
              success: false,
              error: "请选择受支持的直接举报平台；12377无需账号登录。",
            });
          }
          if (session && !session.closed) {
            return jsonResult({
              success: false,
              state: "busy",
              error: "当前用户已有登录流程，请在原对话中查询、完成或取消。",
            });
          }
          let lease;
          try {
            lease = await sessionBrowserHandoffs(api).acquire(ctx);
          } catch (error) {
            return jsonResult({
              success: false,
              errorCode: "BROWSER_HANDOFF_REQUIRED",
              error: error instanceof Error ? error.message : "当前 OpenClaw 浏览器无法交接。",
              instruction:
                "请先用当前对话的 browser open 打开平台页面，再调用 login；不另开浏览器或切换举报渠道。",
            });
          }
          let child: ChildProcessWithoutNullStreams;
          try {
            child = spawn(config.python, ["-u", join(config.runtimeDir, "browser_setup.py")], {
              cwd: config.runtimeDir,
              windowsHide: true,
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              env: complaintProcessEnv(config),
            });
          } catch {
            lease.release();
            return jsonResult(failure);
          }
          session = {
            child,
            platform,
            closed: false,
            received: false,
            // acquire validates both fields against the trusted conversation identity.
            sessionKey: ctx.sessionKey!,
            sessionId: ctx.sessionId!,
            browserTargetId: lease.handoff.targetId,
            latest: { state: "busy", message: "正在连接当前对话的 OpenClaw 浏览器标签页。" },
          };
          sessions.set(directory, session);
          const current = session;
          let buffer = "";
          child.stderr.resume();
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 4_100_000) {
              deliver(current, failure);
              child.stdin.end();
              return;
            }
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try {
                deliver(current, resultSchema.parse(JSON.parse(line)));
              } catch {
                deliver(current, failure);
                child.stdin.end();
              }
            }
          });
          child.stdin.on("error", () => deliver(current, failure));
          child.on("error", () => deliver(current, failure));
          child.on("close", () => {
            current.closed = true;
            lease.release();
            if (!current.received || current.latest.state === "awaiting_login") {
              deliver(current, failure);
            }
            current.pending?.(current.latest);
          });
          return jsonResult(
            sessionResult(
              current,
              await waitForResponse(current, () =>
                child.stdin.write(
                  JSON.stringify({
                    platform,
                    sessionDir: directory,
                    browserHandoff: lease.handoff,
                  }) + "\n",
                ),
              ),
            ),
          );
        }
        if (!session || session.closed || !ownsSession) {
          return jsonResult({
            success: false,
            error: "当前对话没有活跃登录流程，请先用 browser 打开平台页面后发起 login。",
          });
        }
        const current = session;
        const result = await waitForResponse(current, () =>
          current.child.stdin.write(JSON.stringify({ action }) + "\n"),
        );
        const { screenshot, ...details } = sessionResult(current, result);
        const response = jsonResult(details);
        if (screenshot) {
          response.content.push({ type: "image", mimeType: "image/jpeg", data: screenshot });
        }
        return response;
      },
    };
  };
}
