import { ArtifactLinks } from "../../../api.js";
import { agentIdFromSessionKey } from "../../client/agent-id.js";
import { asString } from "../../client/envelope.js";
import { insertHistoryRow, sessionIdFromKey } from "../../notify/history-row.js";
import { collectTurnUsage, formatUsage, markUsageOutcome } from "../../notify/usage.js";
import type { TurnUsageRecord } from "../../notify/usage.js";
import type { ScheduledTask } from "../types.js";
import type { ActionRunnerDeps, ScheduleActionType } from "./types.js";

const MAX_INSTRUCTION = 2000;
const WAIT_WINDOW_MS = 30_000;
const EXECUTION_TIMEOUT_MS = 15 * 60_000;

/** A wait/RPC timeout is not a model termination. Never release capacity on uncertainty. */
async function waitUntilSettled(
  subagent: NonNullable<ActionRunnerDeps["subagent"]>,
  runId: string,
  taskId: string,
  logger: import("../../../api.js").PluginLogger,
  control: {
    sessionKey: string;
    deadline: number;
    signal?: AbortSignal;
    abortRun?: ActionRunnerDeps["abortRun"];
  },
) {
  let stopped: "cancelled" | "execution_timeout" | undefined;
  while (true) {
    const started = Date.now();
    stopped ??= control.signal?.aborted
      ? "cancelled"
      : started >= control.deadline
        ? "execution_timeout"
        : undefined;
    if (stopped) {
      try {
        const accepted = await control.abortRun?.(control.sessionKey);
        logger.warn(
          `[LEADING_V2_SCHED] task ${taskId} run ${runId} ${stopped}; abort accepted=${accepted === true}; retaining capacity until settled`,
        );
      } catch (error) {
        logger.warn(`[LEADING_V2_SCHED] task ${taskId} abort failed: ${String(error)}`);
      }
    }
    try {
      const result = await subagent.waitForRun({ runId, timeoutMs: WAIT_WINDOW_MS });
      if (
        result.status !== "timeout" ||
        (typeof result.endedAt === "number" && Number.isFinite(result.endedAt))
      ) {
        return { result, stopped };
      }
      logger.info(
        `[LEADING_V2_SCHED] task ${taskId} run ${runId} still running; retaining capacity`,
      );
    } catch (error) {
      logger.warn(
        `[LEADING_V2_SCHED] task ${taskId} run ${runId} settlement unknown; retaining capacity: ${String(error)}`,
      );
    }
    // Cached timeouts and disconnected RPCs can return immediately; avoid a hot loop.
    const delay = Math.max(0, WAIT_WINDOW_MS - (Date.now() - started));
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Last assistant turn's text — content is a string in simple sessions, an array of
 * content blocks in tool-using ones; extract text so delivery always gets a string. */
function lastAssistantText(messages: unknown[]): string {
  for (const msg of messages.toReversed()) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "assistant") {
      continue;
    }
    const c = m.content;
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
    if (Array.isArray(c)) {
      const text = c
        .map((b) => (b as { text?: string }).text ?? "")
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/**
 * 通用智能体任务: the universal scheduled action. When it fires, the user's agent runs
 * a natural-language instruction in a derived, isolated session (sessionKey + ":sched"
 * so a scheduled turn never collides with a live chat turn) and the assistant's reply
 * is delivered through the same Notifier transports (Mercure / history / email).
 *
 * This covers reminders, greetings, scheduled pushes, and any "智脑"-style task — the
 * scheduled agent has the full chat toolset, so it can call opinion_* and other task tools
 * etc. and report the result itself, with no per-action runner needed.
 */
export const agentPromptAction: ScheduleActionType = {
  name: "agent_prompt",
  tool: "agent_prompt",
  label: "智能体任务",
  summary:
    "通用智能体任务：到点让助手执行一段自然语言指令，并把助手的回复发给用户。" +
    "用于提醒、打招呼、定时推送，或任何需要助手思考/调用其它工具才能完成的任务。" +
    "params: { instruction: string 要执行的指令，例如 '生成今天的舆情摘要并发给用户' }。",
  validate(params) {
    const instruction = asString(params.instruction)?.trim();
    if (!instruction) {
      return { ok: false, error: "agent_prompt 需要 instruction(要执行的自然语言指令)。" };
    }
    return { ok: true, params: { instruction: instruction.slice(0, MAX_INSTRUCTION) } };
  },
  makeRunner(deps) {
    return async (task: ScheduledTask, execution) => {
      const { subagent, deliver, logger, usagePolicy, appConfig } = deps;
      if (!subagent) {
        return { ok: false, note: "subagent runtime unavailable" };
      }
      const instruction = asString(task.action.params.instruction);
      if (!instruction) {
        return { ok: false, note: "missing instruction" };
      }
      // Derived session: keeps scheduled turns off the user's live chat session.
      const sessionKey = `${task.sessionKey}:sched`;
      const firedAt = Date.now();
      // Token/cost accounting window. A scheduled run bills the same as a chat
      // turn — it is a full agent turn with the full toolset — but no chat
      // pipeline is watching it, so this action bills itself. Opened BEFORE the
      // run so every assistant entry appended from here on belongs to this fire
      // and the previous fire's entries (same session) stay out.
      const billing = usagePolicy
        ? {
            sessionKey,
            agentId: agentIdFromSessionKey(task.sessionKey, task.uid),
            sinceMs: firedAt,
            policy: usagePolicy,
            config: appConfig,
            logger,
          }
        : undefined;
      /**
       * A fire that spent tokens but produced nothing to deliver still has to
       * be billed — the tokens are gone either way. It gets its own
       * history_messages row carrying ONLY the accounting: empty `response`
       * keeps it out of the user's chat (the history loader skips it), while
       * the usage page still counts it under this user's scheduled spend, with
       * `metadata.usage.outcome` recording why nothing came out.
       *
       * Best-effort throughout: the run already failed, and a billing write
       * must not turn that into a second failure.
       */
      const billUnattended = async (
        outcome: string,
        collected?: TurnUsageRecord,
      ): Promise<void> => {
        const spent = collected ?? (billing ? await collectTurnUsage(billing) : undefined);
        if (!spent) {
          return;
        }
        logger.warn(
          `[LEADING_V2_SCHED] task ${task.id} spent tokens without delivering ` +
            `(${outcome}): ${formatUsage(spent)}`,
        );
        const sessionId = sessionIdFromKey(task.sessionKey);
        if (!deps.config.db || !sessionId) {
          return;
        }
        try {
          await insertHistoryRow(
            deps.config.db,
            {
              sessionId,
              uid: task.uid,
              response: "", // accounting-only: invisible in the chat history
              usage: markUsageOutcome(spent, outcome),
            },
            logger,
          );
        } catch (error) {
          logger.warn(`[LEADING_V2_SCHED] failed-run billing write failed: ${String(error)}`);
        }
      };
      try {
        const { runId } = await subagent.run({
          sessionKey,
          message: `[scheduled-task][userId:${task.uid}] ${instruction}`,
          deliver: false,
          lane: execution?.lane ?? "leading-v2-schedule-0",
        });
        logger.info(`[LEADING_V2_SCHED] task ${task.id} started run ${runId}`);
        const { result: wait, stopped } = await waitUntilSettled(subagent, runId, task.id, logger, {
          sessionKey,
          deadline: firedAt + (deps.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS),
          signal: execution?.signal,
          abortRun: deps.abortRun,
        });
        if (stopped) {
          await billUnattended(stopped);
          return { ok: false, code: stopped, note: `${stopped}; run ${runId} settled` };
        }
        if (wait.status !== "ok") {
          await billUnattended(wait.status);
          return { ok: false, note: `subagent ${wait.status}: ${wait.error ?? ""}` };
        }
        const usage = billing ? await collectTurnUsage(billing) : undefined;
        // Upload evidence can precede many subsequent tool calls. Use the runtime's
        // recent-session window instead of only the last five reply messages.
        const { messages } = await subagent.getSessionMessages({ sessionKey });
        const links = new ArtifactLinks(
          process.env.ALIYUN_OSS_CUSTOM_DOMAIN,
          process.env.ALIYUN_OSS_PATH_PREFIX,
        );
        links.observeMessages(messages ?? []);
        const text = links.sanitize(lastAssistantText(messages ?? []));
        if (!text) {
          await billUnattended("empty-reply", usage);
          return { ok: false, note: "empty agent response" };
        }
        const ok = await deliver(
          {
            id: `schedule:${task.id}:${firedAt}`, // dedupe per fire
            uid: task.uid,
            category: "scheduled",
            level: "info",
            title: task.title || "定时任务",
            body: text,
            ts: firedAt,
            // Rides along so the history row this notification creates is
            // written WITH its token/cost columns (one INSERT, no follow-up
            // UPDATE); non-DB transports drop it.
            ...(usage ? { usage } : {}),
          },
          { mercureTopic: task.mercureTopic, sessionKey: task.sessionKey },
        );
        if (!ok) {
          // Not re-billed here on purpose: the fanout may have partially
          // succeeded, and a second insert could double-count. Log only.
          logger.warn(
            `[LEADING_V2_SCHED] agent_prompt produced a reply but no transport accepted it ` +
              `(task ${task.id})${usage ? `; unbilled: ${formatUsage(usage)}` : ""}`,
          );
          return { ok: false, note: "reply generated but no delivery transport accepted it" };
        } else if (usage) {
          logger.info(`[LEADING_V2_SCHED] task ${task.id} billed: ${formatUsage(usage)}`);
        }
        return { ok: true, note: text.slice(0, 80) };
      } catch (error) {
        // The run may have burned tokens before throwing (a dropped connection
        // mid-run, a gateway error): bill what the transcript shows.
        await billUnattended("error");
        return { ok: false, note: String(error) };
      }
    };
  },
};
