import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { PluginRuntime } from "../api.js";
import { commitIsolatedSession, prepareIsolatedSession } from "./isolated-session.js";
import { acquireSessionWriteLock } from "./session-snapshot.runtime-api.js";

it("uses a real checkpoint and real session store while the cancelled execution still holds its real lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cancel-isolation-integration-"));
  const sessions = {
    resolveStorePath: () => path.join(root, "sessions.json"),
    resolveSessionFilePath: (_id: string, entry: { sessionFile: string }) => entry.sessionFile,
  } as unknown as PluginRuntime["agent"]["session"];
  const prepare = (id: number) =>
    prepareIsolatedSession({
      history: { id, userId: "42", sessionId: "isolation-test" },
      userId: "42",
      agentId: "rabbitmq-42",
      request: "Generate a report",
      sessions,
    });
  let lock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    const old = await prepare(1);
    await fs.copyFile(old.checkpointFile, old.sessionFile);
    lock = await acquireSessionWriteLock({ sessionFile: old.sessionFile });
    const next = await prepare(2);
    expect(next.sessionKey).not.toBe(old.sessionKey);
    expect(await fs.readFile(next.sessionFile, "utf8")).toBe(
      await fs.readFile(old.checkpointFile, "utf8"),
    );
    await expect(
      acquireSessionWriteLock({
        sessionFile: old.sessionFile,
        allowReentrant: false,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("session file locked");
    // Even after its lock is released, the old run cannot replace the new head.
    await lock.release();
    lock = undefined;
    expect(await commitIsolatedSession(old)).toBe(false);
    const store = JSON.parse(await fs.readFile(path.join(root, "sessions.json"), "utf8"));
    expect(store[next.conversationKey].sessionFile).toBe(next.checkpointFile);
  } finally {
    await lock?.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});
