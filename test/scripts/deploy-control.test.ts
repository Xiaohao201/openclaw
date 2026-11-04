import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startDeploymentControl, sendDeploymentCommand } from "../../scripts/deploy-control.js";

let root: string;
let control: Awaited<ReturnType<typeof startDeploymentControl>> | undefined;
afterEach(async () => {
  await control?.close();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("accepts validated local commands and leaves interrupted operations unreplayed", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-control-"));
  const handler = vi.fn(async () => ({ phase: "running" }));
  control = await startDeploymentControl(root, handler, 10);
  await expect(sendDeploymentCommand(root, { command: "status" }, 2000)).resolves.toEqual({
    phase: "running",
  });
  await fs.writeFile(
    path.join(root, "00000000-0000-4000-8000-000000000000.processing"),
    '{"command":"recover"}',
  );
  await fs.writeFile(
    path.join(root, "00000000-0000-4000-8000-000000000001.request"),
    '{"command":"arbitrary"}',
  );
  await vi.waitFor(async () =>
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, "00000000-0000-4000-8000-000000000001.response"), "utf8"),
      ),
    ).toMatchObject({ ok: false }),
  );
  expect(handler).toHaveBeenCalledTimes(1);
});

it("keeps status available during a long operation and reports a handler failure", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-control-"));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  control = await startDeploymentControl(
    root,
    async (command) => {
      if (command.command === "recover") {
        await gate;
        return "recovered";
      }
      if (command.command === "stop") {
        throw new Error("blocked stop");
      }
      return { phase: "recovering" };
    },
    10,
  );
  const pending = sendDeploymentCommand(root, { command: "recover" }, 2000);
  try {
    await expect(sendDeploymentCommand(root, { command: "status" }, 1000)).resolves.toEqual({
      phase: "recovering",
    });
    await expect(sendDeploymentCommand(root, { command: "stop" }, 1000)).rejects.toThrow(
      "blocked stop",
    );
  } finally {
    finish();
    await pending;
  }
});

it("reports timeouts as unknown outcomes and rejects oversized commands", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-control-"));
  await expect(sendDeploymentCommand(root, { command: "status" }, 0)).rejects.toThrow(
    "outcome unknown",
  );
  control = await startDeploymentControl(root, async () => ({}), 10);
  const id = "00000000-0000-4000-8000-000000000002";
  await fs.writeFile(path.join(root, `${id}.request`), " ".repeat(8193));
  await vi.waitFor(async () =>
    expect(JSON.parse(await fs.readFile(path.join(root, `${id}.response`), "utf8"))).toMatchObject({
      ok: false,
      error: "Invalid command file",
    }),
  );
});
