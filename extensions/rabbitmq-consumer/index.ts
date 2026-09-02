import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { processChatMessage, resolveTurnTimeoutMs, warmupAgent } from "./src/chat-pipeline.js";
import { createCollaborationHistoryToolFactory } from "./src/collaboration-history-tool.js";
import { DownloadManager } from "./src/download-manager.js";
import { FeedCounter } from "./src/feed-counter.js";
import { HistoryManager } from "./src/history-manager.js";
import {
  collectLocalDebugUsage,
  createLocalDebugExecutor,
  createLocalDebugHttpHandler,
  createLocalDebugRunner,
} from "./src/local-debug.js";
import { createMessageConsumer } from "./src/message-consumer.js";
import { RabbitMqClient } from "./src/rabbitmq-client.js";
import { ReportTaskPublisher } from "./src/report-task-publisher.js";
import { ReportTemplateLookup } from "./src/report-template-lookup.js";
import { SkillLookup } from "./src/skill-lookup.js";
import { TopicResolver } from "./src/topic-resolver.js";
import type { RabbitMqPluginConfig, WriterDbConfig } from "./src/types.js";
import { resolveUsageCurrencyPolicy } from "./src/usage-pricing.js";
import { createVideoLinkParseToolFactory } from "./src/video-link-parse-tool.js";

/** Clamp the cross-session concurrency window to a sane range. */
const DEFAULT_PREFETCH = 6;

function clampPrefetch(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PREFETCH;
  }
  return Math.min(32, Math.max(1, Math.floor(value)));
}

/**
 * Resolve plugin config from the plugin config object, with env var fallbacks.
 */
function resolvePluginConfig(pluginConfig: Record<string, unknown>): RabbitMqPluginConfig {
  const rabbitmq = pluginConfig.rabbitmq as Record<string, unknown> | undefined;
  const historyDb = pluginConfig.historyDb as Record<string, unknown> | undefined;
  const mercure = pluginConfig.mercure as Record<string, unknown> | undefined;
  const chat = pluginConfig.chat as Record<string, unknown> | undefined;

  return {
    rabbitmq: {
      host: (rabbitmq?.host as string) ?? process.env.RABBITMQ_HOST ?? "127.0.0.1",
      port: Number(rabbitmq?.port ?? process.env.RABBITMQ_PORT ?? 5672),
      user: (rabbitmq?.user as string) ?? process.env.RABBITMQ_USER ?? "",
      password: (rabbitmq?.password as string) ?? process.env.RABBITMQ_PASSWORD ?? "",
      queue: (rabbitmq?.queue as string) ?? process.env.RABBITMQ_QUEUE ?? "MessageProxy",
      prefetch: clampPrefetch(
        Number(rabbitmq?.prefetch ?? process.env.RABBITMQ_PREFETCH ?? DEFAULT_PREFETCH),
      ),
      reportTaskQueue:
        (rabbitmq?.reportTaskQueue as string) ??
        process.env.RABBITMQ_REPORT_TASK_QUEUE ??
        "ReportTask",
    },
    historyDb: {
      host: (historyDb?.host as string) ?? process.env.HISTORY_MYSQL_HOST ?? "127.0.0.1",
      port: Number(historyDb?.port ?? process.env.HISTORY_MYSQL_PORT ?? 3306),
      user: (historyDb?.user as string) ?? process.env.HISTORY_MYSQL_USER ?? "",
      password: (historyDb?.password as string) ?? process.env.HISTORY_MYSQL_PASSWORD ?? "",
      database:
        (historyDb?.database as string) ?? process.env.HISTORY_MYSQL_DATABASE ?? "superworker",
    },
    mercure: {
      hubUrl: (mercure?.hubUrl as string) ?? process.env.MERCURE_HUB_URL ?? "",
      jwtSecret: (mercure?.jwtSecret as string) ?? process.env.MERCURE_JWT_SECRET ?? "",
    },
    chat: {
      // Configured in seconds for operator readability; the pipeline clamps the
      // resulting millisecond value into its supported window.
      turnTimeoutMs: resolveTurnTimeoutMs(
        Number(chat?.turnTimeoutSeconds ?? process.env.CHAT_TURN_TIMEOUT_SECONDS ?? 0) * 1000,
      ),
    },
  };
}

/**
 * Resolve writer DB config from the plugin config object, with env var fallbacks.
 * Returns undefined when no dedicated writer is configured (falls back to reader).
 */
