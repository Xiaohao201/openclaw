// Process-global bridge for enqueuing a proactive-completion notification from
// ANOTHER extension (e.g. legal-check submits 内容检测 jobs but the
// CompletionNotifier + pending registry live here in leading-v2).
//
// The submitting tool only knows the delivery target (sessionKey, the chat
// session) at submit time, so registration must happen there — but the registry
// and pollers live in this plugin. The plugin boundary forbids a cross-extension
// import, so we expose a single narrow function on a process-wide Symbol.for key
// (the same pattern as chat-topic.ts). leading-v2 installs it on service start
// (only when notify is enabled) and removes it on stop; the other extension
// looks it up and calls it, degrading gracefully (poll-only) when it is absent.

/** Minimal descriptor the submitter passes; leading-v2 fills topic/ttl/timestamps. */
export interface NotifyEnqueueInput {
  /** Must be a NotifyKind leading-v2 has a poll adapter for, else it is rejected. */
  kind: string;
  /** rabbitmq-<uid> user id, for per-uid api-key resolution when polling. */
  uid: string;
  /** Backend job id/uuid/slug to poll. */
  backendId: string;
  /** ctx.sessionKey — addresses the user's chat session for proactive delivery. */
  sessionKey: string;
  /** Optional explicit Mercure topic; leading-v2 resolves it from uid when omitted. */
  mercureTopic?: string;
  /** Short task label for the notification title. */
  title?: string | null;
  /** Optional explicit routing copy. */
  delivery?: Record<string, unknown>;
}

/** Returns true when the task was accepted for background notification. */
export type NotifyEnqueueFn = (input: NotifyEnqueueInput) => boolean;

const SYMBOL = Symbol.for("openclaw.leading-v2.notifyEnqueue");

function slot(): Record<symbol, NotifyEnqueueFn | undefined> {
  return globalThis as unknown as Record<symbol, NotifyEnqueueFn | undefined>;
}

export function setNotifyEnqueue(fn: NotifyEnqueueFn): void {
  slot()[SYMBOL] = fn;
}

export function clearNotifyEnqueue(): void {
  slot()[SYMBOL] = undefined;
}

export function getNotifyEnqueue(): NotifyEnqueueFn | undefined {
  return slot()[SYMBOL];
}
