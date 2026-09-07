import { describe, expect, it } from "vitest";
import { formatToolAvailability } from "./tool-availability.js";

describe("tool availability diagnostics", () => {
  it("sorts names deterministically without mutating the runtime catalog", () => {
    const names = ["zeta", "browser", "alpha"];
    const first = formatToolAvailability({
      stage: "model-tool-schemas",
      available: names,
      before: ["exec", "browser"],
    });
    expect(first).toBe(
      formatToolAvailability({
        stage: "model-tool-schemas",
        available: names.toReversed(),
        before: ["browser", "exec"],
      }),
    );
    expect(JSON.parse(first.slice("tool-availability ".length))).toEqual({
      stage: "model-tool-schemas",
      available: ["alpha", "browser", "zeta"],
      removed: ["exec"],
    });
    expect(names).toEqual(["zeta", "browser", "alpha"]);
  });
  it("distinguishes an empty final catalog and retains run correlation", () => {
    const result = formatToolAvailability({
      stage: "model-tools-unsupported",
      available: [],
      before: ["browser"],
      runId: "example-run",
      sessionKey: "example-session",
    });
    expect(JSON.parse(result.slice("tool-availability ".length))).toMatchObject({
      available: [],
      removed: ["browser"],
      runId: "example-run",
      sessionKey: "example-session",
    });
  });
});