function resolveWriterConfig(pluginConfig: Record<string, unknown>): WriterDbConfig | undefined {
  const writerDb = pluginConfig.writerDb as Record<string, unknown> | undefined;
  const envUser = process.env.WRITER_MYSQL_USER;
  const envPassword = process.env.WRITER_MYSQL_PASSWORD;
  if (!writerDb && !envUser && !envPassword) {
    return undefined;
  }
  return {
    host:
      (writerDb?.host as string) ??
      process.env.WRITER_MYSQL_HOST ??
      process.env.HISTORY_MYSQL_HOST ??
      "127.0.0.1",
    port: Number(
      writerDb?.port ?? process.env.WRITER_MYSQL_PORT ?? process.env.HISTORY_MYSQL_PORT ?? 3306,
    ),
    user: (writerDb?.user as string) ?? envUser ?? "",
    password: (writerDb?.password as string) ?? envPassword ?? "",
    database:
      (writerDb?.database as string) ??
      process.env.WRITER_MYSQL_DATABASE ??
      process.env.HISTORY_MYSQL_DATABASE ??
      "superworker",
  };
}

/** Module-level references for service lifecycle management (avoids mutating the api object). */
let clientRef: RabbitMqClient | undefined;
let historyRef: HistoryManager | undefined;
let downloadRef: DownloadManager | undefined;
let topicResolverRef: TopicResolver | undefined;
let feedCounterRef: FeedCounter | undefined;
let reportPublisherRef: ReportTaskPublisher | undefined;
let templateLookupRef: ReportTemplateLookup | undefined;
let skillLookupRef: SkillLookup | undefined;

