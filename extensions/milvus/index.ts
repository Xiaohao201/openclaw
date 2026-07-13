import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { DEFAULT_EMBEDDING_PROFILE, milvusConfigSchema } from "./config.js";
import { Embeddings } from "./src/embeddings.js";
import { MilvusClientWrapper } from "./src/milvus-client.js";
import {
  createMilvusDeleteToolFactory,
  createMilvusListCollectionsToolFactory,
  createMilvusSearchToolFactory,
  createMilvusUpsertToolFactory,
} from "./src/milvus-tools.js";

export default definePluginEntry({
  id: "milvus",
  name: "Milvus Vector Database",
  description:
    "General-purpose vector-database tools: semantic upsert/search/delete against a Milvus server, " +
    "embedding text via any OpenAI-compatible embeddings API.",
  register(api: OpenClawPluginApi) {
    const config = milvusConfigSchema.parse(api.pluginConfig);
    const embeddings: Record<string, Embeddings> = {
      [DEFAULT_EMBEDDING_PROFILE]: new Embeddings(config.embedding),
      ...Object.fromEntries(
        Object.entries(config.embeddingProfiles).map(([name, profileConfig]) => [
          name,
          new Embeddings(profileConfig),
        ]),
      ),
    };
    const client = new MilvusClientWrapper(config.connection);
    const deps = { client, embeddings, config };

    api.registerTool(createMilvusUpsertToolFactory(deps), { name: "milvus_upsert" });
    api.registerTool(createMilvusSearchToolFactory(deps), { name: "milvus_search" });
    api.registerTool(createMilvusDeleteToolFactory(deps), { name: "milvus_delete" });
    api.registerTool(createMilvusListCollectionsToolFactory(deps), {
      name: "milvus_list_collections",
    });

    api.registerService({
      id: "milvus",
      start(ctx) {
        ctx.logger.info(`[MILVUS] configured for ${config.connection.address}`);
      },
      stop(ctx) {
        ctx.logger.info("[MILVUS] service stopped");
      },
    });
  },
});
