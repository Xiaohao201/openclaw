import path from "node:path";

const executions = new Map<string, { signal?: AbortSignal; workspaceDir?: string }>();

/** Execution keys are unique per history row, never shared with a later turn. */
export function registerActiveExecution(
  sessionKey: string,
  signal?: AbortSignal,
  workspaceDir?: string,
): () => void {
  const execution = { signal, workspaceDir };
  executions.set(sessionKey, execution);
  return () => {
    if (executions.get(sessionKey) === execution) {
      executions.delete(sessionKey);
    }
  };
}

/** Keep ordinary artifact writes in the turn directory. This is not a shell sandbox. */
export function scopeExecutionTool(
  sessionKey: string,
  toolName: string,
  params: Record<string, unknown>,
) {
  const directory = executions.get(sessionKey)?.workspaceDir;
  if (!directory) {
    return undefined;
  }
  if (toolName === "exec") {
    return { params: { ...params, workdir: directory } };
  }
  if (toolName !== "write" && toolName !== "edit") {
    return undefined;
  }
  const field = typeof params.path === "string" ? "path" : "file_path";
  const supplied = params[field];
  if (typeof supplied !== "string") {
    return undefined;
  }
  const target = path.resolve(directory, supplied);
  const relative = path.relative(directory, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return {
      block: true,
      blockReason:
        "Write a copy in this execution's output directory; do not modify shared files or another execution's artifacts.",
    };
  }
  return { params: { ...params, [field]: target } };
}

export function isInactiveExecution(sessionKey: string): boolean {
  if (!/:rabbitmq:[^:]+:.+:turn:\d+$/u.test(sessionKey)) {
    return false;
  }
  const execution = executions.get(sessionKey);
  // Fail closed for orphan executions after restart or after pipeline cleanup.
  return !execution || execution.signal?.aborted === true;
}
