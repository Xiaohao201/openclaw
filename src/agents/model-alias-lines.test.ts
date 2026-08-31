import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelAliasLines } from "./model-alias-lines.js";

describe("buildModelAliasLines", () => {
  it("keeps canonical model refs visible for actionable Suheng aliases", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "qwen/qwen3.6-plus": { alias: "Suheng3.0" },
            "qwen/qwen3.8-flash": { alias: "Suheng3.2mini" },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(buildModelAliasLines(config)).toEqual([
      "- Suheng3.0: qwen/qwen3.6-plus",
      "- Suheng3.2mini: qwen/qwen3.8-flash",
    ]);
  });
});
