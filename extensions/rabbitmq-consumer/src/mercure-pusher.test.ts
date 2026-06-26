import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MercurePusher } from "./mercure-pusher.js";
import { StreamingMercurePusher } from "./mercure-pusher.js";

/**
 * Regression tests for tail truncation: the frontend finalizes the bubble on
 * `done`, so a `done` POST racing ahead of an in-flight text POST drops the
 * tail of the reply (e.g. "……或者生成更" instead of "……或者生成更详细的报告吗？").
 */
describe("StreamingMercurePusher push ordering", () => {
  let calls: string[];
  let resolvers: Array<() => void>;
  let fakePusher: MercurePusher;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    resolvers = [];
    fakePusher = {
      pushText: vi.fn((_topic: string, content: string) => {
        return new Promise<boolean>((resolve) => {
          resolvers.push(() => {
            calls.push(`text:${content}`);
            resolve(true);
          });
        });
      }),
      pushDone: vi.fn(async () => {
        calls.push("done");
        return true;
      }),
      pushError: vi.fn(async (_topic: string, error: string) => {
        calls.push(`error:${error}`);
        return true;
      }),
    } as unknown as MercurePusher;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not push done while a timer-scheduled flush is still in flight", async () => {
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 42, 80);

    pusher.appendDelta("需要我深入追踪某个具体方向，或者生成更详细的报告吗？");
    // Timer fires: flush takes the buffer and starts a pushText fetch that we
    // keep pending to simulate network latency.
    await vi.advanceTimersByTimeAsync(80);
    expect(fakePusher.pushText).toHaveBeenCalledTimes(1);

    // Stream ends; finish() sees an empty buffer. It must still wait for the
    // in-flight text push before signaling done.
    const finishPromise = pusher.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakePusher.pushDone).not.toHaveBeenCalled();

    resolvers[0]();
    await finishPromise;
    expect(calls).toEqual(["text:需要我深入追踪某个具体方向，或者生成更详细的报告吗？", "done"]);
  });

  it("delivers chunks in order even when an earlier push resolves late", async () => {
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 42, 80);

    pusher.appendDelta("第一段");
    await vi.advanceTimersByTimeAsync(80); // chunk 1 in flight
    pusher.appendDelta("第二段");

    const finishPromise = pusher.finish(); // flushes chunk 2 + done

    // Chunk 2 must not be POSTed before chunk 1 has settled.
    await vi.advanceTimersByTimeAsync(0);
    expect(fakePusher.pushText).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakePusher.pushText).toHaveBeenCalledTimes(2);

    resolvers[1]();
    await finishPromise;
    expect(calls).toEqual(["text:第一段", "text:第二段", "done"]);
  });

  it("never streams an internal path split across two flush windows", async () => {
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 7, 80);
    const drain = async () => {
      while (resolvers.length) {
        resolvers.shift()!();
        await vi.advanceTimersByTimeAsync(0);
      }
    };

    // The closing backtick of `memory/…md` lands only in the second delta.
    pusher.appendDelta("处理完成，详见 `memory/2026-");
    await vi.advanceTimersByTimeAsync(80);
    await drain(); // window 1: only the safe prefix may be pushed

    pusher.appendDelta("06-09.md` 完成");
    const finishPromise = pusher.finish();
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    await finishPromise;

    // The path must never appear in any pushed chunk, in either window.
    expect(calls.join("|")).not.toContain("memory");
    expect(calls.join("|")).not.toContain("`");
    expect(calls).toContain("done");
  });

  it("pushError waits for in-flight text pushes before sending the error", async () => {
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 42, 80);

    pusher.appendDelta("部分输出");
    await vi.advanceTimersByTimeAsync(80); // text push in flight

    const errorPromise = pusher.pushError("boom");
    await vi.advanceTimersByTimeAsync(0);
    expect(fakePusher.pushError).not.toHaveBeenCalled();

    resolvers[0]();
    await errorPromise;
    expect(calls).toEqual(["text:部分输出", "error:boom"]);
  });

  it("preserves structural whitespace when markdown is split across flush windows", async () => {
    // Regression: the flusher used to run the whitespace-tidying sanitizer per
    // chunk, so a flush boundary landing on the blank line between blocks (or on
    // the space after a `###` marker) was trimmed away. The frontend then
    // concatenated the pieces with that whitespace gone, rendering glued markdown
    // (`---##`, `环节### 10`, `###1.`). The pushed pieces must rejoin byte-for-byte.
    const pusher = new StreamingMercurePusher(fakePusher, "user-1", 9, 80);
    const drain = async () => {
      while (resolvers.length) {
        resolvers.shift()!();
        await vi.advanceTimersByTimeAsync(0);
      }
    };

    const doc =
      "**标题**\n\n---\n\n## （一）清单\n\n正文一段。\n\n### 1. 事件甲\n\n描述。\n\n### 2. 事件乙\n\n表格如下：\n\n| 列 | 值 |\n|----|----|\n| a | 1 |\n";
    // Adversarial slices: boundaries fall exactly on the blank lines and on the
    // space right after the `###` / `##` markers — the spots the old code ate.
    const slices = [
      "**标题**\n\n",
      "---\n\n## ",
      "（一）清单\n\n正文一段。\n\n### ",
      "1. 事件甲\n\n描述。\n\n### ",
      "2. 事件乙\n\n表格如下：\n\n| 列 | 值 |\n|----|----|\n| a | 1 |\n",
    ];
    expect(slices.join("")).toBe(doc); // sanity: slices reconstruct the source

    for (const s of slices) {
      pusher.appendDelta(s);
      await vi.advanceTimersByTimeAsync(80);
      await drain();
    }
    const finishPromise = pusher.finish();
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    await finishPromise;

    const streamed = calls
      .filter((c) => c.startsWith("text:"))
      .map((c) => c.slice("text:".length))
      .join("");
    expect(streamed).toBe(doc);
  });
});
