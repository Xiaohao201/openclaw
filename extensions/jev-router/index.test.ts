import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { configSchema } from "./src/router.js";

describe("JEV plugin registration", () => {
  afterEach(() => vi.unstubAllEnvs());
  const api = (pluginConfig: Record<string, unknown>) =>
    ({ pluginConfig, on: vi.fn(), logger: { info: vi.fn() } }) as unknown as OpenClawPluginApi;
  it("does not register a hook when disabled or without a candidate pool", () => {
    for (const config of [{}, { enabled: false, candidates: ["read"] }, { enabled: true }]) {
      const host = api(config);
      plugin.register(host);
      expect(host.on).not.toHaveBeenCalled();
    }
  });
  it("registers only the prompt hook when explicitly configured", () => {
    const host = api({ enabled: true, candidates: ["read"] });
    plugin.register(host);
    expect(host.on).toHaveBeenCalledExactlyOnceWith("before_prompt_build", expect.any(Function));
  });
  it("loads its runtime lazily and runs the shadow hook without a key", async () => {
    vi.stubEnv("JEV_OPENROUTER_API_KEY", "");
    const host = api({ enabled: true, candidates: ["read"] });
    plugin.register(host);
    const hook = vi.mocked(host.on).mock.calls[0][1] as (event: {
      prompt: string;
      messages: unknown[];
    }) => Promise<unknown>;
    expect(await hook({ prompt: "hello", messages: [] })).toBeUndefined();
    expect(host.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"missing_key"'),
    );
  });
  it("keeps manifest defaults and runtime defaults aligned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const properties = manifest.configSchema.properties as Record<string, { default: unknown }>;
    expect(
      Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.default])),
    ).toEqual(configSchema.parse({}));
    expect(plugin.configSchema.safeParse?.({ enabled: true, candidates: ["exec"] }).success).toBe(
      false,
    );
  });
});
