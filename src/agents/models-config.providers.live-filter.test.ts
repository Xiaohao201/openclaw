import { describe, expect, it } from "vitest";
import { resolveProviderDiscoveryFilterForTest } from "./models-config.providers.implicit.js";

describe("resolveProviderDiscoveryFilterForTest", () => {
  it("limits managed discovery to configured providers and model fallbacks", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: { OPENCLAW_MANAGED_DEPLOYMENT: "1", VITEST: "1" },
        config: {
          agents: {
            defaults: {
              model: { primary: "custom-primary/chat", fallbacks: ["custom-backup/chat"] },
            },
          },
          models: {
            providers: { "custom-extra": { baseUrl: "https://example.invalid/v1", models: [] } },
          },
        },
      }),
    ).toEqual(["custom-backup", "custom-extra", "custom-primary"]);
  });

  it("keeps unmanaged discovery and the explicit all override unrestricted", () => {
    const config = { agents: { defaults: { model: "custom-primary/chat" } } };
    for (const env of [{}, { OPENCLAW_MANAGED_DEPLOYMENT: "1", OPENCLAW_PROVIDERS: "all" }]) {
      expect(resolveProviderDiscoveryFilterForTest({ config, env })).toBeUndefined();
    }
  });

  it("keeps an explicit provider allowlist authoritative in managed deployments", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_MANAGED_DEPLOYMENT: "1",
          OPENCLAW_PROVIDERS: "custom-selected",
          VITEST: "1",
        },
        config: { agents: { defaults: { model: "custom-primary/chat" } } },
      }),
    ).toEqual(["custom-selected"]);
  });

  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["openrouter"]);
  });
});
