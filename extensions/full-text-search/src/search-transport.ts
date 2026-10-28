export type SearchRequest = {
  url: string;
  timeoutSeconds: number;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

export type SearchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  truncated: boolean;
  retryAfterMs?: number;
};

export function isRateLimited(response: SearchResponse): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 400 || response.truncated) {
    return false;
  }
  // This deployed proxy reports upstream throttling as HTTP 400 with a fixed detail.
  try {
    const payload: unknown = JSON.parse(response.text);
    return (
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload &&
      typeof payload.detail === "string" &&
      /^请求频率过高[,，]/u.test(payload.detail)
    );
  } catch {
    return false;
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function awaitOrAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One in-flight request per endpoint, with a conservative gap verified by live probes. */
export function createSearchTransport(request: (params: SearchRequest) => Promise<SearchResponse>) {
  const queues = new Map<string, { tail: Promise<void>; readyAt: number; pending: number }>();
  return async (params: SearchRequest): Promise<SearchResponse> => {
    params.signal?.throwIfAborted();
    for (const [key, queue] of queues) {
      if (queue.pending === 0 && queue.readyAt <= Date.now()) {
        queues.delete(key);
      }
    }
    let queue = queues.get(params.url);
    if (!queue) {
      queue = { tail: Promise.resolve(), readyAt: 0, pending: 0 };
      queues.set(params.url, queue);
    }
    const state = queue;
    state.pending++;
    const operation = state.tail.then(async () => {
      params.signal?.throwIfAborted();
      if (state.readyAt > Date.now()) {
        await wait(state.readyAt - Date.now(), params.signal);
      }
      let cooldown = 3000;
      try {
        for (let attempt = 0; ; attempt++) {
          params.signal?.throwIfAborted();
          const response = await request(params);
          const rateLimited = isRateLimited(response);
          cooldown = Math.max(rateLimited ? 5000 : 3000, response.retryAfterMs ?? 0);
          const transient = rateLimited || [502, 503, 504].includes(response.status);
          if (!transient || attempt >= 1) {
            return response;
          }
          const delay = Math.max(5000, response.retryAfterMs ?? 0);
          // Do not ignore a long Retry-After or hold a model tool open indefinitely.
          if (delay > 60_000) {
            return response;
          }
          await wait(delay, params.signal);
        }
      } finally {
        state.readyAt = Date.now() + cooldown;
      }
    });
    state.tail = operation
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        state.pending--;
      });
    return await awaitOrAbort(operation, params.signal);
  };
}
