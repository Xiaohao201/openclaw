import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLLECTION, milvusConfigSchema } from "./config.js";

describe("milvus config", () => {
  const validConfig = {
    connection: { address: "localhost:19530" },
    embedding: { apiKey: "sk-test" },
  };

  it("parses a minimal valid config with defaults", () => {
    const parsed = milvusConfigSchema.parse(validConfig);
    expect(parsed.connection.address).toBe("localhost:19530");
    expect(parsed.embedding.model).toBe("text-embedding-3-small");
    expect(parsed.embedding.dimensions).toBe(1536);
    expect(parsed.embedding.sendDimensions).toBe(true);
    expect(parsed.embeddingProfiles).toEqual({});
    expect(parsed.readOnlyCollections).toEqual([]);
    expect(parsed.defaultCollection).toBe(DEFAULT_COLLECTION);
  });

  it("rejects a missing connection.address", () => {
    expect(() => {
      milvusConfigSchema.parse({ embedding: { apiKey: "sk-test" } });
    }).toThrow("connection.address is required");
  });

  it("rejects a missing embedding.apiKey", () => {
    expect(() => {
      milvusConfigSchema.parse({ connection: { address: "localhost:19530" } });
    }).toThrow("embedding.apiKey is required");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => {
      milvusConfigSchema.parse({ ...validConfig, unexpected: true });
    }).toThrow("milvus config has unknown keys: unexpected");
  });

  it("rejects unknown connection keys", () => {
    expect(() => {
      milvusConfigSchema.parse({
        connection: { address: "localhost:19530", extra: true },
        embedding: { apiKey: "sk-test" },
      });
    }).toThrow("connection config has unknown keys: extra");
  });

  it("requires explicit dimensions for unrecognized models", () => {
    expect(() => {
      milvusConfigSchema.parse({
        connection: { address: "localhost:19530" },
        embedding: { apiKey: "sk-test", model: "custom-model" },
      });
    }).toThrow('Unsupported embedding model "custom-model"');
  });

  it("accepts explicit dimensions for unrecognized models", () => {
    const parsed = milvusConfigSchema.parse({
      connection: { address: "localhost:19530" },
      embedding: { apiKey: "sk-test", model: "custom-model", dimensions: 768 },
    });
    expect(parsed.embedding.dimensions).toBe(768);
  });

  it("falls back to the default collection when defaultCollection is blank", () => {
    const parsed = milvusConfigSchema.parse({ ...validConfig, defaultCollection: "  " });
    expect(parsed.defaultCollection).toBe(DEFAULT_COLLECTION);
  });

  describe("embeddingProfiles", () => {
    it("parses named profiles alongside the default embedding config", () => {
      const parsed = milvusConfigSchema.parse({
        ...validConfig,
        embeddingProfiles: {
          doubao: { apiKey: "ark-key", model: "ep-test", dimensions: 4096, sendDimensions: false },
        },
      });
      expect(parsed.embeddingProfiles.doubao).toMatchObject({
        apiKey: "ark-key",
        model: "ep-test",
        dimensions: 4096,
        sendDimensions: false,
      });
      // The default profile is untouched.
      expect(parsed.embedding.sendDimensions).toBe(true);
    });

    it("defaults sendDimensions to true within a profile", () => {
      const parsed = milvusConfigSchema.parse({
        ...validConfig,
        embeddingProfiles: { extra: { apiKey: "k", model: "custom", dimensions: 8 } },
      });
      expect(parsed.embeddingProfiles.extra.sendDimensions).toBe(true);
    });

    it("rejects a profile name with invalid characters", () => {
      expect(() => {
        milvusConfigSchema.parse({
          ...validConfig,
          embeddingProfiles: { "bad name!": { apiKey: "k", model: "custom", dimensions: 8 } },
        });
      }).toThrow('embeddingProfiles key "bad name!" must match');
    });

    it("rejects unknown keys within a profile", () => {
      expect(() => {
        milvusConfigSchema.parse({
          ...validConfig,
          embeddingProfiles: { doubao: { apiKey: "k", model: "custom", dimensions: 8, extra: 1 } },
        });
      }).toThrow("embeddingProfiles.doubao has unknown keys: extra");
    });
  });

  describe("readOnlyCollections", () => {
    it("parses a list of read-only collection names", () => {
      const parsed = milvusConfigSchema.parse({
        ...validConfig,
        readOnlyCollections: ["DailyRiskTips", " Disposal_Judge "],
      });
      expect(parsed.readOnlyCollections).toEqual(["DailyRiskTips", "Disposal_Judge"]);
    });

    it("rejects a non-array readOnlyCollections", () => {
      expect(() => {
        milvusConfigSchema.parse({ ...validConfig, readOnlyCollections: "DailyRiskTips" });
      }).toThrow("readOnlyCollections must be an array of strings");
    });
  });

  describe("${ENV_VAR} resolution", () => {
    const ORIGINAL = process.env.MILVUS_TEST_TOKEN;

    beforeEach(() => {
      process.env.MILVUS_TEST_TOKEN = "resolved-token";
    });

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.MILVUS_TEST_TOKEN;
      } else {
        process.env.MILVUS_TEST_TOKEN = ORIGINAL;
      }
    });

    it("resolves ${ENV_VAR} placeholders in secrets", () => {
      const parsed = milvusConfigSchema.parse({
        connection: { address: "localhost:19530", token: "${MILVUS_TEST_TOKEN}" },
        embedding: { apiKey: "sk-test" },
      });
      expect(parsed.connection.token).toBe("resolved-token");
    });

    it("throws when a referenced env var is not set", () => {
      expect(() => {
        milvusConfigSchema.parse({
          connection: { address: "localhost:19530" },
          embedding: { apiKey: "${MISSING_MILVUS_ENV_VAR}" },
        });
      }).toThrow("Environment variable MISSING_MILVUS_ENV_VAR is not set");
    });
  });
});
