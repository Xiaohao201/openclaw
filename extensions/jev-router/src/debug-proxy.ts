import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decideBusinessRoute } from "./business-decision.js";
import { createDecisionClient } from "./client.js";
import { filterDebugRequest, isSyntheticRequest } from "./debug-filter.js";
import { parseConfig } from "./router.js";

/** Debug-only reverse proxy. Never stores credentials, prompts, or model responses. */
export async function startDebugProxy(options: {
  upstream: string;
  mode: "baseline" | "filter" | "route";
  log: (record: Record<string, unknown>) => void;
  maxRequests?: number;
  fetch?: typeof fetch;
}) {
  const upstream = new URL(options.upstream);
  if (
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error("JEV debug requires an HTTPS provider base URL without embedded credentials");
  }
  if (options.mode !== "baseline" && !process.env.JEV_OPENROUTER_API_KEY?.trim()) {
    throw new Error("JEV_OPENROUTER_API_KEY is required for filter mode");
  }
  const secretPath = `/${randomBytes(24).toString("hex")}/v1`;
  let requests = 0;
  let routeRequests = 0;
  const server = createServer(async (req, res) => {
    const isTurnDecision = options.mode === "route" && req.url === `${secretPath}/turn-decision`;
    if (
      req.method !== "POST" ||
      (req.url !== `${secretPath}/chat/completions` && !isTurnDecision)
    ) {
      res.writeHead(404).end();
      return;
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    res.once("close", () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 2_000_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const original = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = JSON.parse(original);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400).end();
        return;
      }
      const body = parsed as Record<string, unknown>;
      if (isTurnDecision) {
        if (routeRequests >= (options.maxRequests ?? 16)) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              version: 1,
              route: "uncertain",
              confidence: 0,
              reason: "budget_exhausted",
            }),
          );
          return;
        }
        const routeRequest = ++routeRequests;
        const result = await decideBusinessRoute(body, { fetch: options.fetch });
        options.log({ mode: "route", phase: "turn_decision", request: routeRequest, ...result });
        res
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(result));
        return;
      }
      // Only explicit synthetic bench requests can leave this experiment proxy.
      if (!isSyntheticRequest(body) || requests >= (options.maxRequests ?? 16)) {
        res.writeHead(429).end('{"error":"synthetic debug request limit"}');
        return;
      }
      const request = ++requests;
      const result =
        options.mode === "filter"
          ? await filterDebugRequest(body, async (state, candidates) =>
              createDecisionClient(parseConfig({ enabled: true, candidates }), {
                fetch: options.fetch,
              }).decide(state, controller.signal),
            )
          : { body, decision: undefined };
      const payload = result.body === body ? original : JSON.stringify(result.body);
      const record = {
        mode: options.mode,
        request,
        model: body.model,
        beforeTools: Array.isArray(body.tools) ? body.tools.length : 0,
        afterTools: Array.isArray(result.body.tools) ? result.body.tools.length : 0,
        beforeBytes: Buffer.byteLength(original),
        afterBytes: Buffer.byteLength(payload),
        decision: result.decision,
      };
      options.log({ ...record, phase: "dispatch" });
      const response = await (options.fetch ?? fetch)(
        `${upstream.href.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
          body: payload,
        },
      );
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      if (response.body) {
        const reader = response.body.getReader();
        async function* chunks() {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                break;
              }
              yield next.value;
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        await pipeline(Readable.from(chunks()), res);
      } else {
        res.end();
      }
      options.log({
        ...record,
        phase: "complete",
        status: response.status,
        elapsedMs: Date.now() - started,
      });
    } catch {
      options.log({ mode: options.mode, phase: "error", elapsedMs: Date.now() - started });
      if (!res.headersSent) {
        res.writeHead(502).end('{"error":"debug proxy request failed"}');
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(timer);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Debug proxy listener unavailable");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}${secretPath}`,
    turnRouterUrl:
      options.mode === "route"
        ? `http://127.0.0.1:${address.port}${secretPath}/turn-decision`
        : undefined,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
