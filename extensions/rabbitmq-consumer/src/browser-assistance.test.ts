import {
  registerBrowserAssistanceSession,
  type BrowserAssistanceControl,
  type BrowserAssistanceSessionOptions,
} from "openclaw/plugin-sdk/browser-assistance";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("ws", () => ({
  default: class extends EventTarget {
    static OPEN = 1;
    constructor(url: string) {
      super();
      return new WebSocket(url);
    }
  },
}));
vi.mock("openclaw/plugin-sdk/browser-assistance", () => ({
  registerBrowserAssistanceSession: vi.fn(),
}));
import {
  browserAssistanceConfig,
  signBrowserWorkerTicket,
  startBrowserAssistance,
} from "./browser-assistance.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser relay configuration", () => {
  it("is disabled by default and rejects insecure or incomplete configuration", () => {
    expect(browserAssistanceConfig({})).toBeNull();
    for (const url of [
      "ws://example.com/ws",
      "https://example.com/ws",
      "wss://user:secret@example.com/ws",
      "wss://example.com/ws?secret=x",
    ]) {
      expect(() =>
        browserAssistanceConfig({
          LOBSTER_BROWSER_RELAY_URL: url,
          LOBSTER_BROWSER_RELAY_SECRET: "x".repeat(32),
        }),
      ).toThrow();
    }
    expect(() =>
      browserAssistanceConfig({ LOBSTER_BROWSER_RELAY_URL: "wss://example.com/ws" }),
    ).toThrow();
  });
  it("supports TLS and loopback development", () => {
    for (const url of ["wss://example.com/ws", "ws://127.0.0.1/ws"]) {
      expect(
        browserAssistanceConfig({
          LOBSTER_BROWSER_RELAY_URL: url,
          LOBSTER_BROWSER_RELAY_SECRET: "x".repeat(32),
        })?.url,
      ).toBe(url);
    }
  });
  it("binds worker tickets to the exact owner, history row, request and deadline", () => {
    const ticket = signBrowserWorkerTicket(
      "x".repeat(32),
      { sessionKey: "session", userId: "u1", historyId: 12, publish: async () => {} },
      {
        version: 1,
        requestId: "request",
        reason: "manual",
        status: "waiting",
        origin: "https://example.com",
        expiresAt: 123,
      },
    );
    expect(JSON.parse(Buffer.from(ticket.split(".")[0], "base64url").toString())).toMatchObject({
      role: "worker",
      userId: "u1",
      historyId: 12,
      requestId: "request",
      expiresAt: 123,
    });
  });
});

it("routes a live control channel independently, deduplicates input, and disposes on cancellation", async () => {
  class TestSocket extends EventTarget {
    static OPEN = 1;
    static instances: TestSocket[] = [];
    readyState = 1;
    bufferedAmount = 0;
    sent: string[] = [];
    constructor(_url: string) {
      super();
      TestSocket.instances.push(this);
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    receive(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubEnv("LOBSTER_BROWSER_RELAY_URL", "ws://127.0.0.1/relay");
  vi.stubEnv("LOBSTER_BROWSER_RELAY_SECRET", "test-only-secret-".repeat(3));
  let registration!: BrowserAssistanceSessionOptions;
  const cleanup = vi.fn(async () => {});
  vi.mocked(registerBrowserAssistanceSession).mockImplementation((options) => {
    registration = options;
    return cleanup;
  });
  const abort = new AbortController();
  const publish = vi.fn(async () => {});
  const dispose = startBrowserAssistance({
    sessionKey: "one",
    userId: "u1",
    historyId: 1,
    signal: abort.signal,
    publish,
  });
  const control: BrowserAssistanceControl = {
    notice: {
      version: 1,
      requestId: "d9cb18ad-b382-4e88-b1ef-928516494108",
      reason: "manual",
      status: "waiting",
      origin: "https://example.com",
      expiresAt: Date.now() + 60_000,
    },
    startFrames: vi.fn(async () => {}),
    stopFrames: vi.fn(async () => {}),
    input: vi.fn(async () => {}),
    complete: vi.fn(async () => false),
    cancel: vi.fn(),
  };
  try {
    const announced = registration.onRequest(control);
    const socket = TestSocket.instances[0];
    socket.dispatchEvent(new Event("open"));
    socket.receive({ type: "ready" });
    await announced;
    expect(publish).toHaveBeenCalledWith(control.notice);
    socket.receive({ type: "viewer-connected", connectionId: "viewer1" });
    socket.receive({
      type: "input",
      connectionId: "wrong",
      sequence: 1,
      input: { type: "key", key: "Enter" },
    });
    socket.receive({
      type: "input",
      connectionId: "viewer1",
      sequence: 1,
      input: { type: "key", key: "Enter" },
    });
    socket.receive({
      type: "input",
      connectionId: "viewer1",
      sequence: 1,
      input: { type: "key", key: "Enter" },
    });
    await vi.waitFor(() => expect(control.input).toHaveBeenCalledTimes(1));
    socket.receive({ type: "complete", connectionId: "viewer1", sequence: 2 });
    await vi.waitFor(() => expect(control.complete).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(control.cancel).toHaveBeenCalledOnce();
    await registration.onState({ ...control.notice, status: "cancelled" });
    expect(socket.readyState).toBe(3);
  } finally {
    await dispose?.();
  }
  expect(cleanup).toHaveBeenCalledOnce();
});
