import { Command } from "commander";
import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../api.js";
const run = vi.hoisted(() => vi.fn());
vi.mock("./preflight.runtime.js", () => ({ phonePreflight: run }));
import { registerPhonePreflight } from "./preflight-cli.js";
it("registers a lazy preflight command and signals failed readiness", async () => {
  const program = new Command();
  const registerCli = vi.fn((register) => register({ program }));
  const api = { registerCli } as unknown as OpenClawPluginApi;
  const original = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    registerPhonePreflight(api);
    run
      .mockResolvedValueOnce({ errorCode: "PHONE_PREFLIGHT_READY" })
      .mockResolvedValueOnce({ errorCode: "PHONE_UNAVAILABLE" });
    const args = [
      "node",
      "openclaw",
      "complaint-phone-preflight",
      "--user-id",
      "owner",
      "--url",
      "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
    ];
    await program.parseAsync(args);
    expect(run).toHaveBeenCalledWith(
      api,
      expect.objectContaining({ userId: "owner", category: "不实信息" }),
    );
    await program.parseAsync(args);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = original;
    log.mockRestore();
  }
});
