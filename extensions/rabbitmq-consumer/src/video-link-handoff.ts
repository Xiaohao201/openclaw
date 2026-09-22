import type { OpenClawPluginToolContext } from "../api.js";

type SessionContext = Pick<OpenClawPluginToolContext, "agentId" | "sessionKey" | "sessionId">;
export type ParsedVideoTarget = { sourceUrl: string; resolvedUrl: string; videoUrl?: string };
type Entry = ParsedVideoTarget & { videoUrl: string; expiresAt: number };
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 256;

/** Plugin-instance cache; no transcript mutation or cross-session URL fallback. */
export function createVideoLinkHandoff() {
  const entries = new Map<string, { scope: string; value: Entry }>();
  function scopeFor(context: SessionContext): string | undefined {
    if (!context.sessionKey || !context.sessionId) {
      return undefined;
    }
    return JSON.stringify([context.agentId, context.sessionKey, context.sessionId]);
  }
  function prune() {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.value.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }
  return {
    record(context: SessionContext, target: ParsedVideoTarget) {
      const scope = scopeFor(context);
      if (!scope) {
        return;
      }
      prune();
      // A new parse attempt invalidates earlier results, including expanded aliases.
      for (const [key, entry] of entries) {
        if (
          entry.scope === scope &&
          (entry.value.sourceUrl === target.sourceUrl ||
            entry.value.resolvedUrl === target.resolvedUrl)
        ) {
          entries.delete(key);
        }
      }
      if (!target.videoUrl) {
        return;
      }
      entries.set(JSON.stringify([scope, target.sourceUrl]), {
        scope,
        value: { ...target, videoUrl: target.videoUrl, expiresAt: Date.now() + TTL_MS },
      });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
    },
    resolve(context: SessionContext, url: unknown): string | undefined {
      const scope = scopeFor(context);
      if (!scope || typeof url !== "string") {
        return undefined;
      }
      prune();
      for (const entry of entries.values()) {
        if (
          entry.scope === scope &&
          (url === entry.value.sourceUrl || url === entry.value.resolvedUrl)
        ) {
          return entry.value.videoUrl;
        }
      }
      return undefined;
    },
  };
}
