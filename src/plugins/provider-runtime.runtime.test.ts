import { expect, it, vi } from "vitest";
import { matchesProviderContextOverflowWithPlugin } from "./provider-runtime.runtime.js";

const runtime = vi.hoisted(() => ({
  loaded: vi.fn(),
  matchesProviderContextOverflowWithPlugin: vi.fn(() => true),
}));

vi.mock("./provider-runtime.js", () => {
  runtime.loaded();
  return {
    matchesProviderContextOverflowWithPlugin: runtime.matchesProviderContextOverflowWithPlugin,
  };
});

it("loads provider error hooks lazily and forwards the active provider context", async () => {
  expect(runtime.loaded).not.toHaveBeenCalled();
  const params = {
    provider: "test-provider",
    config: { plugins: { entries: { "test-provider": { enabled: true } } } },
    workspaceDir: "/test/workspace",
    context: { errorMessage: "input length outside allowed range" },
  };

  await expect(matchesProviderContextOverflowWithPlugin(params)).resolves.toBe(true);
  expect(runtime.matchesProviderContextOverflowWithPlugin).toHaveBeenCalledWith(params);
  runtime.matchesProviderContextOverflowWithPlugin.mockReturnValueOnce(false);
  await expect(matchesProviderContextOverflowWithPlugin(params)).resolves.toBe(false);
  expect(runtime.loaded).toHaveBeenCalledTimes(1);
});
