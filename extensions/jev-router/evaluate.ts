import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createDecisionClient, type Decision } from "./src/client.js";
import { evaluate, parseDataset } from "./src/evaluation.js";
import { parseConfig, selectCandidates } from "./src/router.js";
import { parseUsage } from "./src/usage.js";

async function readJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > 2 * 1024 * 1024) {
    throw new Error("Input exceeds the 2 MiB evaluation limit.");
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      responses: { type: "string" },
      live: { type: "boolean", default: false },
      output: { type: "string" },
      "max-cases": { type: "string", default: "20" },
      "timeout-ms": { type: "string", default: "2000" },
    },
  });
  if (!values.dataset || values.live === Boolean(values.responses)) {
    throw new Error(
      "Use --dataset FILE with exactly one of --live or --responses FILE; optionally --output FILE.",
    );
  }
  const rows = parseDataset(await readJson(values.dataset));
  const maxCases = z.coerce.number().int().min(1).max(500).parse(values["max-cases"]);
  if (rows.length > maxCases) {
    throw new Error(
      "Dataset exceeds --max-cases; increase the explicit request budget or use a smaller dataset.",
    );
  }
  if (values.live && !process.env.JEV_OPENROUTER_API_KEY?.trim()) {
    throw new Error("Set JEV_OPENROUTER_API_KEY before a live evaluation.");
  }
  const recorded = values.responses
    ? z
        .record(z.string(), z.object({ body: z.unknown(), elapsedMs: z.number().finite().min(0) }))
        .parse(await readJson(values.responses))
    : undefined;
  if (
    recorded &&
    JSON.stringify(Object.keys(recorded).toSorted()) !==
      JSON.stringify(rows.map((row) => row.id).toSorted())
  ) {
    throw new Error("Replay IDs must match dataset IDs exactly.");
  }
  const decisions: Decision[] = [];
  const timeoutMs = Number(values["timeout-ms"]);
  parseConfig({ timeoutMs });
  // Reserve the result path before spending anything; preserve partial results on interruption.
  const file = values.output ? await open(values.output, "wx") : undefined;
  const save = async (complete: boolean) => {
    const report = {
      schemaVersion: 2,
      source: recorded ? "replay" : "live",
      model: "typesafe/jev-1.13",
      datasetSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      createdAt: new Date().toISOString(),
      timeoutMs,
      minConfidence: 0.8,
      retainProbability: 0.2,
      complete,
      completedCases: decisions.length,
      plannedCases: rows.length,
      note: "Authored synthetic routing evaluation, not end-to-end task success or cost savings. No prompts or credentials are included.",
      ...(complete
        ? evaluate(rows, decisions)
        : { cases: decisions.map((decision, index) => ({ id: rows[index].id, ...decision })) }),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (file) {
      await file.truncate(0);
      await file.write(json, 0, "utf8");
      await file.sync();
    } else if (complete) {
      process.stdout.write(json);
    }
  };
  // Sequential requests bound paid usage and avoid overwhelming the upstream API.
  const clients = new Map<string, ReturnType<typeof createDecisionClient>>();
  try {
    await save(false);
    for (const row of rows) {
      const config = parseConfig({
        enabled: true,
        candidates: row.candidates,
        timeoutMs,
      });
      const replay = recorded?.[row.id];
      if (replay) {
        decisions.push({
          ...selectCandidates(replay.body, config),
          elapsedMs: replay.elapsedMs,
          usage: parseUsage(replay.body),
        });
      } else {
        const catalogKey = [...row.candidates].toSorted().join(",");
        let client = clients.get(catalogKey);
        if (!client) {
          client = createDecisionClient(config);
          clients.set(catalogKey, client);
        }
        decisions.push(await client.decide(row.prompt));
      }
      await save(false);
    }
    await save(true);
  } finally {
    await file?.close();
  }
}

main().catch(() => {
  // Do not echo raw JSON, HTTP errors, prompts, paths, or credentials on failures.
  process.stderr.write(
    "JEV evaluation failed. Check CLI arguments, input schema, output existence, and JEV_OPENROUTER_API_KEY.\n",
  );
  process.exitCode = 1;
});
