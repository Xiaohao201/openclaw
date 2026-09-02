import { readFileSync } from "node:fs";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginLogger, PluginRuntime } from "./api.js";
import rabbitMqConsumerPlugin from "./index.js";

describe("rabbitmq-consumer registration", () => {
  it("declares and registers the video_link_parse tool", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    const registerTool = vi.fn();
    const api = {
      id: "rabbitmq-consumer",
      name: "RabbitMQ Consumer",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as PluginRuntime,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as PluginLogger,
      registerTool,
      registerHttpRoute: vi.fn(),
      registerService: vi.fn(),
    } as unknown as OpenClawPluginApi;

    rabbitMqConsumerPlugin.register(api);

    expect(manifest.contracts?.tools).toContain("video_link_parse");
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "video_link_parse",
    });
  });

  it("registers the local page while hard-disabling remote services", async () => {
    let service: OpenClawPluginService | undefined;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const api = {
      id: "rabbitmq-consumer",
      name: "RabbitMQ Consumer",
      source: "test",
      config: {},
      pluginConfig: { localDebug: { enabled: true } },
      runtime: {} as PluginRuntime,
      logger,
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: vi.fn((next: OpenClawPluginService) => {
        service = next;
      }),
    } as unknown as OpenClawPluginApi;

    rabbitMqConsumerPlugin.register(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "collaboration_history_query",
      optional: true,
    });

    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/rabbitmq-consumer/debug",
        auth: "plugin",
        match: "exact",
      }),
    );
    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/rabbitmq-consumer/debug/run",
        auth: "plugin",
        match: "exact",
      }),
    );
    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/rabbitmq-consumer/debug/skills",
        auth: "plugin",
        match: "exact",
      }),
    );
    expect(service).toBeDefined();

    await service?.start({ logger } as OpenClawPluginServiceContext);

    expect(logger.info).toHaveBeenCalledWith(
      "[RABBITMQ_LOCAL_DEBUG] Using existing data connections with history isolated to history_test and RabbitMQ queue set to MessageTest",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
