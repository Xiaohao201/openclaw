import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDeployArtifact } from "../../scripts/deploy-artifact.js";
import { sendDeploymentCommand } from "../../scripts/deploy-control.js";
import { runSupervisor, supervisorConfigSchema } from "../../scripts/deploy-supervisor.js";

let supervisor: Awaited<ReturnType<typeof runSupervisor>> | undefined;
let root: string | undefined;
afterEach(async () => {
  await supervisor?.close();
  supervisor = undefined;
  if (root) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    root = undefined;
  }
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function artifact(name: string, fail = false) {
  const release = path.join(root!, name);
  await fs.mkdir(path.join(release, "dist/deployment"), { recursive: true });
  await fs.mkdir(path.join(release, "dist/control-ui/assets"), { recursive: true });
  const files = {
    "package.json": JSON.stringify({ type: "module", version: "0.0.0-test" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "openclaw.mjs": "",
    "dist/entry.js": "",
    "dist/control-ui/index.html": "<html></html>",
    "dist/control-ui/assets/test.js": "",
    "dist/deployment/worker.js": `
      import http from 'node:http';
      import fs from 'node:fs';
      import path from 'node:path';
      const name = ${JSON.stringify(name)};
      const record = (event) => fs.appendFileSync(path.join(process.env.OPENCLAW_STATE_DIR, 'events'), name + ':' + event + '\\n');
      let server;
      process.on('disconnect', () => process.exit(0));
      process.on('message', async ({command, id}) => {
        if (command === 'retire') { if (fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, 'refuse-retire'))) return; record('exit'); if (server) await new Promise(r => server.close(r)); process.exit(0); }
        if (command === 'activate') {
          record('activate');
          if (${fail} || fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, 'fail-activation'))) { process.send({id, ok:false, error:'injected startup failure'}); return; }
          fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR, 'worker.pid'), String(process.pid));
          server = http.createServer((req, res) => {
            if (req.url === '/healthz' && fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, 'unhealthy'))) res.statusCode = 503;
            res.end(name);
          });
          server.listen(Number(process.env.OPENCLAW_DEPLOY_PORT), '127.0.0.1', () => process.send({id, ok:true}));
        }
      });
      process.send({ready:true});
    `,
  };
  for (const [file, value] of Object.entries(files)) {
    await fs.writeFile(path.join(release, file), value);
  }
  await writeDeployArtifact(release, "a".repeat(40));
  return release;
}

describe("managed supervisor with isolated worker processes", () => {
  it("switches on the same port and rolls back only after the failed candidate exits", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-"));
    const old = await artifact("old"),
      next = await artifact("next"),
      bad = await artifact("bad", true);
    const ports: number[] = [];
    while (ports.length < 3) {
      const port = await freePort();
      if (ports.every((p) => Math.abs(p - port) >= 20)) {
        ports.push(port);
      }
    }
    const configPath = path.join(root, "supervisor.json");
    const journal = path.join(root, "journal.json");
    const config = {
      host: "127.0.0.1",
      port: ports[0],
      slotPorts: ports.slice(1),
      stateDir: root,
      configPath: path.join(root, "unused-gateway.json"),
      initialRelease: old,
      journal,
      startupTimeoutMs: 5000,
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    supervisor = await runSupervisor(configPath, {
      input: new PassThrough(),
      installSignalHandlers: false,
    });
    expect(await (await fetch(`http://127.0.0.1:${ports[0]}`)).text()).toBe("old");
    await expect(supervisor.deploy(next, true)).resolves.toBe("deployed");
    expect(await (await fetch(`http://127.0.0.1:${ports[0]}`)).text()).toBe("next");
    await expect(supervisor.deploy(bad, true)).resolves.toBe("rolled-back");
    expect(await (await fetch(`http://127.0.0.1:${ports[0]}`)).text()).toBe("next");
    expect(JSON.parse(await fs.readFile(journal, "utf8"))).toMatchObject({
      phase: "running",
      release: next,
    });
    const events = (await fs.readFile(path.join(root, "events"), "utf8")).trim().split("\n");
    expect(events).toEqual([
      "old:activate",
      "old:exit",
      "next:activate",
      "next:exit",
      "bad:activate",
      "bad:exit",
      "next:activate",
    ]);
  }, 45_000);

  it("rejects ambiguous ports and relative state locations", () => {
    expect(
      supervisorConfigSchema.safeParse({
        port: 18789,
        slotPorts: [18790, 18791],
        stateDir: "relative",
      }).success,
    ).toBe(false);
  });
});

async function recoveryFixture(maxAttempts = 3, delayMs = 20) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-"));
  const release = await artifact("stable");
  const ports: number[] = [];
  while (ports.length < 3) {
    const port = await freePort();
    if (ports.every((p) => Math.abs(p - port) >= 20)) {
      ports.push(port);
    }
  }
  const configFile = path.join(root, "supervisor.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      port: ports[0],
      slotPorts: ports.slice(1),
      stateDir: root,
      configPath: path.join(root, "gateway.json"),
      initialRelease: release,
      journal: path.join(root, "journal.json"),
      startupTimeoutMs: 5000,
      recovery: {
        maxAttempts,
        windowMs: 60000,
        delaysMs: [delayMs],
        healthIntervalMs: 50,
        healthTimeoutMs: 100,
        healthFailures: 3,
        retireTimeoutMs: 200,
      },
    }),
  );
  const start = async () => {
    supervisor = await runSupervisor(configFile, {
      input: new PassThrough(),
      installSignalHandlers: false,
    });
    return supervisor;
  };
  const pid = async () => Number(await fs.readFile(path.join(root!, "worker.pid"), "utf8"));
  await start();
  return { start, pid, configFile, url: `http://127.0.0.1:${ports[0]}`, release };
}

