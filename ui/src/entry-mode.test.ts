import { describe, expect, it } from "vitest";
import { resolveUiEntryMode } from "./entry-mode.js";

describe("resolveUiEntryMode", () => {
  it("selects the RabbitMQ debug app only for the explicit local mode", () => {
    expect(resolveUiEntryMode("?mode=rabbitmq-debug")).toBe("rabbitmq-debug");
    expect(resolveUiEntryMode("?mode=other")).toBe("control-ui");
    expect(resolveUiEntryMode("")).toBe("control-ui");
  });
});
