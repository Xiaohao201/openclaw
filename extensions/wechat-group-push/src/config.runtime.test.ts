import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCurrentConfig, resolveCurrentConfig } from "./config.runtime.js";

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({ readConfigFileSnapshotForWrite: vi.fn() }));
afterEach(() => vi.resetAllMocks());
describe("current group config", () => {
  it.each([
    {},
    { plugins: { enabled: false } },
    { plugins: { entries: { "wechat-group-push": { enabled: false, config: {} } } } },
  ])("rejects absent or disabled configuration", (config) => {
    expect(() => resolveCurrentConfig(config)).toThrow();
  });
  it.each([
    { exists: false, valid: true },
    { exists: true, valid: false },
  ])("rejects missing or invalid snapshots", async (snapshot) => {
    vi.mocked(readConfigFileSnapshotForWrite).mockResolvedValue({ snapshot } as Awaited<
      ReturnType<typeof readConfigFileSnapshotForWrite>
    >);
    await expect(readCurrentConfig()).rejects.toThrow(/missing or invalid/);
  });
  it("reads a fresh snapshot on each send", async () => {
    const snapshot = (groups: Record<string, string>) =>
      ({
        writeOptions: {},
        snapshot: {
          exists: true,
          valid: true,
          config: { plugins: { entries: { "wechat-group-push": { config: { groups } } } } },
        },
      }) as unknown as Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>;
    vi.mocked(readConfigFileSnapshotForWrite)
      .mockResolvedValueOnce(snapshot({ Alpha: "a" }))
      .mockResolvedValueOnce(snapshot({ Beta: "b" }));
    expect(await readCurrentConfig()).toEqual({ groups: { Alpha: "a" } });
    expect(await readCurrentConfig()).toEqual({ groups: { Beta: "b" } });
  });
});
