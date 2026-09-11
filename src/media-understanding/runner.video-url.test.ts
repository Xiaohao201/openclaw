import { expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { runProviderEntry } from "./runner.entries.js";
import { withVideoFixture } from "./runner.test-utils.js";

// This test supplies its own registry; loading installed plugins is unrelated.
vi.mock("./provider-registry.js", () => ({
  getMediaUnderstandingProvider: (id: string, registry: Map<string, unknown>) => registry.get(id),
  normalizeMediaProviderId: (id: string) => id,
}));

vi.mock("../agents/model-auth.js", () => ({
  requireApiKey: (auth: { apiKey: string }) => auth.apiKey,
  resolveApiKeyForProvider: async () => ({ apiKey: "test-key", source: "test", mode: "api-key" }),
}));
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));
vi.mock("./image-runtime.js", () => ({ describeImageWithModel: vi.fn() }));

it.each(["success", "private-url", "oversized", "inline-oversized"])(
  "handles URL video input: %s",
  async (scenario) => {
    const publicHost = vi.spyOn(ssrf, "assertPublicHostname").mockImplementation(async () => {
      if (scenario === "private-url") {
        throw new Error("blocked hostname");
      }
    });
    try {
      await withTempDir({ prefix: "video-url-agent-" }, async (agentDir) => {
        await withVideoFixture("video-url", async ({ ctx, media, cache }) => {
          const url = "https://cdn.example.com/large.mp4";
          media[0].url = scenario === "inline-oversized" ? undefined : url;
          const getBuffer = vi
            .spyOn(cache, "getBuffer")
            .mockRejectedValue(new Error("must not buffer large video"));
          const describeVideoUrl = vi.fn(async () => ({ text: "url result" }));
          const pending = runProviderEntry({
            capability: "video",
            cfg: {
              models: {
                providers: {
                  example: { baseUrl: "https://api.example.com", apiKey: "test-key", models: [] },
                },
              },
            },
            config: {
              enabled: true,
              maxBytes: scenario === "oversized" ? 1 : 2 * 1024 ** 3,
              models: [{ provider: "example", model: "video-model" }],
            },
            ctx,
            agentDir,
            cache,
            attachmentIndex: 0,
            entry: { provider: "example", model: "video-model" },
            providerRegistry: new Map([
              [
                "example",
                {
                  id: "example",
                  capabilities: ["video"],
                  describeVideo: async () => {
                    throw new Error("must use URL");
                  },
                  describeVideoUrl,
                },
              ],
            ]),
          });
          if (scenario === "success") {
            expect((await pending)?.text).toBe("url result");
            expect(describeVideoUrl).toHaveBeenCalledWith(expect.objectContaining({ url }));
          } else {
            await expect(pending).rejects.toThrow(
              scenario === "private-url"
                ? "blocked hostname"
                : scenario === "inline-oversized"
                  ? "must not buffer large video"
                  : "exceeds maxBytes",
            );
            expect(describeVideoUrl).not.toHaveBeenCalled();
          }
          if (scenario === "inline-oversized") {
            expect(getBuffer.mock.calls[0]?.[0].maxBytes).toBeLessThan(70 * 1024 ** 2);
            expect(publicHost).not.toHaveBeenCalled();
          } else {
            expect(getBuffer).not.toHaveBeenCalled();
            expect(publicHost).toHaveBeenCalledWith("cdn.example.com");
          }
        });
      });
    } finally {
      publicHost.mockRestore();
    }
  },
);
