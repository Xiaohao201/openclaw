import { afterEach, expect, it, vi } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["gateway", "node"] as const)("rejects managed agent execution on %s", async (host) => {
  vi.stubEnv("OPENCLAW_EXTERNAL_LIFECYCLE", "1");
  const tool = createExecTool({ host, security: "full", ask: "off" });
  await expect(tool.execute("managed-exec", { command: "echo must-not-run" })).rejects.toThrow(
    "isolated sandbox",
  );
});
