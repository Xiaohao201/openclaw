import { describe, expect, it, vi } from "vitest";
import { MilvusClientWrapper, type MilvusSdkClient } from "./milvus-client.js";

function createFakeSdkClient(overrides: Partial<MilvusSdkClient> = {}): MilvusSdkClient {
  return {
    hasCollection: vi.fn(async () => ({ value: false })),
    createCollection: vi.fn(async () => ({})),
    createIndex: vi.fn(async () => ({})),
    loadCollection: vi.fn(async () => ({})),
    insert: vi.fn(async () => ({ IDs: [1] })),
    search: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({})),
    showCollections: vi.fn(async () => ({ data: [] })),
    ...overrides,
  };
}

const connection = { address: "localhost:19530" };

describe("MilvusClientWrapper.ensureCollection", () => {
  it("creates the collection, index, and loads it when missing", async () => {
    const sdk = createFakeSdkClient({ hasCollection: vi.fn(async () => ({ value: false })) });
    const wrapper = new MilvusClientWrapper(connection, sdk);

    await wrapper.ensureCollection("docs", 1536);

    expect(sdk.createCollection).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "docs" }),
    );
    expect(sdk.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: "docs",
        field_name: "vector",
        metric_type: "COSINE",
      }),
    );
    expect(sdk.loadCollection).toHaveBeenCalledWith({ collection_name: "docs" });
  });

  it("skips creation when the collection already exists", async () => {
    const sdk = createFakeSdkClient({ hasCollection: vi.fn(async () => ({ value: true })) });
    const wrapper = new MilvusClientWrapper(connection, sdk);

    await wrapper.ensureCollection("docs", 1536);

    expect(sdk.createCollection).not.toHaveBeenCalled();
    expect(sdk.createIndex).not.toHaveBeenCalled();
    expect(sdk.loadCollection).toHaveBeenCalledWith({ collection_name: "docs" });
  });

  it("only checks hasCollection once per collection name", async () => {
    const sdk = createFakeSdkClient({ hasCollection: vi.fn(async () => ({ value: true })) });
    const wrapper = new MilvusClientWrapper(connection, sdk);

    await wrapper.ensureCollection("docs", 1536);
    await wrapper.ensureCollection("docs", 1536);

    expect(sdk.hasCollection).toHaveBeenCalledTimes(1);
  });
});

describe("MilvusClientWrapper.upsert", () => {
  it("ensures the collection then inserts rows", async () => {
    const sdk = createFakeSdkClient({ hasCollection: vi.fn(async () => ({ value: true })) });
    const wrapper = new MilvusClientWrapper(connection, sdk);

    const inserted = await wrapper.upsert(
      "docs",
      [{ text: "hello", vector: [0.1, 0.2], metadata: { tag: "a" } }],
      2,
    );

    expect(inserted).toBe(1);
    expect(sdk.insert).toHaveBeenCalledWith({
      collection_name: "docs",
      data: [{ vector: [0.1, 0.2], text: "hello", metadata: { tag: "a" } }],
    });
  });

  it("returns 0 without calling insert for an empty row set", async () => {
    const sdk = createFakeSdkClient();
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const inserted = await wrapper.upsert("docs", [], 2);
    expect(inserted).toBe(0);
    expect(sdk.insert).not.toHaveBeenCalled();
  });
});

