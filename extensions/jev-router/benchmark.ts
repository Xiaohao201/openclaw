import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  parseTaskDataset,
  runTask,
  summarizePairs,
  type Arm,
  type TaskResult,
} from "./src/benchmark.js";
import { createChatClient } from "./src/chat-client.js";
import { createDecisionClient } from "./src/client.js";
import { parseConfig } from "./src/router.js";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      model: { type: "string" },
      live: { type: "boolean", default: false },
      "max-tasks": { type: "string", default: "8" },
      "max-model-calls": { type: "string", default: "64" },
    },
  });
  if (
    !values.live ||
    !values.dataset ||
    !values.output ||
    !values.model ||
    !process.env.JEV_OPENROUTER_API_KEY?.trim()
  ) {
    throw new Error("configuration");
  }
  const datasetText = await readFile(values.dataset, "utf8");
  if (datasetText.length > 100000) {
    throw new Error("dataset_size");
  }
  const tasks = parseTaskDataset(JSON.parse(datasetText));
  const maxTasks = z.coerce.number().int().min(1).max(20).parse(values["max-tasks"]);
  const maxCalls = z.coerce.number().int().min(1).max(160).parse(values["max-model-calls"]);
  if (tasks.length > maxTasks || tasks.length * 8 > maxCalls) {
    throw new Error("request_budget");
  }
  const chat = createChatClient({ model: values.model, maxRequests: maxCalls });
  // Reserve before any external calls, and checkpoint every completed arm.
  const file = await open(values.output, "wx");
  const results: TaskResult[] = [];
  const base = {
    schemaVersion: 1,
    source: "live-controlled-task-benchmark",
    model: values.model,
    datasetSha256: createHash("sha256").update(datasetText).digest("hex"),
    createdAt: new Date().toISOString(),
    limits: {
      maxDecisionCalls: tasks.length,
      maxModelCalls: maxCalls,
      maxStepsPerArm: 4,
      maxOutputTokens: 512,
    },
    scope:
      "Fixed synthetic tool fixtures using the real JEV advisory hook. Not an OpenClaw Gateway end-to-end benchmark. Search query relevance and natural-language answer quality are not scored.",
  };
  const save = async (complete: boolean) => {
    const report = {
      ...base,
      complete,
      actualModelRequests: chat.requests(),
      results,
      ...(complete ? { summary: summarizePairs(results) } : {}),
    };
    await file.truncate(0);
    await file.write(JSON.stringify(report, null, 2) + "\n", 0, "utf8");
    await file.sync();
  };
  try {
    await save(false);
    for (const [index, task] of tasks.entries()) {
      // Counterbalance order to reduce systematic warm-cache/network bias.
      const order: Arm[] = index % 2 ? ["advisory", "baseline"] : ["baseline", "advisory"];
      const jev = createDecisionClient(parseConfig({ candidates: task.candidates }));
      for (const arm of order) {
        results.push(
          await runTask(task, arm, {
            complete: (input) => chat.complete(input),
            decide: (prompt) => jev.decide(prompt),
          }),
        );
        await save(false);
        process.stdout.write(`${results.length}/${tasks.length * 2} task arms completed\n`);
      }
    }
    await save(true);
  } finally {
    await file.close();
  }
}

main().catch(() => {
  process.stderr.write(
    "Task benchmark failed; check configuration and the partial report. No automatic retry was attempted.\n",
  );
  process.exitCode = 1;
});
