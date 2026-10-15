import { describe, expect, it } from "vitest";
import {
  buildRabbitMqDebugLaunchSpec,
  planRabbitMqDebugBuilds,
} from "../../scripts/dev/rabbitmq-local-debug-config.js";

describe("planRabbitMqDebugBuilds", () => {
  it("builds both artifacts on a clean checkout", () => {
    expect(planRabbitMqDebugBuilds({ hasGatewayEntry: false, hasControlUiIndex: false })).toEqual([
      "gateway",
      "control-ui",
    ]);
  });

  it("builds only the missing artifact", () => {
    expect(planRabbitMqDebugBuilds({ hasGatewayEntry: true, hasControlUiIndex: false })).toEqual([
      "control-ui",
    ]);
  });

  it("starts immediately when both artifacts exist", () => {
    expect(planRabbitMqDebugBuilds({ hasGatewayEntry: true, hasControlUiIndex: true })).toEqual([]);
  });
});

describe("buildRabbitMqDebugLaunchSpec", () => {
  it.each([undefined, "0", "1"])(
    "defaults leading-v2 polling off while preserving an explicit override (%s)",
    (polling) => {
      const env = { OPENCLAW_LEADING_V2_BACKGROUND_POLLING: polling };
      const launch = buildRabbitMqDebugLaunchSpec({
        entryPath: "C:\\repo\\dist\\entry.js",
        configPath: "C:\\temp\\openclaw.json",
        stateDir: "C:\\Users\\tester\\.openclaw-dev",
        env,
      });

      expect(launch.env.OPENCLAW_LEADING_V2_BACKGROUND_POLLING).toBe(polling ?? "0");
      expect(env.OPENCLAW_LEADING_V2_BACKGROUND_POLLING).toBe(polling);
    },
  );

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
