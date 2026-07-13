import { Type } from "@sinclair/typebox";
import { jsonResult } from "../api.js";
import { DEFAULT_EMBEDDING_PROFILE, type MilvusConfig } from "../config.js";
import type { Embeddings } from "./embeddings.js";
import type { MilvusClientWrapper } from "./milvus-client.js";

export type MilvusToolDeps = {
  client: MilvusClientWrapper;
  /** Embeddings keyed by profile name; the default profile is always present under DEFAULT_EMBEDDING_PROFILE. */
  embeddings: Record<string, Embeddings>;
  config: MilvusConfig;
};

function resolveCollection(deps: MilvusToolDeps, collection: unknown): string {
  return typeof collection === "string" && collection.trim()
    ? collection.trim()
    : deps.config.defaultCollection;
}

type ResolvedEmbeddings = { embeddings: Embeddings; dimensions: number };

/** Resolve the named embedding profile (defaulting to the plugin's base `embedding` config). */
function resolveEmbeddingsForProfile(
  deps: MilvusToolDeps,
  profile: unknown,
): ResolvedEmbeddings | { error: string } {
  const name = typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
  const embeddingConfig =
    !name || name === DEFAULT_EMBEDDING_PROFILE
      ? deps.config.embedding
      : deps.config.embeddingProfiles[name];
  const embeddings = deps.embeddings[name ?? DEFAULT_EMBEDDING_PROFILE];
  if (!embeddingConfig || !embeddings) {
    return { error: `Unknown embeddingProfile "${name}".` };
  }
  return { embeddings, dimensions: embeddingConfig.dimensions };
}

function isReadOnlyCollection(deps: MilvusToolDeps, collection: string): boolean {
  return deps.config.readOnlyCollections.includes(collection);
}

const EntrySchema = Type.Object({
  text: Type.String({ description: "Text to embed and store." }),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary JSON metadata stored alongside the vector.",
    }),
  ),
});

const UpsertSchema = Type.Object(
  {
    collection: Type.Optional(
      Type.String({
        description: "Target collection name. Defaults to the configured default collection.",
      }),
    ),
    entries: Type.Array(EntrySchema, {
      minItems: 1,
      description: "One or more text entries to embed and upsert.",
    }),
    embeddingProfile: Type.Optional(
      Type.String({
        description:
          "Named embedding profile to use (see the plugin's embeddingProfiles config). Defaults to the base embedding config.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createMilvusUpsertToolFactory(deps: MilvusToolDeps) {
  return () => ({
    name: "milvus_upsert",
    label: "Milvus Upsert",
    description:
      "Embed one or more text entries and store them in a Milvus collection for later semantic search. " +
      "Use this to remember documents, notes, or records so they can be retrieved by meaning later.",
    parameters: UpsertSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const entries = Array.isArray(rawParams.entries)
        ? (rawParams.entries as Array<{ text?: unknown; metadata?: unknown }>)
        : [];
      const texts = entries
        .map((entry) => (typeof entry.text === "string" ? entry.text : undefined))
        .filter((text): text is string => Boolean(text?.trim()));
      if (texts.length === 0) {
        return jsonResult({
          success: false,
          error: "entries must contain at least one non-empty text.",
        });
      }
      const collection = resolveCollection(deps, rawParams.collection);
      if (isReadOnlyCollection(deps, collection)) {
        return jsonResult({
          success: false,
          error: `Collection "${collection}" is read-only.`,
        });
      }
      const resolved = resolveEmbeddingsForProfile(deps, rawParams.embeddingProfile);
      if ("error" in resolved) {
        return jsonResult({ success: false, error: resolved.error });
      }
      try {
        const vectors = await resolved.embeddings.embedBatch(texts);
        const rows = texts.map((text, index) => ({
          text,
          vector: vectors[index],
          metadata: entries[index]?.metadata as Record<string, unknown> | undefined,
        }));
        const inserted = await deps.client.upsert(collection, rows, resolved.dimensions);
        return jsonResult({ success: true, collection, inserted });
      } catch (error) {
        return jsonResult({ success: false, error: `milvus_upsert failed: ${String(error)}` });
      }
    },
  });
}

const SearchSchema = Type.Object(
  {
    collection: Type.Optional(
      Type.String({
        description: "Collection to search. Defaults to the configured default collection.",
      }),
    ),
    query: Type.String({ description: "Query text to embed and search for." }),
    topK: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Number of matches to return (default 5).",
      }),
    ),
    filter: Type.Optional(
      Type.String({
        description: 'Optional Milvus boolean filter expression (e.g. metadata["tag"] == "x").',
      }),
    ),
    embeddingProfile: Type.Optional(
      Type.String({
        description:
          "Named embedding profile to use (see the plugin's embeddingProfiles config). Defaults to the base embedding config.",
      }),
    ),
    outputFields: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Fields to fetch from Milvus. Defaults to ["text", "metadata"] — override for collections without a metadata column.',
      }),
    ),
  },
  { additionalProperties: false },
);

