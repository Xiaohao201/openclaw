import type { CDPSession, Page } from "playwright-core";
import { z } from "zod";
import { getPageForTargetId } from "../browser/pw-session.js";
import type { BrowserAssistanceFrame, BrowserAssistanceReason } from "./types.js";

const coordinate = z.number().finite().min(0).max(16_384);
const inputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pointer"),
      action: z.enum(["move", "down", "up"]),
      x: coordinate,
      y: coordinate,
      button: z.enum(["left", "right", "middle"]).default("left"),
      buttons: z.number().int().min(0).max(7).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      x: coordinate,
      y: coordinate,
      deltaX: z.number().finite().min(-2000).max(2000),
      deltaY: z.number().finite().min(-2000).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("text"), text: z.string().max(4096) }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.enum([
        "Enter",
        "Tab",
        "Backspace",
        "Delete",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        " ",
      ]),
    })
    .strict(),
]);

export class AssistancePage {
  private cdp?: CDPSession;
  private frameListener?: (frame: {
    data: string;
    sessionId: number;
    metadata: { deviceWidth: number; deviceHeight: number };
  }) => void;
  private lastFrame = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private constructor(readonly page: Page) {}

  static async connect(cdpUrl: string, targetId: string) {
    const deadline = Date.now() + 2_000;
    while (true) {
      const page = await getPageForTargetId({ cdpUrl, targetId });
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        // CDP can expose only the startup tab briefly after creating a new target.
        // Wait for the exact target; never accept the legacy single-page fallback.
        if (targetInfo.targetId === targetId) {
          return new AssistancePage(page);
        }
      } finally {
        await session.detach();
      }
      if (Date.now() >= deadline) {
        throw new Error("Original browser tab is unavailable");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async reason(): Promise<BrowserAssistanceReason | null> {
    return this.page.evaluate(() => {
      const visible = (selector: string) =>
        [...document.querySelectorAll(selector)].some((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        });
      const solved = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          '[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]',
        ),
      ].some((element) => element.value.length > 0);
      if (
        !solved &&
        (visible(
          'iframe[src*="recaptcha"][title*="challenge"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#challenge-running,#challenge-stage',
        ) ||
          /just a moment|verify you are human|security verification|安全验证|人机验证/i.test(
            document.title,
          ))
      ) {
        return "challenge";
      }
      if (visible('input[type="password"]')) {
        return "login";
      }
      return null;
    });
  }

  async startFrames(send: (frame: BrowserAssistanceFrame) => void) {
    await this.stopFrames();
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;
    this.lastFrame = 0;
    let latest: Parameters<NonNullable<AssistancePage["frameListener"]>>[0] | undefined;
    const flush = () => {
      this.frameTimer = undefined;
      const frame = latest;
      latest = undefined;
      if (!frame || this.cdp !== cdp) {
        return;
      }
      this.lastFrame = Date.now();
      send({
        type: "frame",
        data: frame.data,
        width: frame.metadata.deviceWidth,
        height: frame.metadata.deviceHeight,
        origin: new URL(this.page.url()).origin,
      });
    };
    this.frameListener = (frame) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      // Drop stale/intermediate frames instead of buffering user-visible secrets.
      if (frame.data.length > 2_000_000) {
        return;
      }
      latest = frame;
      const delay = 100 - (Date.now() - this.lastFrame);
      if (delay <= 0) {
        flush();
      } else if (!this.frameTimer) {
        this.frameTimer = setTimeout(flush, delay);
      }
    };
    cdp.on("Page.screencastFrame", this.frameListener);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
  }

  async stopFrames() {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
    }
    this.frameTimer = undefined;
    const cdp = this.cdp;
    this.cdp = undefined;
    if (!cdp) {
      return;
    }
    if (this.frameListener) {
      cdp.off("Page.screencastFrame", this.frameListener);
    }
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }

  async input(raw: unknown) {
    const value = inputSchema.parse(raw);
    const cdp = this.cdp;
    if (!cdp) {
      throw new Error("Browser viewer is not connected");
    }
    if (value.type === "text") {
      await cdp.send("Input.insertText", { text: value.text });
    } else if (value.type === "key") {
      await this.page.keyboard.press(value.key);
    } else if (value.type === "wheel") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: value.x,
        y: value.y,
        deltaX: value.deltaX,
        deltaY: value.deltaY,
      });
    } else {
      await cdp.send("Input.dispatchMouseEvent", {
        type:
          value.action === "down"
            ? "mousePressed"
            : value.action === "up"
              ? "mouseReleased"
              : "mouseMoved",
        x: value.x,
        y: value.y,
        button: value.button,
        buttons: value.buttons,
        clickCount: value.action === "move" ? 0 : 1,
      });
    }
  }
}
