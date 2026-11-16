import { readFileSync } from "node:fs";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginLogger, PluginRuntime } from "./api.js";
import rabbitMqConsumerPlugin from "./index.js";

describe("rabbitmq-consumer registration", () => {
  it("blocks detached agent work only in RabbitMQ interactive sessions", async () => {
    const on = vi.fn();
    rabbitMqConsumerPlugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerService: vi.fn(),
      on,
    } as unknown as OpenClawPluginApi);
    const hook = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1] as
      | ((
          event: { toolName: string; params: Record<string, unknown> },
          ctx: { sessionKey?: string; toolName: string },
        ) => unknown)
      | undefined;
    expect(hook).toBeTypeOf("function");
    for (const sessionKey of [
      "agent:rabbitmq-2415:rabbitmq:2415:session_a",
      "agent:rabbitmq-2415:rabbitmq:2415:session_b",
    ]) {
      for (const toolName of ["sessions_spawn", "sessions_yield", "sessions_send"]) {
        expect(await hook?.({ toolName, params: {} }, { sessionKey, toolName })).toEqual(
          expect.objectContaining({ block: true }),
        );
      }
      expect(
        await hook?.(
          { toolName: "subagents", params: { action: "steer" } },
          { sessionKey, toolName: "subagents" },
        ),
      ).toEqual(expect.objectContaining({ block: true }));
      for (const action of ["list", "kill"]) {
        expect(
          await hook?.(
            { toolName: "subagents", params: { action } },
            { sessionKey, toolName: "subagents" },
          ),
        ).toBeUndefined();
      }
      for (const toolName of ["full_text_search", "file_share", "link_batch_create", "exec"]) {
        expect(await hook?.({ toolName, params: {} }, { sessionKey, toolName })).toBeUndefined();
      }
    }
    for (const sessionKey of [
      undefined,
      "agent:main:main",
      "agent:rabbitmq-2415:subagent:child",
      "agent:rabbitmq-2415:rabbitmq-warmup:2415",
    ]) {
      expect(
        await hook?.(
          { toolName: "sessions_spawn", params: {} },
          { sessionKey, toolName: "sessions_spawn" },
        ),
      ).toBeUndefined();
    }
  });
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
      on: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: vi.fn(),
    } as unknown as OpenClawPluginApi;

    rabbitMqConsumerPlugin.register(api);

    expect(manifest.contracts?.tools).toContain("video_link_parse");
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "video_link_parse",
    });
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
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
      on: vi.fn(),
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

    for (const path of ["/", "/chat"]) {
      expect(api.registerHttpRoute).toHaveBeenCalledWith(
        expect.objectContaining({ path, auth: "plugin", match: "exact" }),
      );
    }

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
