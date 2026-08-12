import { readFileSync } from "node:fs";
import type { SmtpConfig } from "./types.js";

type ReadFile = (path: string, encoding: "utf8") => string;

interface SmtpFileConfig {
  host?: unknown;
  protocol?: unknown;
  port?: unknown;
  password?: unknown;
  user?: unknown;
  senderEmail?: unknown;
  senderName?: unknown;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseFileConfig(raw: string): SmtpConfig {
  let parsed: SmtpFileConfig;
  try {
    parsed = JSON.parse(raw) as SmtpFileConfig;
  } catch {
    throw new Error("Invalid SMTP config file");
  }

  const host = requiredString(parsed.host);
  const user = requiredString(parsed.user);
  const password = requiredString(parsed.password);
  const from = requiredString(parsed.senderEmail) ?? user;
  const defaultSender = requiredString(parsed.senderName) ?? "观舆卫士";
  const port = Number(parsed.port);
  const protocol = requiredString(parsed.protocol)?.toLowerCase();
  if (
    !host ||
    !user ||
    !password ||
    !from ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !["ssl", "tls", "smtp", "smtps"].includes(protocol ?? "")
  ) {
    throw new Error("Invalid SMTP config file");
  }

  return {
    transport: "smtp",
    proxyProtocol: "http",
    host,
    port,
    user,
    password,
    from,
    defaultSender,
  };
}

/** Resolve inline plugin email config or a credential-bearing standalone JSON file. */
export function resolveSmtpConfig(
  block: Record<string, unknown> | undefined,
  deps: { readFile?: ReadFile } = {},
): SmtpConfig | undefined {
  const configFile =
    requiredString(block?.configFile) ?? requiredString(process.env.REPORT_SMTP_CONFIG_FILE);
  if (configFile) {
    return parseFileConfig((deps.readFile ?? readFileSync)(configFile, "utf8"));
  }
  if (!block) {
    return undefined;
  }
  return {
    transport: block.transport === "smtp" ? "smtp" : "http",
    proxyProtocol: block.proxyProtocol === "https" ? "https" : "http",
    host: requiredString(block.host) ?? "",
    port: Number(block.port ?? 587),
    user: requiredString(block.user) ?? "",
    password: requiredString(block.password) ?? "",
    from: requiredString(block.from) ?? "",
    defaultSender: requiredString(block.senderName) ?? "观舆卫士",
  };
}
