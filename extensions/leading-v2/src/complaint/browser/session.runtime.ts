import { open, unlink } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute, join } from "node:path";
import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/browser-security-runtime";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { z } from "zod";
import type { BrowserHandoff } from "../complaint-session-handoff.js";
import { ComplaintNeedsOperator } from "../executor/native.js";

const bindingSchema = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(1),
    profileDir: z.string().refine(isAbsolute),
    cdpUrl: z.string(),
    allowRfc2544BenchmarkRange: z.boolean().optional(),
  }),
  z.object({
    version: z.literal(2),
    driver: z.literal("existing-session"),
    profileDir: z.string().refine(isAbsolute),
    allowRfc2544BenchmarkRange: z.boolean().optional(),
  }),
]);
const handoffSchema = z.object({
  version: z.literal(1),
  marker: z.string().uuid(),
  targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  binding: bindingSchema,
});

function validateEndpoint(raw: string, websocket: boolean) {
  const url = new URL(raw);
  if (
    url.protocol !== (websocket ? "ws:" : "http:") ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (websocket ? !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname) : url.pathname !== "/")
  ) {
    throw new Error("Invalid browser endpoint");
  }
  return url;
}

async function discoverEndpoint(binding: z.infer<typeof bindingSchema>): Promise<string> {
  if (binding.version === 2) {
    const file = await open(join(binding.profileDir, "DevToolsActivePort"), "r");
    try {
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) {
        throw new Error("Invalid browser discovery file");
      }
      const lines = buffer.subarray(0, bytesRead).toString("utf8").trim().split(/\r?\n/);
      if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0])) {
        throw new Error("Invalid browser discovery file");
      }
      return validateEndpoint(`ws://127.0.0.1:${lines[0]}${lines[1]}`, true).href;
    } finally {
      await file.close();
    }
  }
  const endpoint = validateEndpoint(binding.cdpUrl, false);
  const version = await new Promise<unknown>((resolve, reject) => {
    const req = request(new URL("/json/version", endpoint), (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Browser unavailable"));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 65536) {
          req.destroy(new Error("Browser response too large"));
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid browser response"));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Browser discovery timeout")), 5000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  const websocket = validateEndpoint(
    z.object({ webSocketDebuggerUrl: z.string() }).parse(version).webSocketDebuggerUrl,
    true,
  );
  if (websocket.hostname !== endpoint.hostname || websocket.port !== endpoint.port) {
    throw new Error("Browser endpoint mismatch");
  }
  return websocket.href;
}

export async function allowBrowserRequest(raw: string, allowFakeIp: boolean) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return false;
    }
    await resolvePinnedHostnameWithPolicy(url.hostname, {
      policy: { allowRfc2544BenchmarkRange: allowFakeIp },
    });
    return true;
  } catch {
    return false;
  }
}

/** Attach only. This module never launches Chrome or creates a replacement tab. */
export async function acquireComplaintPage(
  params: {
    handoff?: BrowserHandoff;
    allowFakeIp: boolean;
  },
  deps = { connect: (endpoint: string) => chromium.connectOverCDP(endpoint, { timeout: 10000 }) },
): Promise<{ page: Page; release: () => Promise<void> }> {
  const parsed = handoffSchema.safeParse(params.handoff);
  if (!parsed.success) {
    throw new ComplaintNeedsOperator(
      "BROWSER_HANDOFF_REQUIRED",
      "缺少当前会话的有效浏览器交接，请先打开并查看目标标签页。",
    );
  }
  const handoff = parsed.data;
  const lockPath = join(handoff.binding.profileDir, ".openclaw-complaint.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let browser: Browser | undefined;
  let page: Page | undefined;
  let routed = false;
  let contextRouted = false;
  let released = false;
  const guard = async (route: Route) => {
    if (
      await allowBrowserRequest(
        route.request().url(),
        params.allowFakeIp || handoff.binding.allowRfc2544BenchmarkRange === true,
      )
    ) {
      await route.fallback();
    } else {
      await route.abort("blockedbyclient");
    }
  };
  // Context interception also covers a popup's first request, which page.route
  // cannot intercept. Unrelated existing tabs retain their original routing.
  const popupGuard = async (route: Route) => {
    let candidate: Page | null;
    try {
      candidate = route.request().frame().page();
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    if (candidate === page) {
      await route.fallback();
      return;
    }
    for (let depth = 0; candidate && depth < 8; depth++) {
      candidate = await candidate.opener();
      if (candidate === page) {
        await guard(route);
        return;
      }
    }
    await route.fallback();
  };
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (page && !page.isClosed()) {
        await page
          .evaluate(
            (marker) =>
              Object.defineProperty(window, "__openclaw_session_handoff_v1", {
                value: marker,
                configurable: true,
              }),
            handoff.marker,
          )
          .catch(() => {});
        if (routed) {
          await page.unroute("**/*", guard).catch(() => {});
        }
      }
    } finally {
      if (contextRouted && page) {
        await page
          .context()
          .unroute("**/*", popupGuard)
          .catch(() => {});
      }
      // Closing a CDP client disconnects this connection, leaving the owned browser alive.
      try {
        await browser?.close();
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    }
  };
  try {
    await lock.writeFile(String(process.pid));
    browser = await deps.connect(await discoverEndpoint(handoff.binding));
    if (browser.contexts().length !== 1) {
      throw new Error("Ambiguous browser context");
    }
    const matches: Page[] = [];
    for (const candidate of browser.contexts()[0].pages()) {
      const marker = await candidate
        .evaluate(() => Reflect.get(window, "__openclaw_session_handoff_v1"))
        .catch(() => undefined);
      if (marker === handoff.marker) {
        matches.push(candidate);
      }
    }
    if (matches.length !== 1) {
      throw new ComplaintNeedsOperator(
        "BROWSER_HANDOFF_REQUIRED",
        "原标签页身份已失效或不唯一，请重新查看页面后交接。",
      );
    }
    page = matches[0];
    const cdp = await page.context().newCDPSession(page);
    try {
      const info = await cdp.send("Target.getTargetInfo");
      if (info.targetInfo.targetId !== handoff.targetId) {
        throw new Error("Browser target mismatch");
      }
    } finally {
      await cdp.detach();
    }
    await page.route("**/*", guard);
    routed = true;
    await page.context().route("**/*", popupGuard);
    contextRouted = true;
    return { page, release };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
