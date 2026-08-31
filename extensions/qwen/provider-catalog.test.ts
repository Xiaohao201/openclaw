import { describe, expect, it } from "vitest";
import {
  applyQwenNativeStreamingUsageCompat,
  buildQwenProvider,
  QWEN_BASE_URL,
  QWEN_38_FLASH_MODEL_ID,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
} from "./api.js";

describe("qwen provider catalog", () => {
  it("builds the bundled Qwen provider defaults", () => {
    const provider = buildQwenProvider();

    expect(provider.baseUrl).toBe(QWEN_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models?.length).toBeGreaterThan(0);
    expect(provider.models?.find((model) => model.id === QWEN_DEFAULT_MODEL_ID)).toBeTruthy();
    expect(provider.models?.find((model) => model.id === "qwen3.6-plus")).toBeFalsy();
    expect(provider.models?.find((model) => model.id === QWEN_38_FLASH_MODEL_ID)).toBeFalsy();
  });

  it("only advertises Standard-only models on Standard endpoints", () => {
    const coding = buildQwenProvider({ baseUrl: QWEN_BASE_URL });
    const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });

    expect(coding.models?.find((model) => model.id === "qwen3.6-plus")).toBeFalsy();
    expect(standard.models?.find((model) => model.id === "qwen3.6-plus")).toBeTruthy();
    expect(coding.models?.find((model) => model.id === QWEN_38_FLASH_MODEL_ID)).toBeFalsy();
    expect(standard.models?.find((model) => model.id === QWEN_38_FLASH_MODEL_ID)).toMatchObject({
      name: "Suheng3.2mini",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.12, output: 3.29, cacheRead: 0.224, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
    expect(coding.models?.find((model) => model.id === "MiniMax-M2.5")).toBeUndefined();
    expect(standard.models?.find((model) => model.id === "MiniMax-M2.5")).toBeUndefined();
  });

  it("opts native Qwen baseUrls into streaming usage only inside the extension", () => {
    const nativeProvider = applyQwenNativeStreamingUsageCompat(buildQwenProvider());
    expect(
      nativeProvider.models?.every((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(true);

    const customProvider = applyQwenNativeStreamingUsageCompat({
      ...buildQwenProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      customProvider.models?.some((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(false);
  });
});