export default definePluginEntry({
  id: "rabbitmq-consumer",
  name: "RabbitMQ Consumer",
  description: "Consume chat messages from RabbitMQ and process them via OpenClaw subagent.",
  register(api: OpenClawPluginApi) {
    api.registerTool(createVideoLinkParseToolFactory(api), { name: "video_link_parse" });
    api.registerTool(
      createCollaborationHistoryToolFactory({
        getStore: () => historyRef,
        logger: api.logger,
      }),
      { name: "collaboration_history_query", optional: true },
    );

    const localDebug = api.pluginConfig?.localDebug as
      | { enabled?: unknown; historyTable?: unknown }
      | undefined;
    let prepareLocalDebugHistory: (() => Promise<void>) | undefined;
    if (localDebug?.enabled === true) {
      const pluginConfig = resolvePluginConfig(api.pluginConfig as Record<string, unknown>);
      const writerConfig = resolveWriterConfig(api.pluginConfig as Record<string, unknown>);
      const debugSkillLookup =
        pluginConfig.historyDb.host && pluginConfig.historyDb.user
          ? new SkillLookup(pluginConfig.historyDb)
          : undefined;
      const debugHistoryManager =
        pluginConfig.historyDb.host && pluginConfig.historyDb.user
          ? new HistoryManager(
              pluginConfig.historyDb,
              writerConfig,
              typeof localDebug.historyTable === "string"
                ? localDebug.historyTable
                : "history_test",
            )
          : undefined;
      let historyReady: Promise<void> | undefined;
      if (debugHistoryManager) {
        historyRef = debugHistoryManager;
        prepareLocalDebugHistory = () => {
          historyReady ??= debugHistoryManager
            .ensureTableLike("history_messages")
            .catch((error) => {
              historyReady = undefined;
              throw error;
            });
          return historyReady;
        };
      }
      skillLookupRef = debugSkillLookup;
      const run = createLocalDebugExecutor(
        createLocalDebugRunner({
          runtime: api.runtime,
          config: api.config,
          logger: api.logger,
          skillLookup: debugSkillLookup,
          historyManager: debugHistoryManager,
          prepareHistory: prepareLocalDebugHistory,
          collectUsage: collectLocalDebugUsage,
        }),
      );
      const handler = createLocalDebugHttpHandler({
        run,
        logger: api.logger,
        listSkills: debugSkillLookup
          ? async (userId) => await debugSkillLookup.listForUser(userId, api.logger)
          : undefined,
      });
      api.registerHttpRoute({
        path: "/plugins/rabbitmq-consumer/debug",
        auth: "plugin",
        match: "exact",
        handler,
      });
      api.registerHttpRoute({
        path: "/plugins/rabbitmq-consumer/debug/run",
        auth: "plugin",
        match: "exact",
        handler,
      });
      api.registerHttpRoute({
        path: "/plugins/rabbitmq-consumer/debug/skills",
        auth: "plugin",
        match: "exact",
        handler,
      });
      api.logger.info(
        `[RABBITMQ_LOCAL_DEBUG] Registered loopback-only debug page ` +
          `(MySQL skills ${debugSkillLookup ? "read-only" : "unavailable"})`,
      );
    }

    api.registerService({
      id: "rabbitmq-consumer",

      async start(ctx) {
        if (localDebug?.enabled === true) {
          await prepareLocalDebugHistory?.();
          ctx.logger.info(
            "[RABBITMQ_LOCAL_DEBUG] Using existing data connections with history isolated to history_test and RabbitMQ queue set to MessageTest",
          );
          return;
        }

        const pluginConfig = resolvePluginConfig(api.pluginConfig as Record<string, unknown>);

        if (!pluginConfig.rabbitmq.user || !pluginConfig.rabbitmq.host) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing RabbitMQ config, service not started");
          return;
        }
        if (!pluginConfig.historyDb.user || !pluginConfig.historyDb.host) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing historyDb config, service not started");
          return;
        }
        if (!pluginConfig.mercure.hubUrl) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing Mercure config, service not started");
          return;
        }

        const turnWaitWindowSeconds = Math.round(pluginConfig.chat.turnTimeoutMs / 1000);
        ctx.logger.info(
          `[RABBITMQ_CONSUMER] Chat wait window ${turnWaitWindowSeconds}s with no plugin deadline ` +
            `(prefetch=${pluginConfig.rabbitmq.prefetch})`,
        );

        // Per-turn token/cost accounting: providers quote their unit prices in
        // different currencies, so this folds them into one before storage.
        const usageCurrency = resolveUsageCurrencyPolicy(
          api.pluginConfig as Record<string, unknown>,
        );
        ctx.logger.info(
          `[RABBITMQ_CONSUMER] Usage accounting in ${usageCurrency.currency} ` +
            `(rate=${usageCurrency.rate} for ${usageCurrency.foreignProviders.join(",")})`,
        );

        // Shared HistoryManager across messages (pool reuse)
        const writerConfig = resolveWriterConfig(api.pluginConfig as Record<string, unknown>);
        historyRef = new HistoryManager(pluginConfig.historyDb, writerConfig);
        downloadRef = new DownloadManager(pluginConfig.historyDb, writerConfig);
        topicResolverRef = new TopicResolver(pluginConfig.historyDb);
        feedCounterRef = new FeedCounter(pluginConfig.historyDb);
        templateLookupRef = new ReportTemplateLookup(pluginConfig.historyDb);
        skillLookupRef = new SkillLookup(pluginConfig.historyDb);
        reportPublisherRef = new ReportTaskPublisher(
          {
            host: pluginConfig.rabbitmq.host,
            port: pluginConfig.rabbitmq.port,
            user: pluginConfig.rabbitmq.user,
            password: pluginConfig.rabbitmq.password,
            queue: pluginConfig.rabbitmq.reportTaskQueue,
          },
          ctx.logger,
        );

        // Per-session serialization lives in the consumer (see message-consumer.ts):
        // with prefetch > 1 different windows run concurrently while messages
        // inside one conversation stay strictly ordered.
        const client = new RabbitMqClient(
          pluginConfig.rabbitmq,
          ctx.logger,
          createMessageConsumer({
            logger: ctx.logger,
            runWarmup: (userId) => warmupAgent(userId, api.runtime, ctx.logger),
            runChat: (chatMsg) =>
              processChatMessage(
                chatMsg,
                historyRef!,
                pluginConfig.mercure,
                api.runtime,
                ctx.logger,
                downloadRef,
                topicResolverRef,
                feedCounterRef,
                reportPublisherRef,
                templateLookupRef,
                skillLookupRef,
                api.config,
                usageCurrency,
                { turnTimeoutMs: pluginConfig.chat.turnTimeoutMs },
              ),
          }),
        );

        clientRef = client;

        client.start().catch((err) => {
          ctx.logger.error(`[RABBITMQ_CONSUMER] Fatal error: ${err}`);
        });
      },

      async stop(ctx) {
        if (clientRef) {
          await clientRef.stop();
          clientRef = undefined;
        }
        if (historyRef) {
          await historyRef.close();
          historyRef = undefined;
        }
        if (downloadRef) {
          await downloadRef.close();
          downloadRef = undefined;
        }
        if (topicResolverRef) {
          await topicResolverRef.close();
          topicResolverRef = undefined;
        }
        if (feedCounterRef) {
          await feedCounterRef.close();
          feedCounterRef = undefined;
        }
        if (reportPublisherRef) {
          await reportPublisherRef.close();
          reportPublisherRef = undefined;
        }
        if (templateLookupRef) {
          await templateLookupRef.close();
          templateLookupRef = undefined;
        }
        if (skillLookupRef) {
          await skillLookupRef.close();
          skillLookupRef = undefined;
        }
        ctx.logger.info("[RABBITMQ_CONSUMER] Service stopped");
      },
    });
  },
});
