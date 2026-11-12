import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import amqp from "amqplib";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { createBridgeWorker, pendingReportSchema } from "./bridge.js";
import { groupAdmin } from "./group-store.runtime.js";

const exchange = "wechat-group-admin.wakeup.v1";

export async function startGroupBridge(ctx: OpenClawPluginServiceContext) {
  const base = process.env.WECHAT_GROUP_BRIDGE_URL;
  if (!base) {
    return async () => {};
  }
  const url = new URL(base);
  const nodeId = process.env.WECHAT_GROUP_BRIDGE_NODE_ID;
  const token = process.env.WECHAT_GROUP_BRIDGE_TOKEN;
  if (
    (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !nodeId ||
    !/^[a-z0-9_-]{1,64}$/.test(nodeId) ||
    !token ||
    token.length < 32
  ) {
    throw new Error(
      "Invalid WeChat group bridge settings; use HTTPS, a node ID and a strong node token",
    );
  }
  const folder = path.join(
    ctx.stateDir,
    "wechat-group-bridge",
    createHash("sha256").update(`${url.origin}/${nodeId}`).digest("hex"),
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const journalFile = path.join(folder, "pending.json");
  let stopped = false;
  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
  let connecting = false;
  let active: Promise<void> | undefined;
  const worker = createBridgeWorker({
    admin: groupAdmin,
    journal: {
      async read() {
        try {
          const value: unknown = JSON.parse(await readFile(journalFile, "utf8"));
          return value === null ? null : pendingReportSchema.parse(value);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      },
      async write(value) {
        await writeFile(`${journalFile}.tmp`, JSON.stringify(value), { mode: 0o600, flush: true });
        await rename(`${journalFile}.tmp`, journalFile);
      },
    },
    async api(action, body) {
      const response = await fetch(new URL(`/wechat-group-node/${action}`, url), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body as Record<string, unknown>), nodeId }),
      });
      if (!response.ok) {
        throw new Error(`Group bridge returned HTTP ${response.status}`);
      }
      const value: unknown = await response.json();
      if (
        action === "complete" &&
        (!value || typeof value !== "object" || !("accepted" in value) || value.accepted !== true)
      ) {
        throw new Error("Group bridge did not acknowledge the report");
      }
      return value;
    },
  });
  const tick = () => {
    if (stopped || active) {
      return;
    }
    active = withFileLock(
      journalFile,
      {
        retries: { retries: 0, factor: 1, minTimeout: 100, maxTimeout: 100 },
        stale: 300_000,
      },
      () => worker.tick(),
    )
      .catch(() => {
        ctx.logger.warn("WeChat group bridge sync failed; pending results are retained for retry");
      })
      .finally(() => {
        active = undefined;
      });
  };
  async function connect() {
    const mq = process.env.WECHAT_GROUP_BRIDGE_AMQP_URL;
    if (stopped || connection || connecting || !mq) {
      return;
    }
    connecting = true;
    try {
      const conn = await amqp.connect(mq, { timeout: 5000 });
      conn.on("error", () => {});
      conn.on("close", () => {
        if (connection === conn) {
          connection = undefined;
        }
      });
      if (stopped) {
        await conn.close();
        return;
      }
      connection = conn;
      const channel = await conn.createChannel();
      channel.on("error", () => {});
      channel.on("close", () => {
        void conn.close().catch(() => {});
      });
      await channel.assertExchange(exchange, "fanout", { durable: true });
      const queue = `${exchange}.${nodeId}`;
      await channel.assertQueue(queue, {
        durable: true,
        arguments: { "x-message-ttl": 60000, "x-max-length": 1 },
      });
      await channel.bindQueue(queue, exchange, "");
      await channel.consume(queue, (message) => {
        if (message) {
          channel.ack(message);
          tick();
        }
      });
      tick();
    } catch {
      const conn = connection;
      connection = undefined;
      await conn?.close().catch(() => {});
      ctx.logger.warn("WeChat group bridge MQ unavailable; HTTP reconciliation remains active");
    } finally {
      connecting = false;
    }
  }
  const timer = setInterval(() => {
    tick();
    void connect();
  }, 10_000);
  timer.unref();
  tick();
  void connect();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await connection?.close().catch(() => {});
    await active;
  };
}
