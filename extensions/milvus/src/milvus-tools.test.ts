import { describe, expect, it, vi } from "vitest";
import type { MilvusConfig } from "../config.js";
import type { Embeddings } from "./embeddings.js";
import type { MilvusClientWrapper } from "./milvus-client.js";
import {
  createMilvusDeleteToolFactory,
  createMilvusListCollectionsToolFactory,
  createMilvusSearchToolFactory,
  createMilvusUpsertToolFactory,
  type MilvusToolDeps,
} from "./milvus-tools.js";

const config: MilvusConfig = {
  connection: { address: "localhost:19530" },
  embedding: {
    apiKey: "sk-test",
    model: "text-embedding-3-small",
    dimensions: 3,
    sendDimensions: true,
  },
  embeddingProfiles: {
    doubao: {
      apiKey: "ark-test",
      model: "ep-test",
      dimensions: 4,
      sendDimensions: false,
    },
  },
  defaultCollection: "openclaw_vectors",
  readOnlyCollections: ["ReadOnlyCollection"],
};

function createDeps(
  overrides: {
    client?: Partial<MilvusClientWrapper>;
    embeddings?: Partial<Embeddings>;
    doubaoEmbeddings?: Partial<Embeddings>;
    config?: MilvusConfig;
  } = {},
): MilvusToolDeps {
  const client = {
    upsert: vi.fn(async () => 1),
    search: vi.fn(async () => []),
    deleteEntries: vi.fn(async () => undefined),
    listCollections: vi.fn(async () => []),
    ...overrides.client,
  } as unknown as MilvusClientWrapper;
  const embeddings = {
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    ...overrides.embeddings,
  } as unknown as Embeddings;
  const doubaoEmbeddings = {
    embed: vi.fn(async () => [0.4, 0.5, 0.6, 0.7]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.4, 0.5, 0.6, 0.7])),
    ...overrides.doubaoEmbeddings,
  } as unknown as Embeddings;
  return {
    client,
    embeddings: { default: embeddings, doubao: doubaoEmbeddings },
    config: overrides.config ?? config,
  };
}

function detailsOf(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

describe("milvus_upsert tool", () => {
  it("embeds and upserts entries, defaulting the collection", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", {
      entries: [{ text: "hello", metadata: { tag: "a" } }],
    });
    expect(detailsOf(result)).toMatchObject({
      success: true,
      collection: "openclaw_vectors",
      inserted: 1,
    });
    expect(deps.embeddings.default.embedBatch).toHaveBeenCalledWith(["hello"]);
    expect(deps.client.upsert).toHaveBeenCalledWith(
      "openclaw_vectors",
      [{ text: "hello", vector: [0.1, 0.2, 0.3], metadata: { tag: "a" } }],
      3,
    );
  });

  it("uses an explicit collection name when provided", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", {
      collection: "notes",
      entries: [{ text: "hello" }],
    });
    expect(detailsOf(result)).toMatchObject({ collection: "notes" });
  });

  it("rejects entries with no non-empty text", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", { entries: [{ text: "   " }] });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(deps.client.upsert).not.toHaveBeenCalled();
  });

  it("returns a failure payload when the client throws", async () => {
    const deps = createDeps({
      client: {
        upsert: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", { entries: [{ text: "hello" }] });
    expect(detailsOf(result).success).toBe(false);
    expect(String(detailsOf(result).error)).toContain("boom");
  });

  it("uses the named embedding profile's embeddings and dimensions", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    await tool.execute("call-1", {
      entries: [{ text: "hello" }],
      embeddingProfile: "doubao",
    });
    expect(deps.embeddings.doubao.embedBatch).toHaveBeenCalledWith(["hello"]);
    expect(deps.embeddings.default.embedBatch).not.toHaveBeenCalled();
    expect(deps.client.upsert).toHaveBeenCalledWith(
      "openclaw_vectors",
      [{ text: "hello", vector: [0.4, 0.5, 0.6, 0.7], metadata: undefined }],
      4,
    );
  });

  it("rejects an unknown embedding profile without calling the client", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", {
      entries: [{ text: "hello" }],
      embeddingProfile: "nope",
    });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(deps.client.upsert).not.toHaveBeenCalled();
  });

  it("refuses to write to a read-only collection", async () => {
    const deps = createDeps();
    const tool = createMilvusUpsertToolFactory(deps)();
    const result = await tool.execute("call-1", {
      collection: "ReadOnlyCollection",
      entries: [{ text: "hello" }],
    });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(String(detailsOf(result).error)).toContain("read-only");
    expect(deps.client.upsert).not.toHaveBeenCalled();
    expect(deps.embeddings.default.embedBatch).not.toHaveBeenCalled();
  });
});

