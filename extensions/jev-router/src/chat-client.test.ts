import { describe, expect, it, vi } from "vitest";
import { createChatClient } from "./chat-client.js";

describe("bounded benchmark chat client", () => {
  const input = { messages: [{ role: "user" as const, content: "synthetic" }], tools: [] };
  it("sets a fixed destination, disables redirects and stops at the request budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001 },
        }),
      ),
    );
    const client = createChatClient(
      { model: "qwen/qwen3.8-flash", maxRequests: 1 },
      { fetch: fetcher, apiKey: () => "test-key" },
    );
    expect(await client.complete(input)).toMatchObject({
      message: { content: "done" },
      usage: { costUsd: 0.001 },
    });
    await expect(client.complete(input)).rejects.toThrow("request_budget");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ redirect: "error" }),
    );
    const requestBody = fetcher.mock.calls[0][1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected a JSON request body.");
    }
    const payload = JSON.parse(requestBody);
    expect(payload).toMatchObject({
      model: "qwen/qwen3.8-flash",
      max_tokens: 512,
      temperature: 0,
      provider: { allow_fallbacks: false },
    });
  });
  it("rejects invalid configuration, missing credentials, upstream errors and truncation", async () => {
    expect(() => createChatClient({ model: "invalid", maxRequests: 1 })).toThrow();
    await expect(
      createChatClient(
        { model: "qwen/test", maxRequests: 1 },
        { apiKey: () => undefined },
      ).complete(input),
    ).rejects.toThrow("missing_key");
    for (const response of [
      new Response("private", { status: 500 }),
      new Response("not json"),
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "length", message: { role: "assistant", content: "partial" } },
          ],
        }),
      ),
    ]) {
      const client = createChatClient(
        { model: "qwen/test", maxRequests: 1 },
        { apiKey: () => "test-key", fetch: vi.fn<typeof fetch>().mockResolvedValue(response) },
      );
      await expect(client.complete(input)).rejects.toThrow("chat_failed");
    }
  });
});