describe("runtime recovery", () => {
  it("supports service management without an attached terminal", async () => {
    const f = await recoveryFixture();
    const directory = path.join(root!, "journal.json.commands");
    await expect(sendDeploymentCommand(directory, { command: "status" })).resolves.toMatchObject({
      phase: "running",
    });
    await expect(sendDeploymentCommand(directory, { command: "recover" })).rejects.toThrow(
      "only allowed while blocked",
    );
    await expect(
      sendDeploymentCommand(directory, {
        command: "deploy",
        release: f.release,
        compatibleState: true,
      }),
    ).resolves.toBe("deployed");
    await expect(sendDeploymentCommand(directory, { command: "stop" })).resolves.toEqual({
      accepted: true,
    });
    await vi.waitFor(() => expect(supervisor!.status().phase).toBe("stopped"));
  }, 15000);

  it("does not bypass the restart budget after a supervisor process dies", async () => {
    const f = await recoveryFixture();
    const previous = await f.pid();
    await supervisor!.close();
    supervisor = undefined;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve("scripts/deploy-supervisor.ts"), f.configFile],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: "ignore",
      },
    );
    const exited = once(child, "exit");
    try {
      await vi.waitFor(
        async () => {
          expect(await f.pid()).not.toBe(previous);
          expect((await fetch(f.url)).status).toBe(200);
        },
        { timeout: 20000 },
      );
      const orphan = await f.pid();
      child.kill();
      await exited;
      await vi.waitFor(
        () => {
          expect(() => process.kill(orphan, 0)).toThrow();
        },
        { timeout: 10000 },
      );
      await f.start();
      expect(supervisor!.status().phase).toBe("running");
      const state = JSON.parse(
        await fs.readFile(path.join(root!, "journal.json.recovery.json"), "utf8"),
      );
      expect(state.attempts).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await exited;
    }
  }, 35000);

  it("bounds repeated activation failures and keeps a persisted block across restarts", async () => {
    const f = await recoveryFixture(2);
    await fs.writeFile(path.join(root!, "fail-activation"), "1");
    process.kill(await f.pid());
    await vi.waitFor(
      () =>
        expect(supervisor!.status()).toMatchObject({
          phase: "blocked",
          operationInProgress: false,
        }),
      { timeout: 10000 },
    );
    expect((await fetch(f.url)).status).toBe(503);
    await expect(supervisor!.deploy(f.release, true)).rejects.toThrow("not running");
    await supervisor!.close();
    supervisor = undefined;
    await f.start();
    expect(supervisor!.status()).toMatchObject({ phase: "blocked", operationInProgress: false });
    await fs.unlink(path.join(root!, "fail-activation"));
    await supervisor!.recover();
    expect((await fetch(f.url)).status).toBe(200);
  }, 20000);

  it("blocks a missing artifact at startup and rejects ambiguous deployment journals", async () => {
    const f = await recoveryFixture(1);
    await supervisor!.close();
    supervisor = undefined;
    const journal = path.join(root!, "journal.json");
    await fs.writeFile(
      journal,
      JSON.stringify({ format: 1, phase: "draining", release: f.release }),
    );
    await expect(f.start()).rejects.toThrow("Interrupted deployment");
    await fs.writeFile(
      journal,
      JSON.stringify({ format: 1, phase: "running", release: f.release }),
    );
    await fs.unlink(path.join(f.release, "dist", "deployment", "worker.js"));
    await f.start();
    expect(supervisor!.status()).toMatchObject({ phase: "blocked", operationInProgress: false });
    expect((await fetch(f.url)).status).toBe(503);
  }, 10000);

  it("restores ingress after an unexpected worker exit and records the cause", async () => {
    const f = await recoveryFixture();
    const previous = await f.pid();
    process.kill(previous);
    await vi.waitFor(
      async () => {
        expect(await f.pid()).not.toBe(previous);
        expect(await (await fetch(f.url)).text()).toBe("stable");
      },
      { timeout: 10000 },
    );
    expect(await fs.readFile(path.join(root!, "journal.json.events.jsonl"), "utf8")).toContain(
      "worker-exit",
    );
  }, 15000);

  it("persists the restart budget across supervisor restarts", async () => {
    const f = await recoveryFixture(1);
    const previous = await f.pid();
    process.kill(previous);
    await vi.waitFor(async () => expect(await f.pid()).not.toBe(previous), { timeout: 10000 });
    await supervisor!.close();
    supervisor = undefined;
    await f.start();
    process.kill(await f.pid());
    await vi.waitFor(
      () =>
        expect(supervisor!.status()).toMatchObject({
          phase: "blocked",
          operationInProgress: false,
        }),
      { timeout: 10000 },
    );
    expect((await fetch(f.url)).status).toBe(503);
  }, 25000);

  it("cancels backoff when explicitly stopped", async () => {
    const f = await recoveryFixture(3, 1000);
    process.kill(await f.pid());
    await vi.waitFor(() => expect(supervisor!.status().phase).toBe("recovering"));
    await supervisor!.close();
    expect(supervisor!.status().phase).toBe("stopped");
    const events = await fs.readFile(path.join(root!, "events"), "utf8");
    expect(events.match(/stable:activate/g)).toHaveLength(1);
  });

  it("requires repeated unhealthy probes and recovers only after retirement", async () => {
    const f = await recoveryFixture(3, 300);
    const previous = await f.pid();
    await fs.writeFile(path.join(root!, "unhealthy"), "1");
    await vi.waitFor(() => expect(supervisor!.status().phase).toBe("recovering"), {
      timeout: 5000,
    });
    await fs.unlink(path.join(root!, "unhealthy"));
    await vi.waitFor(
      async () => {
        expect(await f.pid()).not.toBe(previous);
        expect((await fetch(f.url)).status).toBe(200);
      },
      { timeout: 10000 },
    );
    const events = (await fs.readFile(path.join(root!, "events"), "utf8")).trim().split("\n");
    expect(events.slice(0, 3)).toEqual(["stable:activate", "stable:exit", "stable:activate"]);
  }, 15000);

  it("blocks instead of activating a second writer when retirement hangs", async () => {
    const f = await recoveryFixture();
    const previous = await f.pid();
    try {
      await fs.writeFile(path.join(root!, "refuse-retire"), "1");
      await fs.writeFile(path.join(root!, "unhealthy"), "1");
      await vi.waitFor(
        () =>
          expect(supervisor!.status()).toMatchObject({
            phase: "blocked",
            operationInProgress: false,
          }),
        { timeout: 5000 },
      );
      expect(await f.pid()).toBe(previous);
      expect((await fetch(f.url)).status).toBe(503);
      await expect(supervisor!.recover()).rejects.toThrow("still alive");
    } finally {
      await fs.rm(path.join(root!, "refuse-retire"), { force: true });
      await fs.rm(path.join(root!, "unhealthy"), { force: true });
    }
  }, 10000);

  it("rejects deployment during recovery and permits explicit recovery after the budget blocks", async () => {
    const f = await recoveryFixture(1, 300);
    process.kill(await f.pid());
    await vi.waitFor(() => expect(supervisor!.status().phase).toBe("recovering"));
    await expect(supervisor!.deploy(f.release, true)).rejects.toThrow("in progress");
    await vi.waitFor(() => expect(supervisor!.status().phase).toBe("running"), { timeout: 10000 });
    process.kill(await f.pid());
    await vi.waitFor(() =>
      expect(supervisor!.status()).toMatchObject({ phase: "blocked", operationInProgress: false }),
    );
    await supervisor!.recover();
    expect(supervisor!.status().phase).toBe("running");
    expect((await fetch(f.url)).status).toBe(200);
  }, 15000);
});
