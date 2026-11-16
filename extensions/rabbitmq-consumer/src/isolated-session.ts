import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { acquireSessionWriteLock, updateSessionStore } from "./session-snapshot.runtime-api.js";
import type { HistoryRecord } from "./types.js";

export type IsolatedSession = {
  conversationKey: string;
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  checkpointFile: string;
  storePath: string;
};

async function copyRegularFile(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error("Checkpoint source must be a regular, unlinked file");
  }
  await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  await fs.chmod(target, 0o600);
}

/** Each history row owns a unique execution lane; the conversation points only at frozen files. */
export async function prepareIsolatedSession(params: {
  history: Pick<HistoryRecord, "id" | "sessionId" | "userId">;
  userId: string;
  agentId: string;
  request: string;
  sessions: PluginRuntime["agent"]["session"];
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<IsolatedSession> {
  params.signal?.throwIfAborted();
  const { history, sessions } = params;
  if (
    !Number.isSafeInteger(history.id) ||
    history.id <= 0 ||
    history.userId !== params.userId ||
    params.agentId !== `rabbitmq-${history.userId}` ||
    !/^[a-z0-9_-][a-z0-9._-]{0,127}$/iu.test(history.sessionId) ||
    history.sessionId.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(history.sessionId)
  ) {
    throw new Error("Invalid isolated session identity");
  }
  const conversationKey =
    `agent:${params.agentId}:rabbitmq:${params.userId}:${history.sessionId}`.toLowerCase();
  const sessionKey = `${conversationKey}:turn:${history.id}`;
  const storePath = sessions.resolveStorePath(params.config?.session?.store, {
    agentId: params.agentId,
  });
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const root = await fs.realpath(path.dirname(storePath));
  const directory = path.join(root, history.sessionId);
  await fs.mkdir(directory, { recursive: true });
  const directoryStat = await fs.lstat(directory);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    path.dirname(await fs.realpath(directory)) !== root
  ) {
    throw new Error("Invalid isolated session directory");
  }
  const sessionFile = path.join(directory, `${history.id}.jsonl`);
  const checkpointFile = path.join(directory, `${history.id}.recovery.jsonl`);
  return updateSessionStore(
    storePath,
    async (store) => {
      params.signal?.throwIfAborted();
      if (store[sessionKey]) {
        throw new Error("Isolated execution already exists; refusing to replay it");
      }
      const previous = store[conversationKey];
      const sessionId = randomUUID();
      const source = previous
        ? sessions.resolveSessionFilePath(previous.sessionId, previous, {
            agentId: params.agentId,
            sessionsDir: root,
          })
        : undefined;
      if (source) {
        // Frozen checkpoints never need the lock of the old running transcript.
        // Legacy migration must be quiescent: never copy a transcript through a live writer.
        const frozen =
          path.dirname(source) === directory &&
          /^\d+\.(?:recovery|completed)\.jsonl$/u.test(path.basename(source));
        const lock = frozen
          ? undefined
          : await acquireSessionWriteLock({
              sessionFile: source,
              timeoutMs: 1_000,
              allowReentrant: false,
            });
        try {
          await copyRegularFile(source, sessionFile);
          await copyRegularFile(source, checkpointFile);
        } finally {
          await lock?.release();
        }
      } else {
        // Reserve the recovery filename exclusively before SessionManager initializes it.
        await fs.writeFile(checkpointFile, "", { flag: "wx", mode: 0o600 });
      }
      const { appendRecoveryContext } = await import("./isolated-session.runtime.js");
      appendRecoveryContext(checkpointFile, params.request);
      params.signal?.throwIfAborted();
      const entry = { sessionId, sessionFile, updatedAt: Date.now() };
      store[sessionKey] = entry;
      // Publish recovery BEFORE launching the model, so Stop never needs to read a live file.
      store[conversationKey] = { ...entry, sessionFile: checkpointFile };
      return { conversationKey, sessionKey, sessionId, sessionFile, checkpointFile, storePath };
    },
    { skipMaintenance: true },
  );
}

/** A stale completion cannot advance the conversation after a newer turn took ownership. */
export async function commitIsolatedSession(
  execution: IsolatedSession,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  return updateSessionStore(
    execution.storePath,
    async (store) => {
      if (signal?.aborted || store[execution.conversationKey]?.sessionId !== execution.sessionId) {
        return false;
      }
      const lock = await acquireSessionWriteLock({
        sessionFile: execution.sessionFile,
        timeoutMs: 1_000,
        allowReentrant: false,
      });
      try {
        if (signal?.aborted) {
          return false;
        }
        const completed = execution.sessionFile.replace(/\.jsonl$/u, ".completed.jsonl");
        await copyRegularFile(execution.sessionFile, completed);
        if (signal?.aborted) {
          return false;
        }
        store[execution.conversationKey] = {
          sessionId: execution.sessionId,
          sessionFile: completed,
          updatedAt: Date.now(),
        };
        return true;
      } finally {
        await lock.release();
      }
    },
    { skipMaintenance: true },
  );
}
