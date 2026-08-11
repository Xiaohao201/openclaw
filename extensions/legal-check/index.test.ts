import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

describe("legal-check plugin registration", () => {
  it("does not expose legacy system-detection tools to agents", () => {
    const registerTool = vi.fn();
    const registerService = vi.fn();
    const api = {
      pluginConfig: {},
      registerTool,
      registerService,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(registerTool).not.toHaveBeenCalled();
    expect(registerService).toHaveBeenCalledWith(expect.objectContaining({ id: "legal-check" }));
  });
});
