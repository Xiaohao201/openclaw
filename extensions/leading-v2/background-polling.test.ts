import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

const stores = vi.hoisted(() => ({
  pending: {
    init: vi.fn(),
    all: vi.fn(() => []),
    prune: vi.fn(() => 0),
    flush: vi.fn(),
  },
  schedules: {
    init: vi.fn(),
    reload: vi.fn(),
    due: vi.fn(() => []),
    flush: vi.fn(),
  },
}));

vi.mock("./src/notify/pending-store.js", () => ({
  getSharedPendingRegistry: () => stores.pending,
}));
vi.mock("./src/schedule/schedule-store.js", () => ({
  getSharedScheduleStore: () => stores.schedules,
}));

describe("leading-v2 background polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("MERCURE_HUB_URL", "");
    vi.stubEnv("MERCURE_JWT_SECRET", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([undefined, "0", "1"])(
    "controls both background timers without disabling tools (override: %s)",
    async (polling) => {
      vi.stubEnv("OPENCLAW_LEADING_V2_BACKGROUND_POLLING", polling);
      const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
      const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const api = {
        config: {},
        pluginConfig: {
          backend: { baseUrl: "https://example.test", siteId: "legal" },
          notify: { enabled: true },
        },
        logger,
        registerService,
        registerTool,
        on: vi.fn(),
      } as unknown as OpenClawPluginApi;

      plugin.register(api);
      const service = registerService.mock.calls[0][0];
      const ctx = { config: {}, stateDir: "unused-test-state", logger };
      try {
        await service.start(ctx);
        const enabled = polling !== "0";
        expect(vi.getTimerCount()).toBe(enabled ? 2 : 0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stores.schedules.reload).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(stores.pending.prune).toHaveBeenCalledTimes(enabled ? 2 : 0);
        expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
          name: "crawl_refresh_status",
        });
        expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
          name: "schedule_list",
        });
      } finally {
        await service.stop?.(ctx);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