describe("MilvusClientWrapper.search", () => {
  it("returns an empty array when the collection does not exist", async () => {
    const sdk = createFakeSdkClient({ hasCollection: vi.fn(async () => ({ value: false })) });
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const matches = await wrapper.search("missing", [0.1], { topK: 5 });
    expect(matches).toEqual([]);
    expect(sdk.search).not.toHaveBeenCalled();
  });

  it("maps search results including parsed metadata", async () => {
    const sdk = createFakeSdkClient({
      hasCollection: vi.fn(async () => ({ value: true })),
      search: vi.fn(async () => ({
        results: [
          { id: 1, score: 0.9, text: "hello", metadata: { tag: "a" } },
          { id: 2, score: 0.5, text: "world", metadata: '{"tag":"b"}' },
        ],
      })),
    });
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const matches = await wrapper.search("docs", [0.1], { topK: 5, filter: 'tag == "a"' });

    expect(sdk.search).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "docs", limit: 5, filter: 'tag == "a"' }),
    );
    expect(matches).toEqual([
      { id: 1, score: 0.9, text: "hello", metadata: { tag: "a" } },
      { id: 2, score: 0.5, text: "world", metadata: { tag: "b" } },
    ]);
  });

  it("requests custom output fields when provided, and tolerates a missing metadata column", async () => {
    const sdk = createFakeSdkClient({
      hasCollection: vi.fn(async () => ({ value: true })),
      search: vi.fn(async () => ({
        results: [{ id: 1, score: 0.8, text: "hello", date: "2026-01-01" }],
      })),
    });
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const matches = await wrapper.search("DailyRiskTips", [0.1], {
      topK: 10,
      outputFields: ["text", "date"],
    });

    expect(sdk.search).toHaveBeenCalledWith(
      expect.objectContaining({ output_fields: ["text", "date"] }),
    );
    expect(matches).toEqual([{ id: 1, score: 0.8, text: "hello", metadata: undefined }]);
  });
});

describe("MilvusClientWrapper.deleteEntries", () => {
  it("throws when neither ids nor filter are provided", async () => {
    const wrapper = new MilvusClientWrapper(connection, createFakeSdkClient());
    await expect(wrapper.deleteEntries("docs", {})).rejects.toThrow(
      "delete requires at least one of ids or filter",
    );
  });

  it("delegates to the sdk client when ids are provided", async () => {
    const sdk = createFakeSdkClient();
    const wrapper = new MilvusClientWrapper(connection, sdk);
    await wrapper.deleteEntries("docs", { ids: [1, 2] });
    expect(sdk.delete).toHaveBeenCalledWith({
      collection_name: "docs",
      ids: [1, 2],
      filter: undefined,
    });
  });
});

describe("MilvusClientWrapper connection handling", () => {
  it("does not connect to the server until a call is made", async () => {
    // No injected client and no calls: constructing the wrapper must not touch the network.
    const wrapper = new MilvusClientWrapper({ address: "127.0.0.1:1" });
    expect(wrapper).toBeInstanceOf(MilvusClientWrapper);
  });

  it("rethrows connection errors and re-checks the collection on the next call", async () => {
    const deadline = Object.assign(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded after 15s"), {
      code: 4,
      details: "Deadline exceeded after 15s",
    });
    const hasCollection = vi
      .fn<() => Promise<{ value: boolean }>>()
      .mockRejectedValueOnce(deadline)
      .mockResolvedValue({ value: true });
    const sdk = createFakeSdkClient({ hasCollection });
    const wrapper = new MilvusClientWrapper(connection, sdk);

    await expect(wrapper.ensureCollection("docs", 2)).rejects.toThrow("DEADLINE_EXCEEDED");
    await wrapper.ensureCollection("docs", 2);

    expect(hasCollection).toHaveBeenCalledTimes(2);
    expect(sdk.loadCollection).toHaveBeenCalledWith({ collection_name: "docs" });
  });
});

describe("MilvusClientWrapper.listCollections", () => {
  it("returns collection names", async () => {
    const sdk = createFakeSdkClient({
      showCollections: vi.fn(async () => ({ data: [{ name: "docs" }, { name: "notes" }] })),
    });
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const names = await wrapper.listCollections();
    expect(names).toEqual(["docs", "notes"]);
  });

  it("returns an empty array when the sdk response has no data", async () => {
    const sdk = createFakeSdkClient({ showCollections: vi.fn(async () => ({})) });
    const wrapper = new MilvusClientWrapper(connection, sdk);
    const names = await wrapper.listCollections();
    expect(names).toEqual([]);
  });
});
