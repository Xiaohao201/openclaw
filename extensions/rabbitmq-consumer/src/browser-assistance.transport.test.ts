import { once } from "node:events";
import { createServer } from "node:http";
import type { BrowserAssistanceSessionOptions } from "openclaw/plugin-sdk/browser-assistance";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
const mocks = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("openclaw/plugin-sdk/browser-assistance", () => ({
  registerBrowserAssistanceSession: mocks.register,
}));
import { startBrowserAssistance } from "./browser-assistance.js";

it("connects the worker after the agent replaces the global undici dispatcher", async () => {
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({ bodyTimeout: 1_800_000, headersTimeout: 1_800_000 });
  setGlobalDispatcher(dispatcher);
  // Node's bundled WebSocket and the gateway's newer undici dispatcher can be incompatible.
  vi.stubGlobal("WebSocket", function UnavailableNativeWebSocket() {
    throw new Error("Native WebSocket is unavailable under this dispatcher");
  });
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.once("message", () => socket.send('{"type":"ready"}')),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test port");
  }
  vi.stubEnv("LOBSTER_BROWSER_RELAY_URL", `ws://127.0.0.1:${address.port}`);
  vi.stubEnv("LOBSTER_BROWSER_RELAY_SECRET", "test-only-browser-relay-secret-32-characters");
  let options!: BrowserAssistanceSessionOptions;
  mocks.register.mockImplementation((value: BrowserAssistanceSessionOptions) => {
    options = value;
    return async () => {};
  });
  const publish = vi.fn(async () => {});
  const dispose = startBrowserAssistance({
    sessionKey: "dispatcher-test",
    userId: "test-user",
    historyId: 1,
    publish,
  });
  const notice = {
    version: 1 as const,
    requestId: "d9cb18ad-b382-4e88-b1ef-928516494108",
    reason: "challenge" as const,
    status: "waiting" as const,
    origin: "https://example.com",
    expiresAt: Date.now() + 60_000,
  };
  try {
    await options.onRequest({
      notice,
      startFrames: async () => {},
      stopFrames: async () => {},
      input: async () => {},
      complete: async () => true,
      cancel: () => {},
    });
    expect(publish).toHaveBeenCalledWith(notice);
  } finally {
    await dispose?.();
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setGlobalDispatcher(previous);
    await dispatcher.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.register.mockReset();
  }
}, 15_000);
