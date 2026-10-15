import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBrowserConfigForRuntimeRefresh } from "./config-refresh-source.js";

type TestConfig = {
  browser?: {
    profiles?: Record<string, { cdpPort: number; color: string }>;
    evaluateEnabled?: boolean;
    ssrfPolicy?: { dangerouslyAllowPrivateNetwork: boolean };
  };
  gateway?: { auth: { token: string } };
};
const mocks = vi.hoisted(() => ({
  runtime: undefined as TestConfig | undefined,
  disk: {} as TestConfig,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfigSnapshot: () => mocks.runtime,
  createConfigIO: () => ({ loadConfig: () => mocks.disk }),
}));

describe("browser profile config refresh", () => {
  beforeEach(() => {
    mocks.runtime = undefined;
    mocks.disk = {};
  });

  it("observes a newly created profile even when the runtime snapshot predates it", () => {
    mocks.runtime = { browser: { profiles: { openclaw: { cdpPort: 18800, color: "#123456" } } } };
    mocks.disk = {
      browser: {
        profiles: {
          ...mocks.runtime.browser?.profiles,
          isolated: { cdpPort: 18801, color: "#123456" },
        },
      },
    };
    expect(loadBrowserConfigForRuntimeRefresh().browser?.profiles?.isolated?.cdpPort).toBe(18801);
    expect(mocks.runtime.browser?.profiles?.isolated).toBeUndefined();
  });

  it("preserves runtime security gates and resolved credentials while refreshing profiles", () => {
    mocks.runtime = {
      browser: { evaluateEnabled: false, ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
      gateway: { auth: { token: "resolved-fixture-token" } },
    };
    mocks.disk = {
      browser: {
        evaluateEnabled: true,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        profiles: { isolated: { cdpPort: 18801, color: "#123456" } },
      },
      gateway: { auth: { token: "${TEST_FIXTURE_TOKEN}" } },
    };
    const refreshed = loadBrowserConfigForRuntimeRefresh();
    expect(refreshed.browser?.evaluateEnabled).toBe(false);
    expect(refreshed.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(false);
    expect(refreshed.gateway?.auth?.token).toBe("resolved-fixture-token");
    expect(refreshed.browser?.profiles?.isolated).toBeDefined();
  });

  it("honors profile removal and uses disk config when no runtime snapshot exists", () => {
    mocks.runtime = { browser: { profiles: { removed: { cdpPort: 18800, color: "#123456" } } } };
    expect(loadBrowserConfigForRuntimeRefresh().browser?.profiles).toBeUndefined();
    mocks.runtime = undefined;
    expect(loadBrowserConfigForRuntimeRefresh()).toEqual(mocks.disk);
  });
});
