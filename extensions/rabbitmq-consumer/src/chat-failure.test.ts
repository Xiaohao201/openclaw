import { describe, expect, it, vi } from "vitest";
import { notifyChatFailure } from "./chat-failure.js";
import { StreamingMercurePusher, type MercureEventPusher } from "./mercure-pusher.js";

function setup() {
  const mercure: MercureEventPusher = {
    pushText: vi.fn(async () => true),
    pushProgress: vi.fn(async () => true),
    pushStep: vi.fn(async () => true),
    pushCitations: vi.fn(async () => true),
    pushDone: vi.fn(async () => true),
    pushReportCreated: vi.fn(async () => true),
    pushError: vi.fn(async () => true),
  };
  return {
    mercure,
    stream: null,
    topic: "lobster/user/42",
    historyId: 9499,
    message: "处理失败",
    logger: { warn: vi.fn() },
  };
}

describe("notifyChatFailure", () => {
  it("retries terminal notifications without replaying text", async () => {
    const params = setup();
    vi.mocked(params.mercure.pushError).mockResolvedValueOnce(false);
    const stream = new StreamingMercurePusher(params.mercure, params.topic, params.historyId);
    stream.appendDelta("buffered content");
    await notifyChatFailure({ ...params, stream });
    expect(params.mercure.pushText).not.toHaveBeenCalled();
    expect(params.mercure.pushError).toHaveBeenCalledTimes(2);
    expect(params.mercure.pushError).toHaveBeenLastCalledWith(params.topic, params.message, 9499);
    expect(params.mercure.pushDone).toHaveBeenCalledExactlyOnceWith(params.topic, 9499);
  });

  it("still sends done if the error event exhausts retries", async () => {
    const params = setup();
    vi.mocked(params.mercure.pushError).mockRejectedValue(new Error("private hub URL"));
    await notifyChatFailure(params);
    expect(params.mercure.pushError).toHaveBeenCalledTimes(3);
    expect(params.mercure.pushDone).toHaveBeenCalledTimes(1);
    expect(params.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("event=error historyId=9499 attempts=3"),
    );
    expect(JSON.stringify(params.logger.warn.mock.calls)).not.toContain("private hub");
  });

  it("bounds done retries and reports exhausted delivery without throwing", async () => {
    const params = setup();
    vi.mocked(params.mercure.pushDone).mockResolvedValue(false);
    await notifyChatFailure(params);
    expect(params.mercure.pushDone).toHaveBeenCalledTimes(3);
    expect(params.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("event=done historyId=9499 attempts=3"),
    );
  });
});
