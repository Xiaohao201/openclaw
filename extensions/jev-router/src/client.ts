import {
  abstain,
  buildRequest,
  selectCandidates,
  type RouterConfig,
  type Selection,
} from "./router.js";
import { parseUsage, type Usage } from "./usage.js";

export type Decision = Selection & { elapsedMs: number; usage?: Usage };
type ClientDependencies = {
  fetch?: typeof fetch;
  apiKey?: () => string | undefined;
  now?: () => number;
};
class InvalidBodyError extends Error {}
export async function readBody(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new InvalidBodyError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new InvalidBodyError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidBodyError();
  }
}

export function createDecisionClient(config: RouterConfig, deps: ClientDependencies = {}) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const key = deps.apiKey ?? (() => process.env.JEV_OPENROUTER_API_KEY);
  const now = deps.now ?? Date.now;
  let active = 0;
  let failures = 0;
  let retryAt = 0;
  return {
    async decide(prompt: string, signal?: AbortSignal): Promise<Decision> {
      const started = now();
      let usage: Usage | undefined;
      const finish = (selection: Selection): Decision => ({
        ...selection,
        elapsedMs: Math.max(0, now() - started),
        ...(usage ? { usage } : {}),
      });
      if (signal?.aborted) {
        return finish(abstain(config, "cancelled"));
      }
      if (!prompt.trim() || prompt.length > 20000) {
        return finish(abstain(config, "unsupported_context"));
      }
      if (!config.candidates.length) {
        return finish(abstain(config, "no_candidates"));
      }
      const apiKey = key()?.trim();
      if (!apiKey) {
        return finish(abstain(config, "missing_key"));
      }
      if (now() < retryAt) {
        return finish(abstain(config, "circuit_open"));
      }
      if (active >= config.maxConcurrent) {
        return finish(abstain(config, "busy"));
      }
      active++;
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
      let selection: Selection;
      try {
        const response = await fetcher("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "openclaw-jev-router-poc",
          },
          body: JSON.stringify(buildRequest(prompt, config)),
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          selection = abstain(config, "http_error");
        } else {
          const body = await readBody(response);
          usage = parseUsage(body);
          selection = selectCandidates(body, config);
        }
      } catch (error) {
        selection = abstain(
          config,
          signal?.aborted
            ? "cancelled"
            : timedOut
              ? "timeout"
              : error instanceof InvalidBodyError
                ? "invalid_response"
                : "network_error",
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        active--;
      }
      // Only transport/contract failures trip the circuit, not ordinary uncertainty.
      if (
        selection.status === "abstain" &&
        ["http_error", "network_error", "timeout", "invalid_response"].includes(selection.reason)
      ) {
        failures++;
        if (failures >= 3) {
          retryAt = now() + 30000;
        }
      } else {
        failures = 0;
      }
      return finish(selection);
    },
  };
}
