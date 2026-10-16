import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalConfig } from "./complaint-local-contract.js";
import { runLocalComplaint } from "./complaint-local-process.js";

const diagnosticInfo = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: () => ({ info: diagnosticInfo, warn: vi.fn() }),
}));
let root: string;
beforeEach(async () => {
  diagnosticInfo.mockClear();
  root = await mkdtemp(join(tmpdir(), "complaint-process-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const params = () => ({
  item: {
    link: "https://weibo.com/1",
    platform: "weibo",
    reason: "测试",
    category: "测试",
    role: "Personal" as const,
  },
  sessionDir: root,
  config: resolveLocalConfig({ complaintExecution: { runtimeDir: root, timeoutMs: 1000 } }),
  signal: new AbortController().signal,
});
describe("Python process failures", () => {
  it("forwards only structured executor metadata with batch correlation", async () => {
    await writeFile(
      join(root, "runner.py"),
      [
        "import json, sys",
        "print('raw private secret', file=sys.stderr)",
        "print('OPENCLAW_DIAGNOSTIC ' + json.dumps(dict(stage='navigate', errorType='TimeoutError', message='private')), file=sys.stderr)",
        "print(json.dumps(dict(state='failed', message='fixture', offline=None)))",
      ].join("\n"),
    );
    await runLocalComplaint({
      ...params(),
      diagnosticContext: { batchId: "fixture-batch", taskId: 42 },
    });
    const logged = JSON.stringify(diagnosticInfo.mock.calls);
    expect(logged).toContain("navigate");
    expect(logged).toContain("fixture-batch");
    expect(logged).not.toContain("private");
  });
  it("accepts receipt metadata but rejects arbitrary screenshot paths from Python", async () => {
    const result = {
      state: "done",
      message: "fixture",
      offline: null,
      screenshot: { fileName: "a".repeat(32) + ".png", capturedAt: "2026-10-16T00:00:00+00:00" },
    };
    const script = (value: unknown) =>
      "import json; print(" + JSON.stringify(JSON.stringify(value)) + ")";
    await writeFile(join(root, "runner.py"), script(result));
    expect(await runLocalComplaint(params())).toMatchObject(result);
    result.screenshot.fileName = "../private.png";
    await writeFile(join(root, "runner.py"), script(result));
    await expect(runLocalComplaint(params())).rejects.toThrow();
  });
  it("passes the administrator phone binding through the child protocol", async () => {
    await writeFile(
      join(root, "runner.py"),
      [
        "import json, sys",
        "data = json.load(sys.stdin)",
        "assert data['phone'] == dict(adbPath='adb', serial='test-device', userId='test-user')",
        "print(json.dumps(dict(state='manual_required', message='phone fixture', offline=None)))",
      ].join("\n"),
    );
    const input = params();
    input.config.phone = { adbPath: "adb", serial: "test-device", userId: "test-user" };
    expect(await runLocalComplaint(input)).toMatchObject({ state: "manual_required" });
  });
  it("distinguishes a missing executable from uncertain execution", async () => {
    await writeFile(join(root, "runner.py"), "print('{}')");
    const input = params();
    input.config.python = join(root, "missing-python-executable");
    expect(await runLocalComplaint(input)).toMatchObject({
      state: "failed",
      errorCode: "RUNTIME_MISSING",
    });
  });
  it("does not spawn when the bundled runtime is absent", async () => {
    expect(await runLocalComplaint(params())).toMatchObject({
      state: "failed",
      errorCode: "RUNTIME_MISSING",
    });
  });
  it.each([
    "print('not json')",
    "raise SystemExit(2)",
    "print('x' * 70000)",
    "import json; print(json.dumps(dict(state='running', message='', offline=None)))",
    "import time; time.sleep(10)",
  ])("rejects invalid, partial or timed-out results: %s", async (script) => {
    await writeFile(join(root, "runner.py"), script);
    await expect(runLocalComplaint(params())).rejects.toThrow();
  });
  it("aborts on service shutdown", async () => {
    await writeFile(join(root, "runner.py"), "import time; time.sleep(10)");
    const controller = new AbortController();
    const running = runLocalComplaint({ ...params(), signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow();
  });
});
