import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePlaywrightBrowserConnection } from "../browser/pw-session.js";
import { AssistancePage } from "./page.runtime.js";
import type { BrowserAssistanceFrame } from "./types.js";

const enabled = process.env.OPENCLAW_BROWSER_ASSISTANCE_E2E === "1";
const fixture = `<!doctype html><html><head><title>Security Verification</title>
<style>body{margin:0;height:2400px;font:18px sans-serif}input,button,#drag{position:absolute;left:80px;width:260px;height:44px}input{top:100px}button{top:170px}#drag{top:250px;background:#ddd;touch-action:none}#challenge-stage{position:absolute;left:80px;top:40px}#result{position:absolute;left:400px;top:170px}</style>
</head><body><div id="challenge-stage">Complete this local test verification</div>
<input id="answer" aria-label="Verification text"><button id="verify">Complete verification</button>
<div id="drag">Drag this local test control</div><output id="result"></output>
<script>
document.querySelector('#verify').onclick=()=>{document.querySelector('#challenge-stage').remove();document.title='Verified';document.querySelector('#result').textContent='completed'};
let start=null;document.querySelector('#drag').onpointerdown=e=>{start=e.clientX};document.onpointerup=e=>{if(start!==null){document.body.dataset.dragDistance=String(e.clientX-start);start=null}};
</script></body></html>`;

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing TCP address");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe.runIf(enabled)("browser assistance with a real local Chromium page", () => {
  let server: Server;
  let browser: Browser;
  let browserProcess: ChildProcess;
  let profile: string;
  let context: BrowserContext;
  let page: Page;
  let assistance: AssistancePage;
  let cdpUrl: string;
  let origin: string;
  let targetId: string;
  const frames: BrowserAssistanceFrame[] = [];

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "fixture_session=preserve-this-session; SameSite=Lax; Path=/",
      });
      response.end(fixture);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture address");
    }
    origin = `http://127.0.0.1:${address.port}`;
    const executablePath =
      process.env.OPENCLAW_BROWSER_TEST_EXECUTABLE ??
      [
        chromium.executablePath(),
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ].find((candidate) => existsSync(candidate));
    if (!executablePath) {
      throw new Error("Set OPENCLAW_BROWSER_TEST_EXECUTABLE to a Chromium executable");
    }
    const cdpPort = await freePort();
    cdpUrl = `http://127.0.0.1:${cdpPort}`;
    profile = await mkdtemp(path.join(tmpdir(), "openclaw-assistance-e2e-"));
    // Match the managed browser's port transport, without Playwright's extra pipe.
    browserProcess = spawn(
      executablePath,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${cdpPort}`,
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    await vi.waitFor(
      async () => {
        const response = await fetch(`${cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        expect(response.ok).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    browser = await chromium.connectOverCDP(cdpUrl);
    const connectedContext = browser.contexts()[0];
    if (!connectedContext) {
      throw new Error("Missing browser context after CDP connection");
    }
    context = connectedContext;
    page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto(origin);
    const cdp = await context.newCDPSession(page);
    const info = await cdp.send("Target.getTargetInfo");
    targetId = info.targetInfo.targetId;
    await cdp.detach();
    assistance = await AssistancePage.connect(cdpUrl, targetId);
  }, 30_000);

  beforeEach(async () => {
    await assistance.stopFrames();
    frames.length = 0;
    await page.goto(origin);
    assistance = await AssistancePage.connect(cdpUrl, targetId);
    await assistance.startFrames((frame) => frames.push(frame));
  });

  afterAll(async () => {
    await assistance?.stopFrames();
    if (cdpUrl) {
      await closePlaywrightBrowserConnection({ cdpUrl });
    }
    await context?.close();
    await browser?.close();
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill();
      await new Promise<void>((resolve) => browserProcess.once("exit", () => resolve()));
    }
    if (profile) {
      const resolved = path.resolve(profile);
      if (
        !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
        !path.basename(resolved).startsWith("openclaw-assistance-e2e-")
      ) {
        throw new Error("Unexpected test profile cleanup path");
      }
      await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function click(x: number, y: number) {
    await assistance.input({ type: "pointer", action: "down", x, y, button: "left", buttons: 1 });
    await assistance.input({ type: "pointer", action: "up", x, y, button: "left", buttons: 0 });
  }

  it("streams the same page, preserves cookies and maps a downscaled image back to viewport coordinates", async () => {
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    const frame = frames.at(-1)!;
    expect(frame.width).toBe(1800);
    expect(frame.height).toBe(1000);
    expect(frame.origin).toBe(origin);
    expect(Buffer.from(frame.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const encodedDimensions = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      return { width: image.width, height: image.height };
    }, frame.data);
    expect(encodedDimensions.width).toBeLessThanOrEqual(1600);
    expect(encodedDimensions.height / encodedDimensions.width).toBeCloseTo(1000 / 1800, 2);
    expect(await assistance.reason()).toBe("challenge");
    // Read the actual document cookie to verify the browser page's session.
    expect(await assistance.page.evaluate(() => document.cookie)).toContain(
      "fixture_session=preserve-this-session",
    );
    const input = await page.locator("#answer").boundingBox();
    expect(input).not.toBeNull();
    // Simulate an image displayed at half viewport width in the viewer.
    const viewerWidth = frame.width / 2;
    const viewerHeight = frame.height / 2;
    const clientX = (input!.x + input!.width / 2) / 2;
    const clientY = (input!.y + input!.height / 2) / 2;
    await click((clientX * frame.width) / viewerWidth, (clientY * frame.height) / viewerHeight);
    await assistance.input({ type: "text", text: "中文验证" });
    expect(await page.locator("#answer").inputValue()).toBe("中文验证");
    await assistance.input({ type: "key", key: "ArrowLeft" });
    await assistance.input({ type: "key", key: "Backspace" });
    expect(await page.locator("#answer").inputValue()).toBe("中文证");
  });

  it("supports pointer dragging and verification completion on the original tab", async () => {
    await assistance.input({
      type: "pointer",
      action: "down",
      x: 100,
      y: 270,
      button: "left",
      buttons: 1,
    });
    await assistance.input({
      type: "pointer",
      action: "move",
      x: 230,
      y: 270,
      button: "left",
      buttons: 1,
    });
    await assistance.input({
      type: "pointer",
      action: "up",
      x: 230,
      y: 270,
      button: "left",
      buttons: 0,
    });
    await expect.poll(() => page.locator("body").getAttribute("data-drag-distance")).toBe("130");
    await click(180, 190);
    await expect.poll(() => assistance.reason()).toBeNull();
    expect(await page.locator("#result").textContent()).toBe("completed");
    const cdp = await context.newCDPSession(page);
    expect((await cdp.send("Target.getTargetInfo")).targetInfo.targetId).toBe(targetId);
    await cdp.detach();
    expect(
      (await context.cookies(origin)).find((cookie) => cookie.name === "fixture_session")?.value,
    ).toBe("preserve-this-session");
  });

  it("rejects malformed input and input after the viewer disconnects", async () => {
    await expect(assistance.input({ type: "text", text: "x".repeat(4097) })).rejects.toThrow();
    await expect(
      assistance.input({ type: "pointer", action: "down", x: -1, y: 10 }),
    ).rejects.toThrow();
    await assistance.input({ type: "wheel", x: 600, y: 400, deltaX: 0, deltaY: 350 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await assistance.stopFrames();
    await expect(assistance.input({ type: "key", key: "Enter" })).rejects.toThrow("not connected");
  });

  it("does not attach a missing target id to a different remaining page", async () => {
    await expect(AssistancePage.connect(cdpUrl, "missing-target-id")).rejects.toThrow();
  });

  it("delivers the last visual update after a burst without waiting for another frame", async () => {
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    await page.evaluate(async () => {
      for (const color of ["rgb(255,0,0)", "rgb(0,0,255)", "rgb(0,255,0)"]) {
        document.body.style.background = color;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await expect
      .poll(async () => {
        const frame = frames.at(-1);
        if (!frame) {
          return false;
        }
        return page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/jpeg;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const drawing = canvas.getContext("2d");
          if (!drawing) {
            return false;
          }
          drawing.drawImage(image, 0, 0);
          const [red, green, blue] = drawing.getImageData(10, 10, 1, 1).data;
          return red < 30 && green > 220 && blue < 30;
        }, frame.data);
      })
      .toBe(true);
  });

  it("recognizes a completed local widget and still detects a visible login form", async () => {
    expect(await assistance.reason()).toBe("challenge");
    await page.evaluate(() => {
      const response = document.createElement("textarea");
      response.name = "g-recaptcha-response";
      response.value = "local-test-completed-response";
      response.hidden = true;
      document.body.append(response);
    });
    expect(await assistance.reason()).toBeNull();
    await page.evaluate(() => {
      const password = document.createElement("input");
      password.type = "password";
      document.body.append(password);
    });
    expect(await assistance.reason()).toBe("login");
  });
});
