import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test-helpers/load-styles.js";
import "./app.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe("Suheng RabbitMQ debug browser flow", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("selects a database Skill and sends it through the debug transport", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/skills?")) {
        return new Response(
          JSON.stringify({
            skills: [{ id: 7, name: "数据库研判", description: "来自 skills 表" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/run")) {
        return new Response(
          JSON.stringify({
            response: "研判已完成",
            events: [],
            trace: [
              {
                id: "step-1",
                summary: "查询分析数据",
                category: "query",
                status: "completed",
                narrative: ["读取了当前用户授权的数据。"],
                toolName: "feed_query",
                input: '{\n  "limit": 10\n}',
                output: '{\n  "success": true,\n  "total": 3\n}',
              },
            ],
            usage: {
              calls: 1,
              inputTokens: 128,
              outputTokens: 32,
              cacheReadTokens: 16,
              cacheWriteTokens: 0,
              totalTokens: 176,
              models: [
                {
                  provider: "openai",
                  model: "GPT5.4",
                  calls: 1,
                  inputTokens: 128,
                  outputTokens: 32,
                  totalTokens: 160,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = document.createElement("suheng-rabbitmq-debug-app");
    document.body.append(app);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const skillsNav = [...app.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("数据库 Skills"),
    );
    skillsNav?.click();
    await vi.waitFor(() => expect(app.textContent).toContain("数据库研判"));
    app.querySelector<HTMLButtonElement>(".suheng-debug-skill")?.click();

    const chatNav = [...app.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("对话测试"),
    );
    chatNav?.click();
    await app.updateComplete;

    const textarea = app.querySelector<HTMLTextAreaElement>(".agent-chat__input textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    textarea.value = "分析今天的舆情";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await app.updateComplete;
    app.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();

    await vi.waitFor(() => expect(app.textContent).toContain("研判已完成"));
    expect(app.textContent).toContain("查询分析数据");
    expect(app.textContent).toContain("输入 128");
    expect(app.textContent).toContain("输出 32");
    expect(app.textContent).toContain("缓存写入 0");
    expect(app.textContent).toContain("GPT5.4 · 1 次 · 输入 128 · 输出 32 · 总计 160");
    expect(app.textContent).toContain("调用参数");
    expect(app.textContent).toContain('"limit": 10');
    expect(app.textContent).toContain("返回结果");
    expect(app.textContent).toContain('"total": 3');
    const runCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith("/run"));
    const body = runCall?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new TypeError("Expected the debug request body to be JSON text");
    }
    const requestBody = JSON.parse(body) as Record<string, unknown>;
    expect(requestBody.skill_ids).toEqual([7]);
    expect(requestBody).not.toHaveProperty("builtin_skill_name");
  });
});
