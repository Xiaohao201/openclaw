import { beforeAll, describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qwenPlugin from "./index.js";

describe("Qwen input length errors", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

  beforeAll(async () => {
    provider = await registerSingleProviderPlugin(qwenPlugin);
  });

  it.each([
    "400 Range of input length should be [1, 983616]",
    "400 InvalidParameter: Range of input length should be [1, 991808]",
    '{"error":{"code":"InvalidParameter","message":"Range of input length should be [1, 32768]"}}',
    "range of input length should be [ 1 , 8192 ]",
  ])("recognizes an input length rejection: %s", (errorMessage) => {
    expect(provider.matchesContextOverflowError?.({ errorMessage })).toBe(true);
  });

  it.each([
    "400 InvalidParameter: messages must not be empty",
    "400 InvalidParameter: Invalid tools schema",
    "400 Range of output length should be [1, 8192]",
    "400 Range of input length should be [1, 0]",
    "400 Range of input length should be [1, invalid]",
    "429 Rate limit exceeded",
    "401 Invalid API key",
    "",
  ])("does not treat unrelated validation errors as overflow: %s", (errorMessage) => {
    expect(provider.matchesContextOverflowError?.({ errorMessage })).toBe(false);
  });
});
