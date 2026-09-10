import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

describe("leading-v2 report skill exposure", () => {
  it("does not expose retired opinion and report tools", () => {
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
    for (const retiredTool of [
      "opinion_analyze",
      "opinion_content_create",
      "opinion_download_content",
      "opinion_download_list",
      "opinion_download_status",
      "opinion_report_export",
      "report_status",
      "report_stop",
      "sheet_report_create",
    ]) {
      expect(registeredToolNames).not.toContain(retiredTool);
    }
    expect(registeredToolNames).toContain("feed_list");
    expect(registeredToolNames).toContain("topic_list");
    expect(registeredToolNames).toContain("letter_generate");
    expect(registeredToolNames).toContain("complaint_submit");
  });
});
