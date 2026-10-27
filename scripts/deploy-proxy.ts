import http, { type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

function forwardedHeaders(req: IncomingMessage, upgrade = false): http.OutgoingHttpHeaders {
  const headers = { ...req.headers };
  for (const header of (req.headers.connection ?? "").split(",")) {
    delete headers[header.trim().toLowerCase()];
  }
  for (const header of [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[header];
  }
  delete headers.forwarded;
  delete headers["x-real-ip"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-port"];
  headers["x-forwarded-for"] = req.socket.remoteAddress;
  headers["x-forwarded-proto"] = "http";
  headers.host = req.headers.host;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

/** Never retries a forwarded request: its execution outcome could be unknown. */
export function createDeployProxy() {
  let target: number | null = null;
  const tunnels = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (target === null) {
      res.writeHead(503, { "Retry-After": "1", "Cache-Control": "no-store" });
      res.end("Gateway deployment in progress. Please retry shortly.");
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req),
        agent: false,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
        reply.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Cache-Control": "no-store" });
      }
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    if (target === null || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n");
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: target,
      method: "GET",
      path: req.url,
      headers: forwardedHeaders(req, true),
      agent: false,
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on("upgrade", (reply, backend, backendHead) => {
      backend.setTimeout(0);
      tunnels.add(backend);
      backend.on("close", () => {
        tunnels.delete(backend);
        socket.destroy();
      });
      backend.on("error", () => socket.destroy());
      socket.on("error", () => backend.destroy());
      socket.on("close", () => backend.destroy());
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (backendHead.length) {
        socket.write(backendHead);
      }
      if (head.length) {
        backend.write(head);
      }
      socket.pipe(backend).pipe(socket);
    });
    upstream.on("response", (reply) => {
      reply.resume();
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  return {
    server,
    route(port: number | null) {
      target = port;
    },
    async close() {
      target = null;
      for (const socket of tunnels) {
        socket.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
