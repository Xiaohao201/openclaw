import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import { commitIsolatedSession, prepareIsolatedSession } from "./isolated-session.js";

const state = vi.hoisted(() => ({
  store: {} as Record<string, { sessionId: string; sessionFile?: string; updatedAt: number }>,
  lock: vi.fn(async () => ({ release: async () => {} })),
}));
vi.mock("./session-snapshot.runtime-api.js", () => ({
  acquireSessionWriteLock: state.lock,
  updateSessionStore: async (_path: string, mutate: (store: typeof state.store) => unknown) =>
    mutate(state.store),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  state.store = {};
  state.lock.mockReset().mockResolvedValue({ release: async () => {} });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-session-"));
  roots.push(root);
  const sessions = {
    resolveStorePath: () => path.join(root, "sessions.json"),
    resolveSessionFilePath: (_id: string, entry: { sessionFile: string }) => entry.sessionFile,
  } as unknown as PluginRuntime["agent"]["session"];
  return (id: number, signal?: AbortSignal) =>
    prepareIsolatedSession({
      history: { id, userId: "42", sessionId: "s1" },
      userId: "42",
      agentId: "rabbitmq-42",
      sessions,
      request: "Generate the weekly report",
      signal,
    });
}

it("starts a new lane from an immutable recovery checkpoint while the old transcript stays locked", async () => {
  const prepare = await fixture();
  const first = await prepare(1);
  const prefix = await fs.readFile(first.checkpointFile, "utf8");
  state.lock.mockImplementation(async () => {
    throw new Error("old run still holds its lock");
  });
  const second = await prepare(2);
  expect(second.sessionKey).not.toBe(first.sessionKey);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(await fs.readFile(second.sessionFile, "utf8")).toBe(prefix);
  const messages = SessionManager.open(second.sessionFile).buildSessionContext().messages;
  expect(JSON.stringify(messages)).toContain("Generate the weekly report");
  expect(state.lock).not.toHaveBeenCalled();
});

it("rejects stale and cancelled commits and preserves the new checkpoint", async () => {
  const prepare = await fixture();
  const first = await prepare(1);
  const second = await prepare(2);
  expect(await commitIsolatedSession(first)).toBe(false);
  const controller = new AbortController();
  controller.abort();
  expect(await commitIsolatedSession(second, controller.signal)).toBe(false);
  expect(state.store[second.conversationKey].sessionFile).toBe(second.checkpointFile);
});

it("commits a frozen copy and preserves its exact prefix in the next turn", async () => {
  const prepare = await fixture();
  const first = await prepare(1);
  await fs.copyFile(first.checkpointFile, first.sessionFile);
  expect(await commitIsolatedSession(first)).toBe(true);
  const bytes = await fs.readFile(state.store[first.conversationKey].sessionFile!, "utf8");
  await fs.appendFile(first.sessionFile, "late mutation\n");
  const second = await prepare(2);
  expect(await fs.readFile(second.sessionFile, "utf8")).toBe(bytes);
});

it("does not start cancelled turns or overwrite an existing execution on redelivery", async () => {
  const prepare = await fixture();
  await expect(prepare(1, AbortSignal.abort())).rejects.toThrow();
  const first = await prepare(1);
  await expect(prepare(1)).rejects.toThrow(/already exists/);
  expect(state.store[first.conversationKey].sessionFile).toBe(first.checkpointFile);
});
