import { describe, expect, it, vi } from "vitest";
import { MercurePusher, StreamingMercurePusher } from "./mercure-pusher.js";

describe("StreamingMercurePusher quote normalization", () => {
  it("streams paired Chinese quotes correctly when a pair spans flush windows", async () => {
    const chunks: string[] = [];
    const fakePusher = {
      pushReportText: vi.fn(async (_topic: string, content: string) => {
        chunks.push(content);
        return true;
      }),
      pushReportDone: vi.fn(async () => true),
    } as unknown as MercurePusher;
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 7, 80);

    pusher.appendDelta('前文，"残疾夫');
    await pusher.flush();
    pusher.appendDelta('妻""脑瘫女孩"。');
    await pusher.finish();

    expect(chunks.join("")).toBe("前文，“残疾夫妻”“脑瘫女孩”。");
  });
});
