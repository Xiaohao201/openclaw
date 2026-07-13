import { describe, expect, it, vi } from "vitest";
import type { MilvusEmbeddingConfig } from "../config.js";
import { Embeddings, type EmbeddingsClient } from "./embeddings.js";

function createFakeClient(embeddingFor: (input: string) => number[]): EmbeddingsClient {
  return {
    embeddings: {
      create: vi.fn(async (params: { input: string | string[] }) => {
        const inputs = Array.isArray(params.input) ? params.input : [params.input];
        return { data: inputs.map((text) => ({ embedding: embeddingFor(text) })) };
      }),
    },
  };
}

const config: MilvusEmbeddingConfig = {
  apiKey: "sk-test",
  model: "text-embedding-3-small",
  dimensions: 1536,
  sendDimensions: true,
};

describe("Embeddings", () => {
  it("embeds a single text", async () => {
    const client = createFakeClient((text) => [text.length, 0, 0]);
    const embeddings = new Embeddings(config, client);
    const vector = await embeddings.embed("hello");
    expect(vector).toEqual([5, 0, 0]);
  });

  it("embeds a batch of texts in one call", async () => {
    const client = createFakeClient((text) => [text.length]);
    const embeddings = new Embeddings(config, client);
    const vectors = await embeddings.embedBatch(["a", "bb", "ccc"]);
    expect(vectors).toEqual([[1], [2], [3]]);
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty batch without calling the client", async () => {
    const client = createFakeClient(() => [0]);
    const embeddings = new Embeddings(config, client);
    const vectors = await embeddings.embedBatch([]);
    expect(vectors).toEqual([]);
    expect(client.embeddings.create).not.toHaveBeenCalled();
  });

  it("passes dimensions through to the embeddings call", async () => {
    const client = createFakeClient(() => [1, 2, 3]);
    const embeddings = new Embeddings(config, client);
    await embeddings.embed("hi");
    expect(client.embeddings.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", dimensions: 1536 }),
    );
  });

  it("omits dimensions when sendDimensions is false", async () => {
    const client = createFakeClient(() => [1, 2, 3]);
    const embeddings = new Embeddings({ ...config, sendDimensions: false }, client);
    await embeddings.embed("hi");
    const params = (client.embeddings.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params).not.toHaveProperty("dimensions");
  });
});
