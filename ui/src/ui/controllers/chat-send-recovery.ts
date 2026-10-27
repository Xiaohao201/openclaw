import { GatewayRequestError, GatewayTransportError } from "../gateway.ts";

export async function sendChatWithRecovery(params: {
  send: () => Promise<unknown>;
  isCurrent: () => boolean;
  wait?: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<void> {
  const now = params.now ?? Date.now;
  const until = now() + (params.timeoutMs ?? 120_000);
  for (;;) {
    try {
      await params.send();
      return;
    } catch (error) {
      const rejected =
        error instanceof GatewayRequestError &&
        error.gatewayCode === "UNAVAILABLE" &&
        error.retryable &&
        typeof error.details === "object" &&
        error.details !== null &&
        "notAccepted" in error.details &&
        error.details.notAccepted === true;
      const unsent = error instanceof GatewayTransportError && error.outcome === "not-sent";
      // Never retry a lost response: process-local idempotency cannot prove
      // that a previous Gateway did not already execute this run.
      if ((!rejected && !unsent) || !params.isCurrent() || now() >= until) {
        throw error;
      }
      await (params.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 500)));
      if (!params.isCurrent()) {
        throw error;
      }
    }
  }
}
