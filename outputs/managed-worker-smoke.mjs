import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const release = path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-smoke-"));
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const config = path.join(root, "openclaw.json");
await fs.writeFile(
  config,
  JSON.stringify({
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "deployment-smoke-only-token" },
      trustedProxies: ["127.0.0.1"],
      controlUi: { enabled: false },
    },
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
const env = {
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: root,
  TMP: root,
  HOME: root,
  USERPROFILE: root,
  APPDATA: root,
  LOCALAPPDATA: root,
  OPENCLAW_HOME: root,
  OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_DEPLOY_PORT: String(port),
  OPENCLAW_MANAGED_DEPLOYMENT: "1",
  VITEST: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PLUGIN_SERVICES: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
};
const child = fork(path.join(release, "dist/deployment/worker.js"), [], {
  cwd: release,
  env,
  windowsHide: true,
  execArgv: [],
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let output = "";
child.stdout.on("data", (x) => (output += x));
child.stderr.on("data", (x) => (output += x));
function reply(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Worker smoke timed out\n" + output.slice(-4000)));
    }, 120000);
    const onExit = () => {
      cleanup();
      reject(new Error("Worker exited early\n" + output.slice(-4000)));
    };
    const onMessage = (x) => {
      if (predicate(x)) {
        cleanup();
        resolve(x);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
try {
  await reply((x) => x.ready === true);
  console.log("Worker standby ready");
  try {
    await fs.access(path.join(root, "state"));
    throw new Error("Standby unexpectedly wrote state");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const activated = reply((x) => x.id === 1);
  child.send({ command: "activate", id: 1 });
  const result = await activated;
  if (!result.ok) throw new Error(result.error + "\n" + output.slice(-4000));
  console.log("Worker activated");
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok) throw new Error("Gateway health failed: " + response.status);
  const exited = once(child, "exit");
  child.send({ command: "retire", id: 2 });
  const [code] = await exited;
  if (code !== 0) throw new Error("Retirement failed: " + code);
  console.log(
    "Built worker smoke passed: standby without state writes -> isolated minimal Gateway healthy -> graceful retirement.",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
