import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export const DEFAULT_FULL_TEXT_SEARCH_ENDPOINT = "http://123.57.81.67:8004/api/v1/full_text_search";
export const DEFAULT_FULL_TEXT_SEARCH_TIMEOUT_SECONDS = 90;
export const DEFAULT_FULL_TEXT_SEARCH_MAX_CONTENT_CHARS = 4_000;

type FullTextSearchPluginConfig = {
  endpoint?: unknown;
  timeoutSeconds?: unknown;
  maxContentChars?: unknown;
};

function resolvePluginConfig(config?: OpenClawConfig): FullTextSearchPluginConfig | undefined {
  const value = config?.plugins?.entries?.["full-text-search"]?.config;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FullTextSearchPluginConfig)
    : undefined;
}

function normalizeBoundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

export function resolveFullTextSearchEndpoint(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = resolvePluginConfig(config)?.endpoint;
  const candidate =
    (typeof configured === "string" && configured.trim()) ||
    env.FULL_TEXT_SEARCH_URL?.trim() ||
    DEFAULT_FULL_TEXT_SEARCH_ENDPOINT;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Full text search endpoint must be a valid http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Full text search endpoint must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Full text search endpoint must not contain embedded credentials.");
  }
  url.hash = "";
  return url.toString();
}

export function resolveFullTextSearchTimeoutSeconds(
  config?: OpenClawConfig,
  override?: number,
): number {
  return normalizeBoundedNumber(
    override ?? resolvePluginConfig(config)?.timeoutSeconds,
    DEFAULT_FULL_TEXT_SEARCH_TIMEOUT_SECONDS,
    1,
    120,
  );
}

export function resolveFullTextSearchMaxContentChars(
  config?: OpenClawConfig,
  override?: number,
): number {
  return normalizeBoundedNumber(
    override ?? resolvePluginConfig(config)?.maxContentChars,
    DEFAULT_FULL_TEXT_SEARCH_MAX_CONTENT_CHARS,
    1,
    12_000,
  );
}
