import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDeployConfig, secureDeployDirectory } from "../../scripts/deploy-bootstrap.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-bootstrap-"));
  await fs.mkdir(path.join(root, ".openclaw"));
  await fs.writeFile(path.join(root, ".openclaw/openclaw.json"), "{ /* existing */ }");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("deployment bootstrap", () => {
  const options = () => ({
    release: path.join(root, "001"),
    env: { OPENCLAW_HOME: root },
    secureDirectory: vi.fn(async () => {}),
  });

  it("creates a sibling supervisor config using the existing default state", async () => {
    const params = options();
    const result = await initializeDeployConfig(params);
    expect(result.created).toBe(true);
    expect(result.file).toBe(path.join(root, "supervisor/supervisor.json"));
    expect(JSON.parse(await fs.readFile(result.file, "utf8"))).toMatchObject({
      host: "127.0.0.1",
      port: 18789,
      slotPorts: [19001, 19041],
      stateDir: path.join(root, ".openclaw"),
      configPath: path.join(root, ".openclaw/openclaw.json"),
      initialRelease: params.release,
      journal: path.join(root, "supervisor/deployment-state.json"),
    });
    expect(params.secureDirectory).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(root, ".openclaw/openclaw.json"), "utf8")).toBe(
      "{ /* existing */ }",
    );
  });

  it("preserves an existing supervisor config and journal when preparing another release", async () => {
    const params = options();
    const first = await initializeDeployConfig(params);
    const bytes = await fs.readFile(first.file, "utf8");
    const journal = path.join(root, "supervisor/deployment-state.json");
    await fs.writeFile(journal, "running");
    const next = await initializeDeployConfig({ ...params, release: path.join(root, "002") });
    expect(next.created).toBe(false);
    expect(await fs.readFile(first.file, "utf8")).toBe(bytes);
    expect(await fs.readFile(journal, "utf8")).toBe("running");
    expect(params.secureDirectory).toHaveBeenCalledOnce();
  });

  it("honors explicit state and config environment paths", async () => {
    const config = path.join(root, "custom.json");
    await fs.writeFile(config, "{}");
    const result = await initializeDeployConfig({
      ...options(),
      env: {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: config,
      },
    });
    expect(JSON.parse(await fs.readFile(result.file, "utf8"))).toMatchObject({
      stateDir: root,
      configPath: config,
    });
  });

  it("fails before creating a control directory when Gateway config is missing", async () => {
    await fs.rm(path.join(root, ".openclaw/openclaw.json"));
    await expect(initializeDeployConfig(options())).rejects.toThrow("Gateway config");
    await expect(fs.stat(path.join(root, "supervisor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never writes a config if securing the new directory fails", async () => {
    await expect(
      initializeDeployConfig({
        ...options(),
        secureDirectory: async () => {
          throw new Error("ACL failed");
        },
      }),
    ).rejects.toThrow("ACL failed");
    await expect(fs.stat(path.join(root, "supervisor/supervisor.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to repurpose an existing directory without a config", async () => {
    await fs.mkdir(path.join(root, "supervisor"));
    const params = options();
    await expect(initializeDeployConfig(params)).rejects.toThrow("already exists");
    expect(params.secureDirectory).not.toHaveBeenCalled();
  });

  it("rejects a release named supervisor rather than writing inside it", async () => {
    await expect(
      initializeDeployConfig({ ...options(), release: path.join(root, "supervisor") }),
    ).rejects.toThrow("release directory");
  });

  it("rejects a directory in place of the supervisor config", async () => {
    await fs.mkdir(path.join(root, "supervisor/supervisor.json"), { recursive: true });
    await expect(initializeDeployConfig(options())).rejects.toThrow("regular supervisor config");
  });

  it("secures a real new directory on the current platform", async () => {
    const directory = path.join(root, "private control");
    await fs.mkdir(directory);
    await secureDeployDirectory(directory);
    await fs.writeFile(path.join(directory, "writable"), "ok");
    expect(await fs.readFile(path.join(directory, "writable"), "utf8")).toBe("ok");
  });
});
