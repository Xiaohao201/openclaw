/** Chat agents are named `rabbitmq-<userId>`; that userId is the trusted identity. */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

/**
 * Extract the trusted backend userId from the agent id. Returns null for any
 * agent that is not a per-user chat agent — tool factories return null in that
 * case so the backend tools stay hidden from non-chat agents.
 */
export function extractUserId(agentId: string | undefined): string | null {
  const match = RABBITMQ_AGENT_PATTERN.exec(agentId ?? "");
  return match?.[1] ?? null;
}

/** Session keys are minted as `agent:<agentId>:<channel>:…`. */
const SESSION_KEY_AGENT_PATTERN = /^agent:([^:]+):/;

/**
 * The agent a sessionKey belongs to — needed to locate that session's
 * transcript, which lives under the agent's own sessions directory. Falls back
 * to the per-user chat agent id, the only shape leading-v2 mints.
 */
export function agentIdFromSessionKey(sessionKey: string, userId: string): string {
  return SESSION_KEY_AGENT_PATTERN.exec(sessionKey)?.[1] ?? `rabbitmq-${userId}`;
}
