import { describe, expect, it } from "vitest";
import { collectConfiguredDiscoveryProviders } from "./models-config.discovery-scope.js";

describe("configured provider discovery scope", () => {
  it("includes secondary, per-agent, heartbeat, and profile providers in stable order", () => {
    expect(
      collectConfiguredDiscoveryProviders({
        agents: {
          defaults: {
            model: "chat/main",
            imageModel: { primary: "vision/main", fallbacks: ["backup/main"] },
            subagents: { model: "worker/main" },
            heartbeat: { model: "heartbeat/main" },
          },
          list: [{ id: "other", model: "custom/main" }],
        },
        auth: { profiles: { example: { provider: "profile", mode: "api_key" } } },
      }),
    ).toEqual(["backup", "chat", "custom", "heartbeat", "profile", "vision", "worker"]);
  });

  it("resolves aliases through the configured model catalog", () => {
    expect(
      collectConfiguredDiscoveryProviders({
        agents: { defaults: { model: "fast", models: { "custom/main": { alias: "fast" } } } },
      }),
    ).toEqual(["custom"]);
  });

  it("retains broad discovery when provider references cannot be inferred safely", () => {
    expect(collectConfiguredDiscoveryProviders()).toBeUndefined();
    expect(collectConfiguredDiscoveryProviders({})).toBeUndefined();
    expect(
      collectConfiguredDiscoveryProviders({
        agents: { defaults: { model: "unqualified-model" } },
      }),
    ).toBeUndefined();
  });

  it("does not change provider ordering when model catalog insertion order changes", () => {
    for (const refs of [
      ["z/model", "a/model"],
      ["a/model", "z/model"],
    ]) {
      expect(
        collectConfiguredDiscoveryProviders({
          agents: { defaults: { models: Object.fromEntries(refs.map((ref) => [ref, {}])) } },
        }),
      ).toEqual(["a", "z"]);
    }
  });
});