export function createMilvusSearchToolFactory(deps: MilvusToolDeps) {
  return () => ({
    name: "milvus_search",
    label: "Milvus Search",
    description:
      "Semantic search: embed a query and find the most similar text entries previously stored via milvus_upsert.",
    parameters: SearchSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const query = typeof rawParams.query === "string" ? rawParams.query.trim() : "";
      if (!query) {
        return jsonResult({ success: false, error: "query is required." });
      }
      const collection = resolveCollection(deps, rawParams.collection);
      const topK = typeof rawParams.topK === "number" ? rawParams.topK : 5;
      const filter = typeof rawParams.filter === "string" ? rawParams.filter : undefined;
      const outputFields = Array.isArray(rawParams.outputFields)
        ? (rawParams.outputFields as string[])
        : undefined;
      const resolved = resolveEmbeddingsForProfile(deps, rawParams.embeddingProfile);
      if ("error" in resolved) {
        return jsonResult({ success: false, error: resolved.error });
      }
      try {
        const vector = await resolved.embeddings.embed(query);
        const matches = await deps.client.search(collection, vector, {
          topK,
          filter,
          outputFields,
        });
        return jsonResult({ success: true, collection, matches });
      } catch (error) {
        return jsonResult({ success: false, error: `milvus_search failed: ${String(error)}` });
      }
    },
  });
}

const DeleteSchema = Type.Object(
  {
    collection: Type.Optional(
      Type.String({
        description: "Collection to delete from. Defaults to the configured default collection.",
      }),
    ),
    ids: Type.Optional(
      Type.Array(Type.Union([Type.String(), Type.Number()]), {
        description: "Specific entry ids to delete.",
      }),
    ),
    filter: Type.Optional(
      Type.String({ description: "Milvus boolean filter expression selecting entries to delete." }),
    ),
  },
  { additionalProperties: false },
);

export function createMilvusDeleteToolFactory(deps: MilvusToolDeps) {
  return () => ({
    name: "milvus_delete",
    label: "Milvus Delete",
    description: "Delete entries from a Milvus collection by id or by filter expression.",
    parameters: DeleteSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const ids = Array.isArray(rawParams.ids)
        ? (rawParams.ids as Array<string | number>)
        : undefined;
      const filter = typeof rawParams.filter === "string" ? rawParams.filter : undefined;
      if (!ids?.length && !filter) {
        return jsonResult({ success: false, error: "Provide at least one of ids or filter." });
      }
      const collection = resolveCollection(deps, rawParams.collection);
      if (isReadOnlyCollection(deps, collection)) {
        return jsonResult({
          success: false,
          error: `Collection "${collection}" is read-only.`,
        });
      }
      try {
        await deps.client.deleteEntries(collection, { ids, filter });
        return jsonResult({ success: true, collection });
      } catch (error) {
        return jsonResult({ success: false, error: `milvus_delete failed: ${String(error)}` });
      }
    },
  });
}

const ListCollectionsSchema = Type.Object({}, { additionalProperties: false });

export function createMilvusListCollectionsToolFactory(deps: MilvusToolDeps) {
  return () => ({
    name: "milvus_list_collections",
    label: "Milvus List Collections",
    description: "List collections that currently exist on the configured Milvus server.",
    parameters: ListCollectionsSchema,
    async execute() {
      try {
        const collections = await deps.client.listCollections();
        return jsonResult({ success: true, collections });
      } catch (error) {
        return jsonResult({
          success: false,
          error: `milvus_list_collections failed: ${String(error)}`,
        });
      }
    },
  });
}
