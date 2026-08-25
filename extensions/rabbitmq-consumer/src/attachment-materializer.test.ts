import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginLogger } from "../api.js";
import { materializeAttachments } from "./attachment-materializer.js";

describe("materializeAttachments Unicode paths", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps Chinese workspace and attachment names intact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rabbitmq-unicode-workspace-"));
    roots.push(root);
    const workspace = path.join(root, "夙衡工作区“客户A”");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new TextEncoder().encode("sheet-data"), { status: 200 })),
    );

    const result = await materializeAttachments(
      [
        {
          fileId: "file-1",
          filename: "八月舆情“摘要”.xlsx",
          ext: "xlsx",
          kind: "spreadsheet",
          storage: "oss",
          ref: "https://oss.example.test/report.xlsx",
        },
      ],
      "rabbitmq-42",
      {
        agents: {
          list: [{ id: "rabbitmq-42", workspace }],
        },
      } as OpenClawConfig,
      logger,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.workspacePath).toBe("uploads/file-1-八月舆情“摘要”.xlsx");
    await expect(readFile(path.join(workspace, result[0].workspacePath), "utf8")).resolves.toBe(
      "sheet-data",
    );
  });
});
