import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Exercises real built plugin loading and two worker processes, using an isolated
// ACP protocol fixture. No model, broker, or notification credentials are used.
it.runIf(process.env.OPENCLAW_MANAGED_PLUGINS_SMOKE === "1")(
  "hands off with ACP, browser, pairing, and phone expiry services enabled",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-managed-plugins-"));
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("No test port");
    }
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const fixture = path.join(dir, "agent.mjs");
    await writeFile(
      fixture,
      `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: "handoff-fixture", version: "1" } } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
    );
    const stateDir = path.join(dir, "state");
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace);
    const configPath = path.join(dir, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: "isolated-handoff-test-token" },
          controlUi: { enabled: false },
          reload: { mode: "off" },
        },
        agents: { defaults: { workspace } },
        plugins: {
          allow: ["acpx", "browser", "device-pair", "phone-control"],
          slots: { memory: "none" },
          entries: {
            acpx: {
              enabled: true,
              config: {
                cwd: workspace,
                stateDir: path.join(dir, "acpx"),
                agents: {
                  codex: {
                    command: `"${process.execPath.replaceAll("\\", "/")}" "${fixture.replaceAll("\\", "/")}"`,
                  },
                },
              },
            },
            browser: { enabled: true },
            "device-pair": { enabled: true },
            "phone-control": { enabled: true },
          },
        },
        browser: { enabled: true },
        cron: { enabled: false },
        hooks: { internal: { enabled: false } },
        canvasHost: { enabled: false },
        update: { checkOnStart: false },
        logging: { file: path.join(dir, "gateway.log") },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      TEMP: dir,
      TMP: dir,
      OPENCLAW_HOME: dir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_ALLOW_MULTI_GATEWAY: "0",
    };
    const manager = spawn(
      process.execPath,
      [
        "dist/entry.js",
        "gateway",
        "supervise",
        "--release",
        process.cwd(),
        "--port",
        String(port),
        "--timeout",
        "240000",
        "--drain-timeout",
        "10000",
      ],
      {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    manager.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    manager.stderr.on("data", (chunk) => {
      output += String(chunk);
      if (String(chunk).includes("[lifecycle]")) {
        console.info(String(chunk).trim());
      }
    });
    const eventPath = path.join(stateDir, "lifecycle", "events.jsonl");
    const waitEvent = async (event: string) => {
      const deadline = performance.now() + 260_000;
      while (performance.now() < deadline) {
        const log = await readFile(eventPath, "utf8").catch(() => "");
        const events = log
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; workerId?: string });
        const matched = events.find((entry) => entry.event === event);
        if (matched) {
          return matched;
        }
        if (
          events.some(
            (entry) =>
              entry.event === "operation-failed" || entry.event === "admission-needs-attention",
          ) ||
          manager.exitCode !== null
        ) {
          throw new Error(output.slice(-8000));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for ${event}\n${output.slice(-8000)}`);
    };
    try {
      const started = await waitEvent("started");
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
      manager.stdin.write(JSON.stringify({ action: "replace", release: process.cwd() }) + "\n");
      const replaced = await waitEvent("replacement-completed");
      expect(replaced.workerId).not.toBe(started.workerId);
      expect(output).toContain("embedded acpx runtime backend ready");
      expect(output).toContain("Browser control listening on http://127.0.0.1:");
      expect(output).not.toContain("plugin service failed");
      expect(output).not.toContain("Invalid managed service handoff contract");
      manager.stdin.write('{"action":"stop"}\n');
      await waitEvent("stopped");
      console.info("Managed plugins smoke: first start, replacement, and drained stop succeeded");
    } finally {
      if (manager.exitCode === null && manager.pid) {
        if (process.platform === "win32") {
          const cleanup = spawn("taskkill", ["/PID", String(manager.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          await once(cleanup, "exit");
        } else {
          manager.kill("SIGKILL");
        }
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  600_000,
);
