import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveLocalConfig } from "../complaint-local-contract.js";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  screenshot: vi.fn(),
  cleanupPreflight: vi.fn(),
  submit: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock("./bridge.js", () => ({
  PhoneBridge: class {
    start = mocks.start;
    close = mocks.close;
  },
}));
vi.mock("./device.js", () => ({
  NativePhone: class {
    constructor(...args: unknown[]) {
      mocks.constructor(...args);
    }
    screenshot = mocks.screenshot;
    cleanupPreflight = mocks.cleanupPreflight;
  },
}));
vi.mock("./submit.js", () => ({ submitPhone: mocks.submit }));
import { runPhoneComplaint } from "./runtime.js";
const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.submit.mockResolvedValue({ state: "done", message: "receipt", offline: null });
  mocks.screenshot.mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "phone-runtime-"));
  roots.push(root);
  return {
    config: resolveLocalConfig({
      complaintExecution: {
        mode: "local",
        phone: { adbPath: "adb", serial: randomUUID(), userId: "fixture" },
      },
    }),
    sessionDir: join(root, createHash("sha256").update("fixture").digest("hex")),
    signal: new AbortController().signal,
    resolveLink: vi.fn(),
    item: {
      platform: "xiaohongshu",
      link: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
      category: "不实信息",
      reason: "fixture",
      role: "Personal" as const,
    },
  };
}
it("checks owner binding before device access", async () => {
  const p = await fixture();
  expect((await runPhoneComplaint({ ...p, sessionDir: "other" })).errorCode).toBe(
    "PHONE_OWNER_MISMATCH",
  );
  expect(
    (await runPhoneComplaint({ ...p, config: { ...p.config, phone: undefined } })).errorCode,
  ).toBe("PHONE_NOT_CONFIGURED");
  expect(mocks.start).not.toHaveBeenCalled();
});
it("preserves receipts when capture or cleanup fails and releases device ownership", async () => {
  const p = await fixture();
  mocks.close.mockRejectedValue(new Error("cleanup"));
  const result = await runPhoneComplaint(p);
  expect(result.state).toBe("done");
  expect(await readFile(join(p.sessionDir, "screenshots", result.screenshot!.fileName))).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  mocks.screenshot.mockResolvedValue(Buffer.from("invalid"));
  expect(await runPhoneComplaint(p)).toMatchObject({
    state: "done",
    evidenceError: "SCREENSHOT_CAPTURE_FAILED",
  });
  mocks.start.mockRejectedValueOnce(new Error("device offline"));
  expect((await runPhoneComplaint(p)).errorCode).toBe("PHONE_UNAVAILABLE");
});
it("excludes concurrent owners until the first device flow finishes", async () => {
  const p = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.start.mockImplementationOnce(() => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const running = runPhoneComplaint(p);
  await started;
  expect((await runPhoneComplaint(p)).errorCode).toBe("PHONE_BUSY");
  release();
  await running;
  expect((await runPhoneComplaint(p)).state).toBe("done");
});
it("preflight disables submission, captures evidence and reports incomplete cleanup", async () => {
  const p = await fixture();
  mocks.submit.mockImplementation(async () => ({
    state: "not_submitted",
    errorCode: "PHONE_PREFLIGHT_READY",
    offline: null,
  }));
  expect((await runPhoneComplaint({ ...p, preflight: true })).errorCode).toBe(
    "PHONE_PREFLIGHT_READY",
  );
  expect(mocks.constructor).toHaveBeenLastCalledWith(expect.anything(), p.resolveLink, false);
  expect(mocks.cleanupPreflight).toHaveBeenCalledWith("fixture");
  mocks.cleanupPreflight.mockRejectedValueOnce(new Error("text remains"));
  expect((await runPhoneComplaint({ ...p, preflight: true })).errorCode).toBe(
    "PHONE_PREFLIGHT_CLEANUP_REQUIRED",
  );
});
