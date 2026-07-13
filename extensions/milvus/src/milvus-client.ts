import { DataType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import type { MilvusConnectionConfig } from "../config.js";
import type {
  MilvusDeleteOptions,
  MilvusMetadata,
  MilvusRow,
  MilvusSearchMatch,
  MilvusSearchOptions,
} from "./types.js";

const VECTOR_FIELD = "vector";
const TEXT_FIELD = "text";
const METADATA_FIELD = "metadata";
const ID_FIELD = "id";

export type MilvusSdkClient = {
  hasCollection(params: { collection_name: string }): Promise<{ value: boolean }>;
  createCollection(params: {
    collection_name: string;
    fields: unknown[];
    enable_dynamic_field?: boolean;
  }): Promise<unknown>;
  createIndex(params: {
    collection_name: string;
    field_name: string;
    index_type?: string;
    metric_type?: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
  loadCollection(params: { collection_name: string }): Promise<unknown>;
  insert(params: {
    collection_name: string;
    data: Record<string, unknown>[];
  }): Promise<{ IDs?: unknown }>;
  search(params: {
    collection_name: string;
    data: number[][];
    limit: number;
    filter?: string;
    output_fields?: string[];
  }): Promise<{
    results: Array<{ id: string | number; score: number } & Record<string, unknown>>;
  }>;
  delete(params: {
    collection_name: string;
    ids?: Array<string | number>;
    filter?: string;
  }): Promise<unknown>;
  showCollections(): Promise<{ data?: Array<{ name: string }> }>;
};

function createSdkClient(config: MilvusConnectionConfig): MilvusSdkClient {
  return new MilvusClient({
    address: config.address,
    token: config.token,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    database: config.database,
  }) as unknown as MilvusSdkClient;
}

function parseMetadata(raw: unknown): MilvusMetadata | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "object") {
    return raw as MilvusMetadata;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw) as MilvusMetadata;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class MilvusClientWrapper {
  private readonly client: MilvusSdkClient;
  private readonly ensuredCollections = new Set<string>();

  constructor(config: MilvusConnectionConfig, client?: MilvusSdkClient) {
    this.client = client ?? createSdkClient(config);
  }

  async ensureCollection(collectionName: string, dim: number): Promise<void> {
    if (this.ensuredCollections.has(collectionName)) {
      return;
    }
    const exists = await this.client.hasCollection({ collection_name: collectionName });
    if (!exists.value) {
      await this.client.createCollection({
        collection_name: collectionName,
        fields: [
          {
            name: ID_FIELD,
            data_type: DataType.Int64,
            is_primary_key: true,
            autoID: true,
          },
          {
            name: VECTOR_FIELD,
            data_type: DataType.FloatVector,
            dim,
          },
          {
            name: TEXT_FIELD,
            data_type: DataType.VarChar,
            max_length: 65535,
          },
          {
            name: METADATA_FIELD,
            data_type: DataType.JSON,
          },
        ],
      });
      await this.client.createIndex({
        collection_name: collectionName,
        field_name: VECTOR_FIELD,
        index_type: "AUTOINDEX",
        metric_type: "COSINE",
      });
    }
    await this.client.loadCollection({ collection_name: collectionName });
    this.ensuredCollections.add(collectionName);
  }

  async upsert(collectionName: string, rows: MilvusRow[], dim: number): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    await this.ensureCollection(collectionName, dim);
    await this.client.insert({
      collection_name: collectionName,
      data: rows.map((row) => ({
        [VECTOR_FIELD]: row.vector,
        [TEXT_FIELD]: row.text,
        [METADATA_FIELD]: row.metadata ?? {},
      })),
    });
    return rows.length;
  }

  async search(
    collectionName: string,
    vector: number[],
    options: MilvusSearchOptions,
  ): Promise<MilvusSearchMatch[]> {
    const exists = await this.client.hasCollection({ collection_name: collectionName });
    if (!exists.value) {
      return [];
    }
    const response = await this.client.search({
      collection_name: collectionName,
      data: [vector],
      limit: options.topK,
      filter: options.filter,
      output_fields: options.outputFields ?? [TEXT_FIELD, METADATA_FIELD],
    });
    return response.results.map((item) => ({
      id: item.id,
      score: item.score,
      text: typeof item[TEXT_FIELD] === "string" ? item[TEXT_FIELD] : "",
      metadata: parseMetadata(item[METADATA_FIELD]),
    }));
  }

  async deleteEntries(collectionName: string, options: MilvusDeleteOptions): Promise<void> {
    if (!options.ids?.length && !options.filter) {
      throw new Error("delete requires at least one of ids or filter");
    }
    await this.client.delete({
      collection_name: collectionName,
      ids: options.ids,
      filter: options.filter,
    });
  }

  async listCollections(): Promise<string[]> {
    const response = await this.client.showCollections();
    return (response.data ?? []).map((collection) => collection.name);
  }
}
