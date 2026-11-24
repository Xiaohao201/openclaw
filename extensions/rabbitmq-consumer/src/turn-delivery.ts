import type { MercureEventPusher } from "./mercure-pusher.js";

/** Check at dispatch time, including chunks that were queued before Stop. */
export function guardTurnDelivery(
  pusher: MercureEventPusher,
  stopped: () => boolean,
): MercureEventPusher {
  return {
    pushBrowserAssistance: (...args) =>
      stopped()
        ? Promise.resolve(false)
        : (pusher.pushBrowserAssistance?.(...args) ?? Promise.resolve(false)),
    pushText: (...args) => (stopped() ? Promise.resolve(false) : pusher.pushText(...args)),
    pushProgress: (...args) => (stopped() ? Promise.resolve(false) : pusher.pushProgress(...args)),
    pushStep: (...args) => (stopped() ? Promise.resolve(false) : pusher.pushStep(...args)),
    pushCitations: (...args) =>
      stopped() ? Promise.resolve(false) : pusher.pushCitations(...args),
    pushReportCreated: (...args) =>
      stopped() ? Promise.resolve(false) : pusher.pushReportCreated(...args),
    pushError: (...args) => (stopped() ? Promise.resolve(false) : pusher.pushError(...args)),
    pushDone: (...args) => (stopped() ? Promise.resolve(false) : pusher.pushDone(...args)),
  };
}
