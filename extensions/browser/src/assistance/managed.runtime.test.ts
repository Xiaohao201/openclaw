import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  profiles: new Map<string, { running: { pid: number } | null }>(),
  rm: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => ({ default: { rm: mocks.rm } }));
vi.mock("openclaw/plugin-sdk/browser-config-runtime", () => ({
  loadConfig: () => ({ browser: {} }),
}));
vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: () => ({ enabled: true, attachOnly: false, color: "#FF4500" }),
}));
vi.mock("../browser/bridge-server.js", () => ({
  startBrowserBridgeServer: async () => ({
    baseUrl: "http://127.0.0.1:12345",
    server: {},
    state: { profiles: mocks.profiles },
  }),
  stopBrowserBridgeServer: async () => {
    mocks.order.push("drain-requests");
    // A timed-out caller can leave a launch finishing inside an active request.
    mocks.profiles.set("private-profile", { running: { pid: 12345 } });
  },
}));
vi.mock("../browser/chrome.js", () => ({
  resolveOpenClawUserDataDir: (profile: string) => path.join(tmpdir(), profile, "user-data"),
  stopOpenClawChrome: async () => {
    mocks.order.push("stop-browser");
  },
}));
import { createManagedAssistanceBrowser } from "./managed.runtime.js";

it("drains in-flight launches before stopping and removing its private browser", async () => {
  try {
    const browser = await createManagedAssistanceBrowser(() => false);
    await browser.dispose();
    expect(mocks.order).toEqual(["drain-requests", "stop-browser"]);
    expect(mocks.rm).toHaveBeenCalledOnce();
  } finally {
    mocks.order.length = 0;
    mocks.profiles.clear();
    mocks.rm.mockClear();
  }
});
