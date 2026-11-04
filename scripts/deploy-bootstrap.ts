import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCanonicalConfigPath, resolveStateDir } from "../src/config/paths.js";

// Apply ACLs only to a directory exclusively created by this invocation.
// Existing deployment directories belong to the operator and are never reset.
export async function secureDeployDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    return;
  }
  const identity = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const sid = identity.stdout?.trim();
  if (identity.error || identity.status !== 0 || !/^S-1-\d+(?:-\d+)+$/.test(sid ?? "")) {
    throw new Error("Cannot resolve the current Windows account SID for deployment ACLs");
  }
  const acl = spawnSync(
    "icacls.exe",
    [
      directory,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      `*${sid}:(OI)(CI)F`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (acl.error || acl.status !== 0) {
    throw new Error(`Cannot secure deployment directory: ${acl.error?.message ?? acl.stderr}`);
  }
}

export async function initializeDeployConfig(params: {
  release: string;
  env?: NodeJS.ProcessEnv;
  secureDirectory?: (directory: string) => Promise<void>;
}): Promise<{ file: string; created: boolean }> {
  const release = path.resolve(params.release);
  const directory = path.join(path.dirname(release), "supervisor");
  if (path.relative(directory, release) === "") {
    throw new Error(
      "The release directory cannot be named supervisor (reserved for deployment control)",
    );
  }
  const file = path.join(directory, "supervisor.json");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) {
      throw new Error(`Expected a regular supervisor config: ${file}`);
    }
    return { file, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const configPath = resolveCanonicalConfigPath(env, stateDir);
  try {
    await fs.access(configPath);
  } catch {
    throw new Error(
      `Gateway config not found: ${configPath}. Set OPENCLAW_CONFIG_PATH if needed, then retry with --configure <release>.`,
    );
  }
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Deployment directory already exists without a config: ${directory}. Check its contents and permissions before creating supervisor.json.`,
        { cause: error },
      );
    }
    throw error;
  }
  await (params.secureDirectory ?? secureDeployDirectory)(directory);
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port: 18789,
        slotPorts: [19001, 19041],
        stateDir,
        configPath,
        initialRelease: release,
        journal: path.join(directory, "deployment-state.json"),
        startupTimeoutMs: 120000,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { file, created: true };
}
