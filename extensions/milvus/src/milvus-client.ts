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
  closeConnection?(): Promise<unknown>;
};

/** gRPC status codes that mean "server unreachable/too slow", not "bad request". */
const CONNECTION_GRPC_STATUS_CODES = new Set([4, 14]);
const CONNECTION_MESSAGE_RE = /DEADLINE_EXCEEDED|UNAVAILABLE|deadline exceeded|no connection/i;

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && CONNECTION_GRPC_STATUS_CODES.has(code)) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && CONNECTION_MESSAGE_RE.test(message);
}

function createSdkClient(config: MilvusConnectionConfig): MilvusSdkClient {
  const client = new MilvusClient({
    address: config.address,
    token: config.token,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    database: config.database,
  });
  // The SDK fires a `Connect` RPC from its constructor and parks the promise on
  // `connectPromise`; nothing awaits it until the first request. An unreachable or slow
  // server therefore surfaces as an unhandled rejection that can take the process down.
  // Mark it handled here — real failures still reach callers via the awaited request,
  // which also awaits this same promise.
  (client as unknown as { connectPromise?: Promise<unknown> }).connectPromise?.catch(() => {});
  return client as unknown as MilvusSdkClient;
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
  private readonly config: MilvusConnectionConfig;
  private readonly injectedClient?: MilvusSdkClient;
  private activeClient?: MilvusSdkClient;
  private readonly ensuredCollections = new Set<string>();

  constructor(config: MilvusConnectionConfig, client?: MilvusSdkClient) {
    this.config = config;
    this.injectedClient = client;
  }

  private getClient(): MilvusSdkClient {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    if (!this.activeClient) {
      this.activeClient = createSdkClient(this.config);
    }
    return this.activeClient;
  }

  /**
   * Runs an SDK call, discarding the cached client on connection failures. The SDK never
   * retries its initial `Connect`, so a client created while Milvus was down would stay
   * broken forever; dropping it lets the next call reconnect.
   */
  private async call<T>(fn: (client: MilvusSdkClient) => Promise<T>): Promise<T> {
    const client = this.getClient();
    try {
      return await fn(client);
    } catch (err) {
      if (!this.injectedClient && this.activeClient === client && isConnectionError(err)) {
        this.activeClient = undefined;
        this.ensuredCollections.clear();
        void client.closeConnection?.().catch(() => {});
      }
      throw err;
    }
  }

  async ensureCollection(collectionName: string, dim: number): Promise<void> {
    if (this.ensuredCollections.has(collectionName)) {
      return;
    }
    const exists = await this.call((client) =>
      client.hasCollection({ collection_name: collectionName }),
    );
    if (!exists.value) {
      await this.call((client) =>
        client.createCollection({
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
        }),
      );
      await this.call((client) =>
        client.createIndex({
          collection_name: collectionName,
          field_name: VECTOR_FIELD,
          index_type: "AUTOINDEX",
          metric_type: "COSINE",
        }),
      );
    }
    await this.call((client) => client.loadCollection({ collection_name: collectionName }));
    this.ensuredCollections.add(collectionName);
  }

  async upsert(collectionName: string, rows: MilvusRow[], dim: number): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    await this.ensureCollection(collectionName, dim);
    await this.call((client) =>
      client.insert({
        collection_name: collectionName,
        data: rows.map((row) => ({
          [VECTOR_FIELD]: row.vector,
          [TEXT_FIELD]: row.text,
          [METADATA_FIELD]: row.metadata ?? {},
        })),
      }),
    );
    return rows.length;
  }

  async search(
    collectionName: string,
    vector: number[],
    options: MilvusSearchOptions,
  ): Promise<MilvusSearchMatch[]> {
    const exists = await this.call((client) =>
      client.hasCollection({ collection_name: collectionName }),
    );
    if (!exists.value) {
      return [];
    }
    const response = await this.call((client) =>
      client.search({
        collection_name: collectionName,
        data: [vector],
        limit: options.topK,
        filter: options.filter,
        output_fields: options.outputFields ?? [TEXT_FIELD, METADATA_FIELD],
      }),
    );
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
    await this.call((client) =>
      client.delete({
        collection_name: collectionName,
        ids: options.ids,
        filter: options.filter,
      }),
    );
  }

  async listCollections(): Promise<string[]> {
    const response = await this.call((client) => client.showCollections());
    return (response.data ?? []).map((collection) => collection.name);
  }
}
