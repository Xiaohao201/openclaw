/** Tracks actual operations, even when their callers stop waiting for them. */
export function createServiceWorkTracker(id: string, initiallyAccepting = false) {
  let accepting = initiallyAccepting;
  let active = 0;
  const waiters = new Set<() => void>();
  const enter = () => {
    if (!accepting) {
      throw new Error(`${id}: service is not accepting work`);
    }
    active += 1;
    return () => {
      active -= 1;
      if (active === 0) {
        for (const waiter of waiters) {
          waiter();
        }
      }
    };
  };
  return {
    activeCount: () => active,
    resume: () => {
      accepting = true;
    },
    closeAdmission: () => {
      accepting = false;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const leave = enter();
      try {
        return await operation();
      } finally {
        leave();
      }
    },
    async *stream<T>(operation: () => AsyncIterable<T>): AsyncIterable<T> {
      const leave = enter();
      try {
        const iterator = operation()[Symbol.asyncIterator]();
        let done = false;
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              done = true;
              return;
            }
            yield next.value;
          }
        } finally {
          // Some producers own background work that outlives iterator.return().
          // Drain it even when the consumer stops reading; never mistake a lost
          // observer for completed work during an upgrade.
          if (!done) {
            try {
              while (!(await iterator.next()).done) {
                /* drain */
              }
            } finally {
              await iterator.return?.();
            }
          }
        }
      } finally {
        leave();
      }
    },
    async pause(timeoutMs: number): Promise<void> {
      accepting = false;
      if (active === 0) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(
          () => {
            waiters.delete(done);
            reject(
              new Error(
                `${id}: drain timed out (${active} active operations); work was not aborted`,
              ),
            );
          },
          Math.max(1, timeoutMs),
        );
        waiters.add(done);
      });
    },
  };
}
