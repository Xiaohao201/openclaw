import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

const planOpenClawModelsJsonMock = vi.fn();

installModelsConfigTestHooks();

let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;

beforeAll(async () => {
  vi.doMock("./models-config.plan.js", () => ({
    planOpenClawModelsJson: (...args: unknown[]) => planOpenClawModelsJsonMock(...args),
  }));
  ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
});

beforeEach(() => {
  planOpenClawModelsJsonMock
    .mockReset()
    .mockImplementation(async (params: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG }) => ({
      action: "write",
      contents: `${JSON.stringify({ providers: params.cfg?.models?.providers ?? {} }, null, 2)}\n`,
    }));
});

describe("models-config write serialization", () => {
  it("reuses discovery after writing models.json and invalidates after external edits", async () => {
    await withModelsTempHome(async () => {
      const cfg = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const first = await ensureOpenClawModelsJson(cfg);
      const before = await fs.readFile(path.join(first.agentDir, "models.json"), "utf8");
      await ensureOpenClawModelsJson(cfg);
      await ensureOpenClawModelsJson(cfg);
      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(first.agentDir, "models.json"), "utf8")).toBe(before);
      const modelsPath = path.join(first.agentDir, "models.json");
      await fs.utimes(modelsPath, new Date(1_000), new Date(1_000));
      await ensureOpenClawModelsJson(cfg);
      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("shares discovery for concurrent calls with identical configuration", async () => {
    await withModelsTempHome(async () => {
      const cfg = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      await Promise.all(Array.from({ length: 4 }, () => ensureOpenClawModelsJson(cfg)));
      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates discovery when the host provider scope changes", async () => {
    await withModelsTempHome(async () => {
      const previous = process.env.OPENCLAW_PROVIDERS;
      try {
        process.env.OPENCLAW_PROVIDERS = "custom-primary";
        await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);
        process.env.OPENCLAW_PROVIDERS = "custom-backup";
        await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);
        expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_PROVIDERS;
        } else {
          process.env.OPENCLAW_PROVIDERS = previous;
        }
      }
    });
  });

  it("serializes concurrent models.json writes to avoid overlap", async () => {
    await withModelsTempHome(async () => {
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const firstModel = first.models?.providers?.["custom-proxy"]?.models?.[0];
      const secondModel = second.models?.providers?.["custom-proxy"]?.models?.[0];
      if (!firstModel || !secondModel) {
        throw new Error("custom-proxy fixture missing expected model entries");
      }
      firstModel.name = "Proxy A";
      secondModel.name = "Proxy B with longer name";

      const originalWriteFile = fs.writeFile.bind(fs);
      let inFlightWrites = 0;
      let maxInFlightWrites = 0;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const targetArg = args[0];
        const targetPath =
          typeof targetArg === "string"
            ? targetArg
            : targetArg instanceof URL
              ? targetArg.pathname
              : undefined;
        const isModelsTempWrite =
          typeof targetPath === "string" &&
          path.basename(targetPath).startsWith("models.json.") &&
          targetPath.endsWith(".tmp");
        if (isModelsTempWrite) {
          inFlightWrites += 1;
          if (inFlightWrites > maxInFlightWrites) {
            maxInFlightWrites = inFlightWrites;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
          return await originalWriteFile(...args);
        } finally {
          if (isModelsTempWrite) {
            inFlightWrites -= 1;
          }
        }
      });

      try {
        await Promise.all([ensureOpenClawModelsJson(first), ensureOpenClawModelsJson(second)]);
      } finally {
        writeSpy.mockRestore();
      }

      expect(maxInFlightWrites).toBe(1);
      const parsed = await readGeneratedModelsJson<{
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      }>();
      expect(["Proxy A", "Proxy B with longer name"]).toContain(
        parsed.providers["custom-proxy"]?.models?.[0]?.name,
      );
    });
  }, 60_000);
});
