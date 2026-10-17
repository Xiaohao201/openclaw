import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { LoginHandoffRequired, LoginSession, type LoginResult } from "./browser/login-session.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { safeErrorFields } from "./complaint-diagnostics.js";
import { localPlatforms, resolveLocalConfig } from "./complaint-local-contract.js";
import { sessionBrowserHandoffs } from "./complaint-session-handoff.js";

const runtime = globalThis as typeof globalThis & {
  __leadingNativeBrowserSetup?: Map<string, LoginSession>;
};
const sessions = (runtime.__leadingNativeBrowserSetup ??= new Map<string, LoginSession>());

function sessionResult(session: LoginSession, result: LoginResult) {
  return {
    ...result,
    ...(result.state === "failed" ? { success: false } : {}),
    browserTargetId: session.targetId,
    instruction: !session.targetId
      ? "请先在当前对话用 browser 打开并查看平台标签页。"
      : session.closed
        ? "原 OpenClaw 浏览器和标签页保持打开。继续操作时先调用 browser snapshot，并传入 browserTargetId 作为 targetId，刷新当前对话页面；旧举报批次不会自动重提。"
        : "正在复用当前对话的 OpenClaw 标签页；登录结束前不要并发操作或关闭该浏览器。",
  };
}

export async function stopComplaintBrowserSessions() {
  await Promise.all([...sessions.values()].map((session) => session.stop()));
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
        const session = sessions.get(directory);
        const ownsSession =
          session &&
          session.params.sessionId === ctx.sessionId &&
          session.params.sessionKey === ctx.sessionKey;
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
                    platform: session.params.platform,
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
          if (!ctx.sessionKey || !ctx.sessionId) {
            return jsonResult({
              success: false,
              errorCode: "BROWSER_HANDOFF_REQUIRED",
              error: "当前对话缺少可信会话身份，请先用 browser 打开页面。",
            });
          }
          const current = new LoginSession({
            platform,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            onError: (error, stage) =>
              api.logger?.warn(
                `[COMPLAINT_LOGIN] ${JSON.stringify({ stage, ...safeErrorFields(error) })}`,
              ),
            connect: async () => {
              let lease;
              try {
                lease = await sessionBrowserHandoffs(api).acquire(ctx);
              } catch {
                throw new LoginHandoffRequired();
              }
              current.targetId = lease.handoff.targetId;
              try {
                const { openComplaintLogin } = await import("./browser/login.runtime.js");
                const connection = await openComplaintLogin({
                  platform,
                  handoff: lease.handoff,
                  allowFakeIp: config.allowFakeIp,
                });
                return {
                  ...connection,
                  release: async () => {
                    try {
                      await connection.release();
                    } finally {
                      lease.release();
                    }
                  },
                };
              } catch (error) {
                lease.release();
                throw error;
              }
            },
          });
          // Reserve before any asynchronous connection work to prevent two login starts.
          sessions.set(directory, current);
          const result = await current.start();
          if (result.errorCode === "BROWSER_HANDOFF_REQUIRED") {
            sessions.delete(directory);
          }
          return jsonResult(sessionResult(current, result));
        }

        if (!session || session.closed || !ownsSession) {
          return jsonResult({
            success: false,
            error: "当前对话没有活跃登录流程，请先用 browser 打开平台页面后发起 login。",
          });
        }
        const current = session;
        const result = await current.command(action);
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
