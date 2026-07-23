/**
 * Per-key serial execution queue: tasks sharing a key run strictly in enqueue
 * order (each waits for the previous one to settle), tasks with different keys
 * run concurrently. Used to keep one user's messages ordered while different
 * users proceed in parallel under prefetch > 1.
 *
 * Adapted from extensions/feishu/src/sequential-queue.ts with a generic return
 * type so callers get their task's result/rejection back.
 */
export function createKeyedSerialQueue() {
  const chains = new Map<string, Promise<unknown>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    // Run after the previous task settles regardless of outcome, so one
    // rejected task never wedges the rest of its per-key chain.
    const next = previous.then(task, task);
    chains.set(key, next);
    const cleanup = () => {
      if (chains.get(key) === next) {
        chains.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  };
}
