import { describe, expect, it, vi } from "vitest";
import { buildDebugRunPayload, loadDatabaseSkills, runDebugTurn } from "./transport.js";

describe("RabbitMQ debug transport", () => {
  it("loads only metadata returned by the database skills endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              { id: 7, name: "舆情研判", description: "数据库技能" },
              { id: 0, name: "无效", description: null },
              { id: 8, name: "", description: "无名称" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(loadDatabaseSkills(" user-42 ", fetchImpl)).resolves.toEqual([
      { id: 7, name: "舆情研判", description: "数据库技能" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/plugins/rabbitmq-consumer/debug/skills?user_id=user-42",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("builds a RabbitMQ payload with database skill ids and no bundled skill selector", () => {
    expect(
      buildDebugRunPayload({
        historyId: 9,
        message: "分析今天的舆情",
        sessionId: "debug-session",
        userId: "42",
        skillIds: [7, 9, 7, 0],
      }),
    ).toEqual({
      id: 9,
      message: "分析今天的舆情",
      session_id: "debug-session",
      user_id: "42",
      use_memory: false,
      skill_ids: [7, 9],
    });
  });

  it("posts one debug turn through the existing loopback endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ response: "研判结果", events: [], trace: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      runDebugTurn(
        {
          historyId: 10,
          message: "继续分析",
          sessionId: "debug-session",
          userId: "42",
          skillIds: [7],
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ response: "研判结果", trace: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/plugins/rabbitmq-consumer/debug/run",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: expect.not.stringContaining("builtin_skill_name"),
      }),
    );
  });

  it("rejects empty and oversized user ids before making a request", async () => {
    const fetchImpl = vi.fn();

    await expect(loadDatabaseSkills("   ", fetchImpl)).rejects.toThrow("请输入用户 ID");
    await expect(loadDatabaseSkills("x".repeat(129), fetchImpl)).rejects.toThrow(
      "用户 ID 不能超过 128 个字符",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
