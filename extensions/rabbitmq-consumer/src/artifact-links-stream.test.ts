import { describe, expect, it, vi } from "vitest";
import { ArtifactLinks } from "./artifact-links.js";
import { StreamingMercurePusher, type MercureEventPusher } from "./mercure-pusher.js";

describe("artifact link streaming", () => {
  it("never sends an unvalidated link across any delta boundary and delivers before done", async () => {
    const url = "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/10/10/test.html";
    const wrong = url.replace("2026/10/10", "2026-10-10");
    const answer = `[下载](<${wrong} >)\n`;
    for (let split = 1; split < answer.length; split++) {
      const events: string[] = [];
      const pusher = {
        pushText: vi.fn(async (_topic: string, text: string) => {
          events.push(text);
          return true;
        }),
        pushDone: vi.fn(async () => {
          events.push("DONE");
          return true;
        }),
      } as unknown as MercureEventPusher;
      const links = new ArtifactLinks();
      links.observeToolEvent({
        phase: "result",
        name: "file_share",
        result: { details: { ok: true, url, filename: "测试.html" } },
      });
      const stream = new StreamingMercurePusher(pusher, "test", 1, 80, links);
      stream.appendDelta(answer.slice(0, split));
      await stream.flush();
      expect(events.join("")).not.toContain("https:");
      stream.appendDelta(answer.slice(split));
      await stream.finish();
      expect(events.join("")).not.toContain(wrong);
      expect(events.join("")).toContain(`[下载](${url})`);
      expect(events.at(-2)).toContain(`[测试.html](${url})`);
      expect(events.at(-1)).toBe("DONE");
    }
  });

  it("withholds an unknown link even when the stream ends mid-URL", async () => {
    const texts: string[] = [];
    const pusher = {
      pushText: async (_topic: string, text: string) => {
        texts.push(text);
        return true;
      },
      pushDone: async () => true,
    } as unknown as MercureEventPusher;
    const stream = new StreamingMercurePusher(pusher, "test", 1, 80, new ArtifactLinks());
    stream.appendDelta("下载：https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026-10-");
    await stream.finish();
    expect(texts.join("")).not.toContain("https://");
    expect(texts.join("")).toContain("下载链接未核验");
  });
});
