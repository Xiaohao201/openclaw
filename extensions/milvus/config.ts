export type MilvusConnectionConfig = {
  address: string;
  token?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  database?: string;
};

export type MilvusEmbeddingConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  dimensions: number;
  /** Whether to send a `dimensions` param to the embeddings endpoint. Some OpenAI-compatible providers (e.g. Volcengine Ark) reject it. Defaults to true. */
  sendDimensions: boolean;
};

export const DEFAULT_EMBEDDING_PROFILE = "default";

export type MilvusConfig = {
  connection: MilvusConnectionConfig;
  embedding: MilvusEmbeddingConfig;
  /** Additional named embedding configs (e.g. a second provider/dimension) usable via a tool call's `embeddingProfile` param. */
  embeddingProfiles: Record<string, MilvusEmbeddingConfig>;
  defaultCollection: string;
  /** Collections that milvus_upsert/milvus_delete must refuse to write to (e.g. a curated read-only reference corpus). */
  readOnlyCollections: string[];
};

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_COLLECTION = "openclaw_vectors";

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number | undefined {
  return EMBEDDING_DIMENSIONS[model];
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveOptionalEnvVars(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? resolveEnvVars(value) : undefined;
}

function resolveEmbeddingModelAndDimensions(embedding: Record<string, unknown>): {
  model: string;
  dimensions: number;
} {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  const dimensions =
    typeof embedding.dimensions === "number" ? embedding.dimensions : vectorDimsForModel(model);
  if (dimensions === undefined) {
    throw new Error(
      `Unsupported embedding model "${model}": specify embedding.dimensions explicitly.`,
    );
  }
  return { model, dimensions };
}

function parseEmbedding(raw: unknown, label: string): MilvusEmbeddingConfig {
  const embedding = raw as Record<string, unknown> | undefined;
  if (!embedding || typeof embedding.apiKey !== "string" || !embedding.apiKey.trim()) {
    throw new Error(`${label}.apiKey is required`);
  }
  assertAllowedKeys(
    embedding,
    ["apiKey", "model", "baseUrl", "dimensions", "sendDimensions"],
    label,
  );
  const { model, dimensions } = resolveEmbeddingModelAndDimensions(embedding);
  return {
    apiKey: resolveEnvVars(embedding.apiKey),
    model,
    baseUrl: resolveOptionalEnvVars(embedding.baseUrl),
    dimensions,
    sendDimensions: embedding.sendDimensions !== false,
  };
}

function parseEmbeddingProfiles(raw: unknown): Record<string, MilvusEmbeddingConfig> {
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("embeddingProfiles must be an object");
  }
  const profiles: Record<string, MilvusEmbeddingConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROFILE_NAME_PATTERN.test(name)) {
      throw new Error(`embeddingProfiles key "${name}" must match [a-zA-Z0-9_]+`);
    }
    profiles[name] = parseEmbedding(value, `embeddingProfiles.${name}`);
  }
  return profiles;
}

function parseReadOnlyCollections(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error("readOnlyCollections must be an array of strings");
  }
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

export const milvusConfigSchema = {
  parse(value: unknown): MilvusConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("milvus config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["connection", "embedding", "embeddingProfiles", "defaultCollection", "readOnlyCollections"],
      "milvus config",
    );

    const connection = cfg.connection as Record<string, unknown> | undefined;
    if (!connection || typeof connection.address !== "string" || !connection.address.trim()) {
      throw new Error("connection.address is required");
    }
    assertAllowedKeys(
      connection,
      ["address", "token", "username", "password", "ssl", "database"],
      "connection config",
    );

    const embedding = parseEmbedding(cfg.embedding, "embedding");
    const embeddingProfiles = parseEmbeddingProfiles(cfg.embeddingProfiles);

    const defaultCollection =
      typeof cfg.defaultCollection === "string" && cfg.defaultCollection.trim()
        ? cfg.defaultCollection
        : DEFAULT_COLLECTION;

    return {
      connection: {
        address: resolveEnvVars(connection.address),
        token: resolveOptionalEnvVars(connection.token),
        username: resolveOptionalEnvVars(connection.username),
        password: resolveOptionalEnvVars(connection.password),
        ssl: connection.ssl === true,
        database: typeof connection.database === "string" ? connection.database : undefined,
      },
      embedding,
      embeddingProfiles,
      defaultCollection,
      readOnlyCollections: parseReadOnlyCollections(cfg.readOnlyCollections),
    };
  },
  uiHints: {
    "connection.address": {
      label: "Milvus Address",
      placeholder: "localhost:19530",
      help: "Milvus server address as host:port (or https://host:port for Zilliz Cloud)",
    },
    "connection.token": {
      label: "API Token",
      sensitive: true,
      placeholder: "${MILVUS_TOKEN}",
      help: "API token (Zilliz Cloud) or user:password token; supports ${ENV_VAR}",
      advanced: true,
    },
    "connection.username": {
      label: "Username",
      placeholder: "${MILVUS_USERNAME}",
      help: "Username for username/password authentication; supports ${ENV_VAR}",
      advanced: true,
    },
    "connection.password": {
      label: "Password",
      sensitive: true,
      placeholder: "${MILVUS_PASSWORD}",
      help: "Password for username/password authentication; supports ${ENV_VAR}",
      advanced: true,
    },
    "connection.ssl": {
      label: "Use SSL/TLS",
      advanced: true,
    },
    "connection.database": {
      label: "Database",
      placeholder: "default",
      advanced: true,
    },
    "embedding.apiKey": {
      label: "Embedding API Key",
      sensitive: true,
      placeholder: "sk-...",
      help: "API key for the OpenAI-compatible embeddings endpoint (or use ${OPENAI_API_KEY})",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model name",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Base URL for compatible providers (e.g. DashScope, Ollama)",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Dimensions",
      placeholder: "1536",
      help: "Vector dimensions for custom/non-standard models (required unless using a known OpenAI model)",
      advanced: true,
    },
    "embedding.sendDimensions": {
      label: "Send Dimensions Param",
      help: "Whether to send a dimensions param to the embeddings endpoint. Disable for providers that reject it (e.g. Volcengine Ark).",
      advanced: true,
    },
    embeddingProfiles: {
      label: "Additional Embedding Profiles",
      help: "Named embedding configs (same shape as embedding) selectable per tool call via embeddingProfile, for collections that use a different provider/model/dimension.",
      advanced: true,
    },
    defaultCollection: {
      label: "Default Collection",
      placeholder: DEFAULT_COLLECTION,
      advanced: true,
    },
    readOnlyCollections: {
      label: "Read-Only Collections",
      help: "Collection names that milvus_upsert/milvus_delete must refuse to write to.",
      advanced: true,
    },
  },
};
