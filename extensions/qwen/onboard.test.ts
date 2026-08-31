import { describe, expect, it } from "vitest";
import {
  QWEN_36_PLUS_ALIAS,
  QWEN_36_PLUS_MODEL_ID,
  QWEN_38_FLASH_ALIAS,
  QWEN_38_FLASH_MODEL_ID,
} from "./models.js";
import { applyQwenConfig, applyQwenStandardConfig } from "./onboard.js";

describe("qwen onboarding", () => {
  const modelRef = `qwen/${QWEN_38_FLASH_MODEL_ID}`;

  it("maps Suheng3.0 to qwen3.6-plus on Standard endpoints", () => {
    const config = applyQwenStandardConfig({});

    expect(config.agents?.defaults?.models?.[`qwen/${QWEN_36_PLUS_MODEL_ID}`]?.alias).toBe(
      QWEN_36_PLUS_ALIAS,
    );
  });

  it("adds the Suheng alias for qwen3.8-flash on Standard endpoints", () => {
    const config = applyQwenStandardConfig({});

    expect(config.agents?.defaults?.models?.[modelRef]?.alias).toBe(QWEN_38_FLASH_ALIAS);
    expect(
      config.models?.providers?.qwen?.models?.find((model) => model.id === QWEN_38_FLASH_MODEL_ID),
    ).toBeTruthy();
  });

  it("does not add qwen3.8-flash to Coding Plan configs", () => {
    const config = applyQwenConfig({});

    expect(config.agents?.defaults?.models?.[modelRef]).toBeUndefined();
    expect(
      config.models?.providers?.qwen?.models?.find((model) => model.id === QWEN_38_FLASH_MODEL_ID),
    ).toBeUndefined();
  });

  it("preserves an existing qwen3.8-flash alias", () => {
    const config = applyQwenStandardConfig({
      agents: { defaults: { models: { [modelRef]: { alias: "Custom Flash" } } } },
    });

    expect(config.agents?.defaults?.models?.[modelRef]?.alias).toBe("Custom Flash");
  });
});
