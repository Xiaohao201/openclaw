/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./app.js";

describe("Suheng RabbitMQ debug app", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("uses the Control UI shell and exposes only database-backed Skills", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [{ id: 7, name: "数据库研判", description: "来自 skills 表" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = document.createElement("suheng-rabbitmq-debug-app");
    document.body.append(app);
    await app.updateComplete;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(app.textContent).toContain("RabbitMQ 本地测试");
    expect(app.textContent).toContain("数据库 Skills");
    expect(app.textContent).not.toContain("内置 Skills");

    const skillsButton = [...app.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("数据库 Skills"),
    );
    skillsButton?.click();
    await vi.waitFor(() => {
      expect(app.textContent).toContain("数据库研判");
      expect(app.textContent).toContain("来自 skills 表");
    });
  });
});
