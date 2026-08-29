import { describe, expect, it } from "vitest";
import { buildRabbitMqDebugLaunchSpec } from "../../scripts/dev/rabbitmq-local-debug-config.js";

describe("buildRabbitMqDebugLaunchSpec", () => {
  it("starts plugin services while keeping external messaging channels disabled", () => {
    const launch = buildRabbitMqDebugLaunchSpec({
      entryPath: "C:\\repo\\dist\\entry.js",
      configPath: "C:\\temp\\openclaw.json",
      stateDir: "C:\\Users\\tester\\.openclaw-dev",
      env: {
        OPENCLAW_SKIP_PLUGIN_SERVICES: "1",
      },
    });

    expect(launch.env.OPENCLAW_SKIP_PLUGIN_SERVICES).toBeUndefined();
    expect(launch.env.OPENCLAW_SKIP_CHANNELS).toBe("1");
  });
});
