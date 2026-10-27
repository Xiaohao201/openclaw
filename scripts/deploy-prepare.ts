import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyDeployArtifact, writeDeployArtifact } from "./deploy-artifact.js";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

type RunCommand = (command: string, args: string[], cwd: string) => void;
type DeploySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  spawn: DeploySpawn = spawnSync,
): void {
  const result = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal})`);
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function prepareDeployRelease(params: {
  source: string;
  output: string;
  run?: RunCommand;
  spawn?: DeploySpawn;
  resolveCommit?: (source: string) => string;
}): Promise<string> {
  const source = await fs.realpath(params.source);
  const spawn = params.spawn ?? spawnSync;
  const requested = path.resolve(params.output);
  // Resolve the existing parent to catch junctions before any write or build.
  const output = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  if (within(source, output) || within(output, source)) {
    throw new Error("Release output must be outside the source tree and cannot contain it");
  }
  const resolveCommit =
    params.resolveCommit ??
    ((cwd: string) => {
      const result = spawn("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0) {
        throw new Error("Cannot resolve source HEAD");
      }
      return result.stdout.toString().trim();
    });
  const commit = resolveCommit(source);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error("Invalid source commit");
  }
  const run = params.run ?? ((command, args, cwd) => runCommand(command, args, cwd, spawn));
  // Exclusive creation: never rebuild or overwrite an existing release.
  await fs.mkdir(output);
  const archive = path.join(output, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, commit], source);
  run("tar", ["-xf", archive, "-C", output], source);
  await fs.rm(archive);
  const pnpm = (args: string[]) => {
    const invocation = resolvePnpmRunner({ pnpmArgs: args });
    if (params.run) {
      params.run(invocation.command, invocation.args, output);
      return;
    }
    const result = spawn(invocation.command, invocation.args, {
      cwd: output,
      stdio: "inherit",
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`pnpm ${args.join(" ")} failed (${result.status ?? result.signal})`);
    }
  };
  pnpm(["install", "--frozen-lockfile"]);
  pnpm(["build"]);
  pnpm(["ui:build"]);
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"], output);
  await writeDeployArtifact(output, commit);
  await verifyDeployArtifact(output);
  return output;
}

export async function runDeployCommand(
  args: string[],
  prepare: typeof prepareDeployRelease = prepareDeployRelease,
) {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string", default: process.cwd() },
      output: { type: "string" },
      verify: { type: "string" },
    },
  });
  if (values.verify) {
    if (values.output) {
      throw new Error("Use either --verify or --output");
    }
    await verifyDeployArtifact(path.resolve(values.verify));
    console.log("Build and UI checksums verified; no service was started or switched.");
    return;
  }
  if (!values.output) {
    throw new Error(
      "Required: --output <new-directory-outside-source>; builds committed HEAD only",
    );
  }
  const output = await prepare({ source: values.source, output: values.output });
  console.log(`Prepared ${output}. No service was stopped, started, or switched.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDeployCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
