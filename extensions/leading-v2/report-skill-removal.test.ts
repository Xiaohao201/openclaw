import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

describe("leading-v2 report skill exposure", () => {
  it("does not expose the retired general report creation tool", () => {
    const registeredToolNames: string[] = [];
    const api = {
      config: {},
      pluginConfig: { backend: { baseUrl: "https://example.test", siteId: "legal" } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool(_tool: unknown, options?: { name?: string }) {
        if (options?.name) {
          registeredToolNames.push(options.name);
        }
      },
      registerService: vi.fn(),
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(registeredToolNames).not.toContain("report_create");
    expect(registeredToolNames).toContain("opinion_content_create");
    expect(registeredToolNames).toContain("report_status");
    expect(registeredToolNames).toContain("report_stop");
  });
});
