import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { writeDeployArtifact } from "../../scripts/deploy-artifact.js";
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
        if (command === 'retire') { record('exit'); if (server) await new Promise(r => server.close(r)); process.exit(0); }
        if (command === 'activate') {
          record('activate');
          if (${fail}) { process.send({id, ok:false, error:'injected startup failure'}); return; }
          server = http.createServer((req, res) => res.end(name));
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