describe("milvus_search tool", () => {
  it("embeds the query and returns matches", async () => {
    const matches = [{ id: 1, score: 0.9, text: "hello", metadata: undefined }];
    const deps = createDeps({ client: { search: vi.fn(async () => matches) } });
    const tool = createMilvusSearchToolFactory(deps)();
    const result = await tool.execute("call-1", { query: "hi" });
    expect(detailsOf(result)).toMatchObject({ success: true, matches });
    expect(deps.client.search).toHaveBeenCalledWith("openclaw_vectors", [0.1, 0.2, 0.3], {
      topK: 5,
      filter: undefined,
    });
  });

  it("rejects an empty query", async () => {
    const deps = createDeps();
    const tool = createMilvusSearchToolFactory(deps)();
    const result = await tool.execute("call-1", { query: "  " });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(deps.client.search).not.toHaveBeenCalled();
  });

  it("passes topK and filter through", async () => {
    const deps = createDeps();
    const tool = createMilvusSearchToolFactory(deps)();
    await tool.execute("call-1", { query: "hi", topK: 10, filter: 'tag == "x"' });
    expect(deps.client.search).toHaveBeenCalledWith("openclaw_vectors", [0.1, 0.2, 0.3], {
      topK: 10,
      filter: 'tag == "x"',
      outputFields: undefined,
    });
  });

  it("embeds with the named profile and passes outputFields through", async () => {
    const deps = createDeps();
    const tool = createMilvusSearchToolFactory(deps)();
    await tool.execute("call-1", {
      query: "hi",
      embeddingProfile: "doubao",
      outputFields: ["text"],
    });
    expect(deps.embeddings.doubao.embed).toHaveBeenCalledWith("hi");
    expect(deps.embeddings.default.embed).not.toHaveBeenCalled();
    expect(deps.client.search).toHaveBeenCalledWith("openclaw_vectors", [0.4, 0.5, 0.6, 0.7], {
      topK: 5,
      filter: undefined,
      outputFields: ["text"],
    });
  });

  it("rejects an unknown embedding profile without calling the client", async () => {
    const deps = createDeps();
    const tool = createMilvusSearchToolFactory(deps)();
    const result = await tool.execute("call-1", { query: "hi", embeddingProfile: "nope" });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(deps.client.search).not.toHaveBeenCalled();
  });
});

describe("milvus_delete tool", () => {
  it("requires ids or filter", async () => {
    const deps = createDeps();
    const tool = createMilvusDeleteToolFactory(deps)();
    const result = await tool.execute("call-1", {});
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(deps.client.deleteEntries).not.toHaveBeenCalled();
  });

  it("deletes by ids", async () => {
    const deps = createDeps();
    const tool = createMilvusDeleteToolFactory(deps)();
    const result = await tool.execute("call-1", { ids: [1, 2] });
    expect(detailsOf(result)).toMatchObject({ success: true });
    expect(deps.client.deleteEntries).toHaveBeenCalledWith("openclaw_vectors", {
      ids: [1, 2],
      filter: undefined,
    });
  });

  it("refuses to delete from a read-only collection", async () => {
    const deps = createDeps();
    const tool = createMilvusDeleteToolFactory(deps)();
    const result = await tool.execute("call-1", {
      collection: "ReadOnlyCollection",
      ids: [1],
    });
    expect(detailsOf(result)).toMatchObject({ success: false });
    expect(String(detailsOf(result).error)).toContain("read-only");
    expect(deps.client.deleteEntries).not.toHaveBeenCalled();
  });
});

describe("milvus_list_collections tool", () => {
  it("returns collections from the client", async () => {
    const deps = createDeps({ client: { listCollections: vi.fn(async () => ["docs", "notes"]) } });
    const tool = createMilvusListCollectionsToolFactory(deps)();
    const result = await tool.execute();
    expect(detailsOf(result)).toMatchObject({ success: true, collections: ["docs", "notes"] });
  });
});
