import type { IncomingMessage, ServerResponse } from "node:http";
import { getCurrentGatewayOperatorScopes } from "openclaw/plugin-sdk/gateway-runtime";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { GroupAdminError } from "./admin.js";
import { groupAdmin } from "./group-store.runtime.js";
export async function handleGroupAdmin(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  try {
    // Gateway authentication alone does not grant scoped proxy clients admin rights.
    if (!getCurrentGatewayOperatorScopes().includes("operator.admin")) {
      throw new GroupAdminError(403, "ADMIN_REQUIRED", "需要 Gateway 管理员权限");
    }
    if (req.method === "GET") {
      res.end(JSON.stringify(await groupAdmin.read()));
    } else if (req.method === "POST") {
      const body = await readJsonBodyWithLimit(req, { maxBytes: 64 * 1024, timeoutMs: 5000 });
      if (!body.ok) {
        throw new GroupAdminError(400, "INVALID_BODY", "请求内容无效或过大");
      }
      res.end(JSON.stringify(await groupAdmin.mutate(body.value)));
    } else {
      res.setHeader("Allow", "GET, POST");
      throw new GroupAdminError(405, "METHOD_NOT_ALLOWED", "不支持此操作");
    }
  } catch (error) {
    const known = error instanceof GroupAdminError;
    res.statusCode = known ? error.status : 500;
    res.end(
      JSON.stringify({
        code: known ? error.code : "CONFIG_FAILED",
        message: known ? error.message : "配置操作失败，请刷新确认当前状态后重试",
        ...(known && error.chatId ? { chatId: error.chatId } : {}),
      }),
    );
  }
}
