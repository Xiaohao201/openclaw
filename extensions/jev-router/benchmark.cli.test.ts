import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskDataset } from "./src/benchmark.js";
import { parseDataset } from "./src/evaluation.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("phase-two CLI and frozen inputs", () => {
  it("runs complete paired tasks with mocked HTTP and reserves output before paid work", () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-task-cli-"));
    directories.push(directory);
    const dataset = join(directory, "tasks.json");
    const output = join(directory, "result.json");
    const trace = join(directory, "calls.txt");
    const preload = join(directory, "mock.mjs");
    writeFileSync(
      dataset,
      JSON.stringify([
        {
          id: "read",
          prompt: "Read ./code.txt and report its code.",
          candidates: ["read"],
          fixtures: [
            { tool: "read", args: { path: "./code.txt" }, result: "Test code: ECHO-7391" },
          ],
          requiredTools: ["read"],
          answerContains: ["ECHO-7391"],
        },
      ]),
    );
    writeFileSync(
      preload,
      `
      import { appendFileSync } from 'node:fs';
      process.env.JEV_OPENROUTER_API_KEY = 'offline-test-key';
      globalThis.fetch = async (url, init) => {
        appendFileSync(${JSON.stringify(trace)}, 'request\\n');
        const usage = { prompt_tokens: 12, completion_tokens: 5, cost: 0.001 };
        if (url === 'https://openrouter.ai/api/alpha/decisions') {
          return new Response(JSON.stringify({ usage, answers: {
            route: { type: 'choice', choice: 'tools', confidence: 0.95, probabilities: { tools: 0.98, no_tools: 0.01, abstain: 0.01 } },
            candidate_read: { type: 'noul', noul: 0.99 }
          }}));
        }
        if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected destination');
        const input = JSON.parse(init.body);
        const done = input.messages.at(-1).role === 'tool';
        const message = done ? { role: 'assistant', content: 'ECHO-7391' } : { role: 'assistant', content: null,
          tool_calls: [{ id: 'test-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({path:'./code.txt'}) } }] };
        return new Response(JSON.stringify({ usage, choices: [{ message, finish_reason: done ? 'stop' : 'tool_calls' }] }));
      };
    `,
    );
    const args = [
      "--import",
      "tsx",
      "--import",
      pathToFileURL(preload).href,
      fileURLToPath(new URL("./benchmark.ts", import.meta.url)),
      "--dataset",
      dataset,
      "--output",
      output,
      "--model",
      "qwen/test",
      "--max-model-calls",
      "8",
      "--live",
    ];
    const run = () => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    const first = run();
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const report = readFileSync(output, "utf8");
    expect(JSON.parse(report)).toMatchObject({
      complete: true,
      actualModelRequests: 4,
      summary: {
        pairs: 1,
        baselineSuccessRate: 1,
        advisorySuccessRate: 1,
        baselineCostUsd: 0.002,
        advisoryCostUsd: 0.003,
      },
    });
    expect(report).not.toMatch(/ECHO-7391|offline-test-key/);
    const calls = readFileSync(trace, "utf8");
    expect(calls.trim().split("\n")).toHaveLength(5);
    expect(run().status).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe(calls);
    expect(readFileSync(output, "utf8")).toBe(report);
  });
  it("validates all new cases and keeps validation prompts disjoint from the original smoke set", () => {
    const load = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`./eval/${name}.json`, import.meta.url), "utf8"));
    const rows = parseDataset(load("validation"));
    expect(rows).toHaveLength(64);
    expect(parseTaskDataset(load("tasks"))).toHaveLength(8);
    const seed = new Set(parseDataset(load("seed")).map((row) => row.prompt));
    expect(rows.some((row) => seed.has(row.prompt))).toBe(false);
  });
});
