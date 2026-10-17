import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { safeErrorFields } from "../complaint-diagnostics.js";
import type { LocalComplaintItem, LocalConfig, LocalOutcome } from "../complaint-local-contract.js";
import { PhoneBridge } from "./bridge.js";
import { NativePhone } from "./device.js";
import { submitPhone } from "./submit.js";

export async function runPhoneComplaint(params: {
  item: LocalComplaintItem;
  config: LocalConfig;
  sessionDir: string;
  signal: AbortSignal;
  resolveLink: (value: string) => Promise<string>;
  preflight?: boolean;
  log?: (event: Record<string, unknown>) => void;
}): Promise<LocalOutcome> {
  const config = params.config.phone;
  const manual = (errorCode: string): LocalOutcome => ({
    state: "manual_required",
    message: "请检查当前用户的举报手机绑定、设备授权及运行条件，未提交。",
    errorCode,
    offline: null,
  });
  if (!config) {
    return manual("PHONE_NOT_CONFIGURED");
  }
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (basename(params.sessionDir) !== hash(config.userId)) {
    return manual("PHONE_OWNER_MISMATCH");
  }
  const lockPath = join(tmpdir(), `openclaw-phone-${hash(config.serial)}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    return manual("PHONE_BUSY");
  }
  const bridge = new PhoneBridge({
    adbPath: config.adbPath,
    serial: config.serial,
    jarPath: join(params.config.assetsDir, "uiautomator", "u2.jar"),
    signal: params.signal,
    timeoutMs: params.config.timeoutMs,
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await bridge.start();
    const phone = new NativePhone(bridge, params.resolveLink, !params.preflight);
    const outcome = await submitPhone(phone, params.item, params.preflight, params.log);
    if (
      ["done", "unknown"].includes(outcome.state) ||
      (params.preflight && outcome.errorCode === "PHONE_PREFLIGHT_READY")
    ) {
      try {
        const bytes = await phone.screenshot();
        if (
          bytes.length > 10 * 1024 * 1024 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new Error("Invalid screenshot");
        }
        const directory = join(params.sessionDir, "screenshots");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const fileName = randomUUID().replaceAll("-", "") + ".png";
        await writeFile(join(directory, fileName), bytes, { flag: "wx", mode: 0o600 });
        outcome.screenshot = { fileName, capturedAt: new Date().toISOString() };
      } catch {
        outcome.evidenceError = "SCREENSHOT_CAPTURE_FAILED";
      }
    }
    if (params.preflight) {
      try {
        await phone.cleanupPreflight(params.item.reason);
      } catch {
        outcome.errorCode = "PHONE_PREFLIGHT_CLEANUP_REQUIRED";
        outcome.message = "未提交举报；测试说明或页面返回未确认清理，请本人检查手机。";
      }
    }
    return outcome;
  } catch (error) {
    params.log?.({ stage: "phone_bridge", ...safeErrorFields(error) });
    return manual("PHONE_UNAVAILABLE");
  } finally {
    try {
      await bridge.close();
    } catch {
      /* Cleanup cannot erase a submission receipt. */
    }
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
