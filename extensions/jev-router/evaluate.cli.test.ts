import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("JEV evaluation CLI", () => {
  it("runs a complete offline replay and refuses to overwrite its report", () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-eval-"));
    directories.push(directory);
    const dataset = join(directory, "cases.json");
    const responses = join(directory, "responses.json");
    const output = join(directory, "report.json");
    writeFileSync(
      dataset,
      JSON.stringify([
        {
          id: "hello",
          prompt: "private synthetic hello",
          candidates: ["read"],
          expected: "no_tools",
          requiredTools: [],
        },
      ]),
    );
    writeFileSync(
      responses,
      JSON.stringify({
        hello: {
          elapsedMs: 12,
          body: {
            answers: {
              route: {
                type: "choice",
                choice: "no_tools",
                confidence: 0.95,
                probabilities: { tools: 0.02, no_tools: 0.96, abstain: 0.02 },
              },
              candidate_read: { type: "noul", noul: 0.01 },
            },
          },
        },
      }),
    );
    const args = [
      "--import",
      "tsx",
      fileURLToPath(new URL("./evaluate.ts", import.meta.url)),
      "--dataset",
      dataset,
      "--responses",
      responses,
      "--output",
      output,
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const report = readFileSync(output, "utf8");
    expect(JSON.parse(report)).toMatchObject({
      source: "replay",
      count: 1,
      routeAccuracy: 1,
      effectiveRequiredToolRecall: null,
    });
    expect(report).not.toContain("private synthetic hello");
    expect(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }).status).toBe(1);
    expect(readFileSync(output, "utf8")).toBe(report);
  });
});
