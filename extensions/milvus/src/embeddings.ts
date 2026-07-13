import OpenAI from "openai";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import type { MilvusEmbeddingConfig } from "../config.js";

export type EmbeddingsClient = {
  embeddings: {
    create(params: {
      model: string;
      input: string | string[];
      dimensions?: number;
    }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
};

export class Embeddings {
  private readonly client: EmbeddingsClient;
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly sendDimensions: boolean;

  constructor(config: MilvusEmbeddingConfig, client?: EmbeddingsClient) {
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.sendDimensions = config.sendDimensions;
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const params: { model: string; input: string[]; dimensions?: number } = {
      model: this.model,
      input: texts,
    };
    if (this.dimensions && this.sendDimensions) {
      params.dimensions = this.dimensions;
    }
    ensureGlobalUndiciEnvProxyDispatcher();
    const response = await this.client.embeddings.create(params);
    return response.data.map((item) => item.embedding);
  }
}
