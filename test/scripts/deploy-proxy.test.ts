import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createDeployProxy } from "../../scripts/deploy-proxy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close();
  }
});
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No port");
  }
  return address.port;
}
describe("stable deployment ingress", () => {
  it("does not replay a forwarded request after the backend loses the response", async () => {
    let requests = 0;
    const backend = http.createServer((req) => {
      requests += 1;
      req.socket.destroy();
    });
    const port = await listen(backend);
    cleanups.push(async () => {
      await new Promise<void>((r) => backend.close(() => r()));
    });
    const proxy = createDeployProxy();
    const front = await listen(proxy.server);
    cleanups.push(() => proxy.close());
    proxy.route(port);
    expect(
      (await fetch(`http://127.0.0.1:${front}`, { method: "POST", body: "once" })).status,
    ).toBe(502);
    expect(requests).toBe(1);
  });

  it("rejects new upgrades during handoff and handles a backend refusing upgrade", async () => {
    const backend = http.createServer((_req, res) => res.end("not a websocket"));
    const port = await listen(backend);
    cleanups.push(async () => {
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
    });
    const proxy = createDeployProxy();
    const front = await listen(proxy.server);
    cleanups.push(() => proxy.close());
    const upgrade = () =>
      new Promise<number | undefined>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: front,
            headers: { connection: "Upgrade", upgrade: "websocket" },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        req.on("error", reject);
      });
    expect(await upgrade()).toBe(503);
    proxy.route(port);
    expect(await upgrade()).toBe(502);
  });
  it("keeps its port across switches, preserves Host and overwrites spoofed forwarding headers", async () => {
    const backend = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
    const port = await listen(backend);
    cleanups.push(async () => {
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
    });
    const proxy = createDeployProxy();
    const front = await listen(proxy.server);
    cleanups.push(() => proxy.close());
    expect((await fetch(`http://127.0.0.1:${front}`)).status).toBe(503);
    proxy.route(port);
    const reply = await fetch(`http://127.0.0.1:${front}/hello`, {
      headers: { "x-forwarded-for": "evil", forwarded: "evil", "x-real-ip": "evil" },
    });
    const headers = (await reply.json()) as Record<string, string>;
    expect(headers.host).toBe(`127.0.0.1:${front}`);
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(headers.forwarded).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
    proxy.route(null);
    expect((await fetch(`http://127.0.0.1:${front}`)).status).toBe(503);
    proxy.route(port);
    expect((await fetch(`http://127.0.0.1:${front}`)).status).toBe(200);
  });
  it("tunnels WebSocket frames and retains accepted connections while draining", async () => {
    const backend = http.createServer();
    const wss = new WebSocketServer({ server: backend });
    wss.on("connection", (ws) => ws.on("message", (message) => ws.send(message)));
    const port = await listen(backend);
    cleanups.push(async () => {
      wss.close();
      await new Promise<void>((r) => backend.close(() => r()));
    });
    const proxy = createDeployProxy();
    const front = await listen(proxy.server);
    cleanups.push(() => proxy.close());
    proxy.route(port);
    const ws = new WebSocket(`ws://127.0.0.1:${front}`);
    await once(ws, "open");
    proxy.route(null);
    const message = once(ws, "message");
    ws.send("accepted-run-result");
    expect(String((await message)[0])).toBe("accepted-run-result");
    const closed = once(ws, "close");
    ws.close();
    await closed;
  });
});
