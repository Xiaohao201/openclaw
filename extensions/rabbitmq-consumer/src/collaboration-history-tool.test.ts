import { describe, expect, it, vi } from "vitest";
import {
  createCollaborationHistoryTool,
  createCollaborationHistoryToolFactory,
  resolveRabbitMqUserId,
  type CollaborationHistoryStore,
} from "./collaboration-history-tool.js";

function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

function createStore(): CollaborationHistoryStore {
  return {
    queryCollaborationHistory: vi.fn(async ({ requesterUserId, targetUserId }) => ({
      status: "ok" as const,
      access: requesterUserId === targetUserId ? ("self" as const) : ("administrator" as const),
      targetUserId,
      records: [
        {
          id: 1,
          sessionId: "session-a",
          message: "用户问题",
          response: "夙衡回答",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      hasMore: false,
    })),
  };
}

describe("resolveRabbitMqUserId", () => {
  it("derives the requester from trusted per-user agent context", () => {
    expect(resolveRabbitMqUserId("rabbitmq-42")).toBe("42");
    expect(resolveRabbitMqUserId("rabbitmq-local-user")).toBe("local-user");
  });

  it("rejects unrelated or malformed agent ids", () => {
    expect(resolveRabbitMqUserId("main")).toBeUndefined();
    expect(resolveRabbitMqUserId("rabbitmq-")).toBeUndefined();
    expect(resolveRabbitMqUserId("rabbitmq-user:other")).toBeUndefined();
  });
});

describe("collaboration_history_query tool", () => {
  it("defaults ordinary users to their own history", async () => {
    const store = createStore();
    const tool = createCollaborationHistoryTool({ requesterUserId: "42", store });

    const result = await tool.execute?.("call-self", { limit: 20 });

    expect(store.queryCollaborationHistory).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: "42", targetUserId: "42", limit: 20 }),
    );
    expect(resultDetails(result)).toMatchObject({
      status: "ok",
      access: "self",
      targetUserId: "42",
    });
  });

  it("returns a generic forbidden result when a normal user targets someone else", async () => {
    const store: CollaborationHistoryStore = {
      queryCollaborationHistory: vi.fn(async () => ({ status: "forbidden" as const })),
    };
    const tool = createCollaborationHistoryTool({ requesterUserId: "42", store });

    const result = await tool.execute?.("call-denied", { targetUserId: "99" });

    expect(resultDetails(result)).toEqual({
      status: "forbidden",
      error: "你只能查看自己的协作诊断信息；查看其他用户需要管理员权限。",
    });
  });

  it("allows the store's administrator decision to return another user's history", async () => {
    const store = createStore();
    const tool = createCollaborationHistoryTool({ requesterUserId: "1", store });

    const result = await tool.execute?.("call-admin", { targetUserId: "99" });

    expect(store.queryCollaborationHistory).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: "1", targetUserId: "99" }),
    );
    expect(resultDetails(result)).toMatchObject({
      status: "ok",
      access: "administrator",
      targetUserId: "99",
    });
  });

  it("marks stored conversation text as untrusted before returning it to the model", async () => {
    const store = createStore();
    const tool = createCollaborationHistoryTool({ requesterUserId: "42", store });

    const result = await tool.execute?.("call-untrusted", {});
    const records = resultDetails(result).records as Array<{ message: string; response: string }>;

    expect(records[0]?.message).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/u);
    expect(records[0]?.message).toContain("用户问题");
    expect(records[0]?.response).toContain("夙衡回答");
  });

  it("fails closed without exposing database errors", async () => {
    const store: CollaborationHistoryStore = {
      queryCollaborationHistory: vi.fn(async () => {
        throw new Error("SELECT su failed at 10.0.0.8");
      }),
    };
    const warn = vi.fn();
    const tool = createCollaborationHistoryTool({ requesterUserId: "1", store, logger: { warn } });

    const result = await tool.execute?.("call-error", { targetUserId: "99" });

    expect(resultDetails(result)).toEqual({
      status: "error",
      error: "协作诊断记录暂时无法读取，请稍后重试。",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(resultDetails(result))).not.toContain("10.0.0.8");
  });

  it("rejects invalid target ids before reaching the store", async () => {
    const store = createStore();
    const tool = createCollaborationHistoryTool({ requesterUserId: "42", store });

    const result = await tool.execute?.("call-invalid", { targetUserId: "../99" });

    expect(resultDetails(result)).toEqual({
      status: "invalid_request",
      error: "目标用户 ID 格式无效。",
    });
    expect(store.queryCollaborationHistory).not.toHaveBeenCalled();
  });

  it("rejects invalid or inverted time ranges before reaching the store", async () => {
    const store = createStore();
    const tool = createCollaborationHistoryTool({ requesterUserId: "42", store });

    const invalid = await tool.execute?.("call-invalid-date", { startAt: "not-a-date" });
    const inverted = await tool.execute?.("call-inverted-date", {
      startAt: "2026-09-01T00:00:00Z",
      endAt: "2026-08-01T00:00:00Z",
    });

    expect(resultDetails(invalid)).toMatchObject({ status: "invalid_request" });
    expect(resultDetails(inverted)).toMatchObject({ status: "invalid_request" });
    expect(store.queryCollaborationHistory).not.toHaveBeenCalled();
  });
});

describe("createCollaborationHistoryToolFactory", () => {
  it("binds authorization to trusted RabbitMQ agent context", () => {
    const store = createStore();
    const factory = createCollaborationHistoryToolFactory({ getStore: () => store });

    expect(factory({ agentId: "rabbitmq-42" })?.name).toBe("collaboration_history_query");
    expect(factory({ agentId: "main" })).toBeNull();
  });

  it("keeps the tool unavailable until the server-side store is ready", () => {
    const factory = createCollaborationHistoryToolFactory({ getStore: () => undefined });

    expect(factory({ agentId: "rabbitmq-42" })).toBeNull();
  });
});
