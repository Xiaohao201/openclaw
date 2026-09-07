/** Names and policy stages only: never log tool arguments, schemas, or credentials. */
export function formatToolAvailability(params: {
  stage: string;
  available: Iterable<string>;
  before?: Iterable<string>;
  runId?: string;
  sessionKey?: string;
}): string {
  const available = [...new Set(params.available)].toSorted();
  const allowed = new Set(available);
  const removed = params.before
    ? [...new Set(params.before)].filter((name) => !allowed.has(name)).toSorted()
    : [];
  return `tool-availability ${JSON.stringify({
    stage: params.stage,
    runId: params.runId,
    sessionKey: params.sessionKey,
    available,
    removed,
  })}`;
}
