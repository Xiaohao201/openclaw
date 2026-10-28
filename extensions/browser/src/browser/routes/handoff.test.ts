import type { Server } from "node:http";
import express from "express";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import {
  browserServiceWork,
  createBrowserControlHandoff,
  markBrowserControlInitialized,
} from "../service-handoff.js";
import { createBrowserRouteDispatcher } from "./dispatcher.js";
import { registerBrowserRoutes } from "./index.js";
import type { BrowserRouteRegistrar } from "./types.js";

const mocks = vi.hoisted(() => ({ operation: vi.fn(async () => {}) }));
vi.mock("./agent.js", () => ({ registerBrowserAgentRoutes: () => {} }));
vi.mock("./tabs.js", () => ({ registerBrowserTabRoutes: () => {} }));
vi.mock("./basic.js", () => ({
  registerBrowserBasicRoutes: (app: BrowserRouteRegistrar) => {
    app.post("/action", async (_req, res) => {
      await mocks.operation();
      res.json({ ok: true });
    });
  },
}));

describe("browser route handoff admission", () => {
  let server: Server | undefined;
  const ctx = {
    config: {},
    stateDir: "test",
    logger: console,
    handoffVersion: 2 as const,
    lifecycleMode: "externally-managed" as const,
  };
  afterEach(async () => {
    browserServiceWork.resume();
    mocks.operation.mockReset().mockResolvedValue(undefined);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });
  it("gates both real HTTP and in-process dispatch while standing by", async () => {
    const handoff = createBrowserControlHandoff(ctx);
    const app = express();
    registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, {} as BrowserRouteContext);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No test port");
    }
    const url = `http://127.0.0.1:${address.port}/action`;
    expect((await fetch(url, { method: "POST" })).status).toBe(503);
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);
    expect((await dispatcher.dispatch({ method: "POST", path: "/action" })).status).toBe(503);
    expect(mocks.operation).not.toHaveBeenCalled();
    markBrowserControlInitialized();
    await handoff.resume(ctx);
    expect((await fetch(url, { method: "POST" })).status).toBe(200);
    expect((await dispatcher.dispatch({ method: "POST", path: "/action" })).status).toBe(200);
    await handoff.pause(ctx, 100);
    expect((await fetch(url, { method: "POST" })).status).toBe(503);
  });
  it("counts the handler until it settles after a caller aborts", async () => {
    const handoff = createBrowserControlHandoff(ctx);
    markBrowserControlInitialized();
    await handoff.resume(ctx);
    const finished = createDeferred<void>();
    mocks.operation.mockReturnValueOnce(finished.promise);
    const abort = new AbortController();
    const request = createBrowserRouteDispatcher({} as BrowserRouteContext).dispatch({
      method: "POST",
      path: "/action",
      signal: abort.signal,
    });
    abort.abort();
    await expect(handoff.pause(ctx, 5)).rejects.toThrow("active");
    finished.resolve(undefined);
    await request;
    await handoff.pause(ctx, 100);
  });
});
