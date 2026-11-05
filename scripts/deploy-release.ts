import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { verifyDeployArtifact } from "./deploy-artifact.js";
import { sendDeploymentCommand } from "./deploy-control.js";
import { runSupervisor } from "./deploy-supervisor.js";

const usage = "Usage: node deploy.mjs serve|status|stop|recover|deploy --compatible-state";
const controlConfigSchema = z.object({ journal: z.string().refine(path.isAbsolute) });
const statusSchema = z.object({ release: z.string() }).passthrough();
const actionSchema = z.enum(["serve", "status", "stop", "recover", "deploy"]);

export async function runReleaseCommand(
  configFile: string,
  release: string,
  args: string[],
  deps: {
    verify: typeof verifyDeployArtifact;
    serve: (config: string, options: { expectedRelease: string }) => Promise<unknown>;
    send: typeof sendDeploymentCommand;
    log: (message: string) => void;
  } = {
    verify: verifyDeployArtifact,
    serve: runSupervisor,
    send: sendDeploymentCommand,
    log: console.log,
  },
) {
  const [rawAction, confirmation] = args;
  const parsedAction = actionSchema.safeParse(rawAction);
  if (!parsedAction.success) {
    throw new Error(usage);
  }
  const action = parsedAction.data;
  if (
    action === "deploy"
      ? args.length !== 2 || confirmation !== "--compatible-state"
      : args.length !== 1
  ) {
    throw new Error(usage);
  }
  const targetRelease = path.resolve(release);
  const sharedConfig = path.resolve(configFile);
  deps.log(`Target release: ${targetRelease}\nShared supervisor config: ${sharedConfig}`);
  if (action === "serve") {
    await deps.verify(targetRelease);
    await deps.serve(sharedConfig, { expectedRelease: targetRelease });
    return;
  }
  const config = controlConfigSchema.parse(JSON.parse(await fs.readFile(sharedConfig, "utf8")));
  const directory = `${config.journal}.commands`;
  if (action === "deploy") {
    await deps.verify(targetRelease);
    deps.log(
      JSON.stringify(
        await deps.send(directory, {
          command: "deploy",
          release: targetRelease,
          compatibleState: true,
        }),
      ),
    );
    return;
  }
  // Stop and recover operate on the shared supervisor, not a per-release process.
  const result = await deps.send(directory, { command: action });
  if (action === "status") {
    const status = statusSchema.parse(result);
    deps.log(
      JSON.stringify({
        ...status,
        targetRelease,
        releaseMatches: path.relative(path.resolve(status.release), targetRelease) === "",
      }),
    );
  } else {
    deps.log(JSON.stringify(result));
  }
}

/** Keep control code in the stable source tree; releases only contain an operator entrypoint. */
export async function writeReleaseLauncher(params: { release: string; configFile: string }) {
  const script = fileURLToPath(new URL("./deploy-release-cli.ts", import.meta.url));
  const source = path.dirname(path.dirname(script));
  const configFile = path.resolve(params.configFile);
  const file = path.join(params.release, "deploy.mjs");
  const content = `// Generated OpenClaw release entrypoint. Uses the shared supervisor.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const result = spawnSync(process.execPath, [
  "--import", "tsx", ${JSON.stringify(script)}, ${JSON.stringify(configFile)},
  dirname(fileURLToPath(import.meta.url)), ...process.argv.slice(2),
], { cwd: ${JSON.stringify(source)}, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`;
  try {
    await fs.writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (await fs.readFile(file, "utf8")) !== content) {
      throw new Error(`Release launcher already exists with different content: ${file}`, {
        cause: error,
      });
    }
  }
  return file;
}
