import { createHash } from "node:crypto";
import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "openclaw/plugin-sdk/config-runtime";
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
export const groupAdmin = createGroupAdmin(
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
