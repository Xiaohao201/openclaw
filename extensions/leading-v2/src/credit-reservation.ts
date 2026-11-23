// 同步到三个 OpenClaw 插件的本地模块，遵守插件间禁止深层导入的边界。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Payload = {
  action: "begin" | "settle";
  userId: string;
  runKey: string;
  ownerToken: string;
  costCny?: number;
};
type CreditConfig = { endpoint: string; secret: string; outbox: string; fetch: typeof fetch };
type Logger = { warn: (message: string) => void };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function creditRuntimeConfig(): CreditConfig | null {
  if (process.env.LOBSTER_CREDIT_EXPIRY_ENABLED !== "true") return null;
  const endpoint = process.env.LOBSTER_CREDIT_SERVICE_URL || "";
  const secret = process.env.LOBSTER_CREDIT_SERVICE_SECRET || "";
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Credit endpoint must use HTTPS or loopback HTTP");
  if (Buffer.byteLength(secret) < 32) throw new Error("Credit service secret is missing");
  return {
    endpoint,
    secret,
    outbox:
      process.env.LOBSTER_CREDIT_OUTBOX_DIR || path.join(homedir(), ".openclaw", "credit-outbox"),
    fetch,
  };
}

async function request(config: CreditConfig, payload: Payload): Promise<{ budgetPoints?: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await config.fetch(config.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json", "x-lobster-credit-service": config.secret },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { budgetPoints?: number; data?: { code?: string } };
      if (!response.ok) {
        const error = Object.assign(new Error(`Credit service HTTP ${response.status}`), {
          status: response.status,
          code: body.data?.code,
        });
        throw error;
      }
      return body;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (attempt >= 2 || (status && status < 500)) throw error;
      await wait(200 * (attempt + 1));
    }
  }
}

/** 只重放带最终费用的终态事件；未知状态的执行预占不能靠超时自动释放。 */
export async function flushCreditOutbox(config: CreditConfig, logger: Logger) {
  await mkdir(config.outbox, { recursive: true, mode: 0o700 });
  const files = (await readdir(config.outbox))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .slice(0, 100);
  for (const file of files) {
    const target = path.join(config.outbox, file);
    try {
      const payload = JSON.parse(await readFile(target, "utf8")) as Payload;
      if (
        payload.action !== "settle" ||
        typeof payload.costCny !== "number" ||
        !Number.isFinite(payload.costCny) ||
        payload.costCny < 0
      )
        throw new Error("Invalid settlement outbox");
      await request(config, payload);
      await unlink(target).catch(() => {});
      await unlink(
        path.join(config.outbox, `${file.slice(0, -5)}-${payload.ownerToken}.active.json`),
      ).catch(() => {});
    } catch {
      logger.warn("[CREDITS] Settlement retained for retry");
    }
  }
}

export async function openCreditRun(
  userId: string,
  runKey: string,
  logger: Logger,
  signal?: AbortSignal,
  supplied?: CreditConfig,
) {
  const config = supplied ?? creditRuntimeConfig();
  if (!config) return null;
  signal?.throwIfAborted();
  await flushCreditOutbox(config, logger);
  const payload: Payload = { action: "begin", userId, runKey, ownerToken: randomUUID() };
  const name = createHash("sha256").update(`${userId}:${runKey}`).digest("hex");
  const activeFile = path.join(config.outbox, `${name}-${payload.ownerToken}.active.json`);
  await writeFile(activeFile, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 15 * 60 * 1000;
  let result: { budgetPoints?: number };
  while (true) {
    signal?.throwIfAborted();
    try {
      result = await request(config, payload);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "CREDITS_BUSY" || Date.now() >= deadline) {
        const status = (error as { status?: number }).status;
        if (status && status < 500) await unlink(activeFile).catch(() => {});
        throw error;
      }
      await wait(1000);
    }
  }
  if (!Number.isFinite(result.budgetPoints) || Number(result.budgetPoints) <= 0)
    throw new Error("Invalid credit budget");
  const budgetPoints = Number(result.budgetPoints);
  let timer: ReturnType<typeof setInterval> | undefined;
  let monitoring = false;
  let stopped = false;
  return {
    budgetPoints,
    retain() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    monitor(readCost: () => Promise<number>, stop: () => unknown) {
      timer = setInterval(() => {
        if (monitoring || stopped) return;
        monitoring = true;
        void (async () => {
          try {
            const cost = await readCost();
            if (!Number.isFinite(cost) || cost * 40 >= budgetPoints) await stop();
          } catch {
            await stop();
          } finally {
            monitoring = false;
          }
        })().catch(() => {
          logger.warn("[CREDITS] Unable to stop run; reservation retained");
        });
      }, 2000);
      timer.unref?.();
    },
    async settle(readCost: () => Promise<number>) {
      stopped = true;
      if (timer) clearInterval(timer);
      // 读不到实际费用时保留预占，避免把未知费用错误结算为零。
      const costCny = await readCost();
      if (!Number.isFinite(costCny) || costCny < 0)
        throw new Error("Final usage unavailable; credit reservation retained");
      const settlement: Payload = { ...payload, action: "settle", costCny };
      const target = path.join(config.outbox, `${name}.json`);
      const temporary = path.join(config.outbox, `${name}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(settlement), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
      await request(config, settlement);
      await unlink(target).catch(() => {});
      await unlink(activeFile).catch(() => {});
    },
  };
}
