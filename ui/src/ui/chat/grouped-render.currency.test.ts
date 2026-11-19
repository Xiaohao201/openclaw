import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderMessageGroup } from "./grouped-render.ts";

describe("chat cost display", () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
  });

  it("shows aggregated yuan costs on assistant messages", () => {
    container = document.createElement("div");
    document.body.append(container);
    render(
      renderMessageGroup(
        {
          kind: "group",
          key: "cost-test",
          role: "assistant",
          timestamp: 0,
          isStreaming: false,
          messages: [10, 30].map((cost, index) => ({
            key: `message-${index}`,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              model: "example-model",
              usage: { input: 100, output: 100 },
              cost: { total: cost },
            },
          })),
        },
        { showReasoning: false },
      ),
      container,
    );
    expect(container.querySelector(".msg-meta__cost")?.textContent).toBe("¥40.0000");
  });
});
