import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "openclaw/plugin-sdk/config-runtime";
import { getCurrentGatewayOperatorScopes } from "openclaw/plugin-sdk/gateway-runtime";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { createGroupAdmin, GroupAdminError } from "./admin.js";
import { resolveCurrentConfig } from "./config.runtime.js";
import { configSchema } from "./send.js";
import { createWecomClient } from "./wecom.js";

async function readSnapshot() {
  const result = await readConfigFileSnapshotForWrite();
  if (!result.snapshot.exists || !result.snapshot.valid) {
    throw new GroupAdminError(503, "INVALID_CONFIG", "OpenClaw 配置不存在或校验失败");
  }
  const config = configSchema.parse(resolveCurrentConfig(result.snapshot.config));
  // Include unrelated config changes so this endpoint never intentionally overwrites them.
  const version = createHash("sha256")
    .update(JSON.stringify([result.snapshot.raw, result.snapshot.sourceConfig]))
    .digest("hex");
  return { ...result, groups: config.groups, version };
}
const admin = createGroupAdmin(
  {
    async read() {
      const { groups, version } = await readSnapshot();
      return { groups, version };
    },
    async save(groups, version) {
      const current = await readSnapshot();
      if (current.version !== version) {
        throw new GroupAdminError(409, "CONFLICT", "配置已更新，请刷新后重试");
      }
      const next = structuredClone(current.snapshot.sourceConfig);
      const entry = next.plugins?.entries?.["wechat-group-push"];
      if (!entry?.config) {
        throw new GroupAdminError(503, "INVALID_CONFIG", "群推送配置不存在");
      }
      const path = ["plugins", "entries", "wechat-group-push", "config"];
      const unsetPaths = Object.keys(current.groups)
        .filter((name) => !Object.hasOwn(groups, name))
        .map((name) => [...path, "groups", name]);
      delete entry.config.chatId;
      delete entry.config.groupName;
      entry.config.groups = groups;
      configSchema.parse(entry.config);
      await writeConfigFile(next, {
        ...current.writeOptions,
        unsetPaths: [...unsetPaths, [...path, "chatId"], [...path, "groupName"]],
      });
    },
  },
  createWecomClient(() => ({
    corpId: process.env.WECOM_CORP_ID,
    secret: process.env.WECOM_APP_SECRET,
  })),
);

export async function handleGroupAdmin(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  try {
    // Gateway authentication alone does not grant scoped proxy clients admin rights.
    if (!getCurrentGatewayOperatorScopes().includes("operator.admin")) {
      throw new GroupAdminError(403, "ADMIN_REQUIRED", "需要 Gateway 管理员权限");
    }
    if (req.method === "GET") {
      res.end(JSON.stringify(await admin.read()));
    } else if (req.method === "POST") {
      const body = await readJsonBodyWithLimit(req, { maxBytes: 64 * 1024, timeoutMs: 5000 });
      if (!body.ok) {
        throw new GroupAdminError(400, "INVALID_BODY", "请求内容无效或过大");
      }
      res.end(JSON.stringify(await admin.mutate(body.value)));
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
