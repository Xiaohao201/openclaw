export type MilvusMetadata = Record<string, unknown>;

export type MilvusRow = {
  text: string;
  vector: number[];
  metadata?: MilvusMetadata;
};

export type MilvusSearchMatch = {
  id: string | number;
  score: number;
  text: string;
  metadata?: MilvusMetadata;
};

export type MilvusSearchOptions = {
  topK: number;
  filter?: string;
  /** Fields to request from Milvus. Defaults to ["text", "metadata"] — override for collections without a metadata column. */
  outputFields?: string[];
};

export type MilvusDeleteOptions = {
  ids?: Array<string | number>;
  filter?: string;
};
