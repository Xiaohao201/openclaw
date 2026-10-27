import type { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactManifestName,
  verifyDeployArtifact,
  writeDeployArtifact,
} from "../../scripts/deploy-artifact.js";
import { prepareDeployRelease, runDeployCommand } from "../../scripts/deploy-prepare.js";

const commit = "a".repeat(40);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-deploy-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(directory: string) {
  await fs.mkdir(path.join(directory, "dist/control-ui/assets"), { recursive: true });
  for (const [file, content] of Object.entries({
    "package.json": JSON.stringify({ version: "0.0.0-test" }),
    "openclaw.mjs": "// entry",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "dist/entry.js": "// built",
    "dist/control-ui/index.html": "<html></html>",
    "dist/control-ui/assets/main.js": "// ui",
  })) {
    await fs.writeFile(path.join(directory, file), content);
  }
}

describe("deployment artifact", () => {
  it("detects added and removed build files", async () => {
    await fixture(root);
    await writeDeployArtifact(root, commit);
    const extra = path.join(root, "dist/extra.js");
    await fs.writeFile(extra, "unexpected");
    await expect(verifyDeployArtifact(root)).rejects.toThrow("file list");
    await fs.rm(extra);
    await fs.rm(path.join(root, "dist/control-ui/assets/main.js"));
    await expect(verifyDeployArtifact(root)).rejects.toThrow("Missing Control UI assets");
  });
  it("verifies an unchanged artifact and detects altered code", async () => {
    await fixture(root);
    await writeDeployArtifact(root, commit);
    await verifyDeployArtifact(root);
    await fs.writeFile(path.join(root, "dist/entry.js"), "changed");
    await expect(verifyDeployArtifact(root)).rejects.toThrow("checksum mismatch");
  });

  it("rejects added files and never opens manifest-supplied paths", async () => {
    await fixture(root);
    await writeDeployArtifact(root, commit);
    const file = path.join(root, artifactManifestName);
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.files[0].path = "../../outside";
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(verifyDeployArtifact(root)).rejects.toThrow("file list");
  });

  it("requires backend and UI output before certifying a candidate", async () => {
    await fixture(root);
    await fs.rm(path.join(root, "dist/control-ui/index.html"));
    await expect(writeDeployArtifact(root, commit)).rejects.toThrow("Missing built artifact");
    await expect(fs.stat(path.join(root, artifactManifestName))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects runtime mismatch and refuses to overwrite an existing manifest", async () => {
    await fixture(root);
    await writeDeployArtifact(root, commit);
    await expect(writeDeployArtifact(root, commit)).rejects.toMatchObject({ code: "EEXIST" });
    const file = path.join(root, artifactManifestName);
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.arch = "different";
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(verifyDeployArtifact(root)).rejects.toThrow("does not match");
  });
});

describe("deployment command", () => {
  it("requires an explicit operation and rejects ambiguous or unknown options", async () => {
    await expect(runDeployCommand([])).rejects.toThrow("Required: --output");
    await expect(runDeployCommand(["--verify", root, "--output", root])).rejects.toThrow("either");
    await expect(runDeployCommand(["--restart"])).rejects.toThrow("Unknown option");
  });

  it("verifies existing artifacts without building or switching a service", async () => {
    await fixture(root);
    await writeDeployArtifact(root, commit);
    const prepare = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDeployCommand(["--verify", root], prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no service was started or switched"));
    await fs.writeFile(path.join(root, "dist/entry.js"), "tampered");
    await expect(runDeployCommand(["--verify", root], prepare)).rejects.toThrow(
      "checksum mismatch",
    );
  });

  it("passes the explicit release directory to preparation and propagates failure", async () => {
    const prepare = vi.fn().mockResolvedValue(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runDeployCommand(["--source", root, "--output", `${root}-release`], prepare);
    expect(prepare).toHaveBeenCalledWith({ source: root, output: `${root}-release` });
    prepare.mockRejectedValue(new Error("build failed"));
    await expect(runDeployCommand(["--output", root], prepare)).rejects.toThrow("build failed");
  });
});

describe("isolated release preparation", () => {
  it.each(["success", "archive-error", "archive-exit", "install-error", "install-exit"])(
    "runs the process adapter with isolated cwd and fails closed: %s",
    async (outcome) => {
      const source = path.join(root, "source");
      const built = path.join(root, "fixture");
      const output = path.join(root, "release");
      await fs.mkdir(source);
      await fixture(built);
      let invocation = 0;
      const spawn = vi.fn<typeof spawnSync>().mockImplementation((command, args, options) => {
        invocation += 1;
        if (invocation >= 4) {
          expect(options?.cwd).toBe(output);
          expect(options?.windowsHide).toBe(true);
        }
        const fail =
          (invocation === 2 && outcome.startsWith("archive-")) ||
          (invocation === 4 && outcome.startsWith("install-"));
        if (command === "git" && args?.[0] === "archive" && !fail) {
          writeFileSync(path.join(output, "source.tar"), "fixture");
        }
        if (command === "tar") {
          cpSync(built, output, { recursive: true });
        }
        return {
          pid: 1,
          status: fail ? 1 : 0,
          signal: null,
          output: [],
          stdout: commit,
          stderr: "",
          ...(fail && outcome.endsWith("error") ? { error: new Error("spawn failed") } : {}),
        } as ReturnType<typeof spawnSync>;
      });
      const preparing = prepareDeployRelease({ source, output, spawn });
      if (outcome === "success") {
        await preparing;
        await verifyDeployArtifact(output);
        expect(spawn).toHaveBeenCalledTimes(7);
      } else {
        await expect(preparing).rejects.toThrow(/failed/);
        await expect(fs.stat(path.join(output, artifactManifestName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await fs.readdir(source)).toEqual([]);
    },
  );
  it("rejects a directory without a committed source revision", async () => {
    const output = `${root}-release`;
    await expect(prepareDeployRelease({ source: root, output })).rejects.toThrow(
      "Cannot resolve source HEAD",
    );
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("builds only in the new directory and verifies before declaring completion", async () => {
    const source = path.join(root, "source");
    const built = path.join(root, "fixture");
    const output = path.join(root, "release candidate");
    await fs.mkdir(source);
    await fixture(built);
    const run = vi.fn((command: string, args: string[], cwd: string) => {
      if (command === "git") {
        writeFileSync(path.join(output, "source.tar"), "fixture");
      } else if (command === "tar") {
        cpSync(built, output, { recursive: true });
      } else {
        expect(cwd).toBe(output);
        expect(args.join(" ")).not.toMatch(/gateway|restart|stop/);
      }
    });
    expect(await prepareDeployRelease({ source, output, run, resolveCommit: () => commit })).toBe(
      output,
    );
    await verifyDeployArtifact(output);
    expect(run).toHaveBeenCalledTimes(6);
    expect(await fs.readdir(source)).toEqual([]);
    await expect(fs.stat(path.join(output, "source.tar"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an invalid commit before creating the destination", async () => {
    const source = path.join(root, "source");
    const output = path.join(root, "release");
    await fs.mkdir(source);
    await expect(
      prepareDeployRelease({ source, output, resolveCommit: () => "--invalid" }),
    ).rejects.toThrow("Invalid source commit");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects destinations inside or containing the source before running commands", async () => {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const run = vi.fn();
    for (const output of [source, path.join(source, "release"), root]) {
      await expect(prepareDeployRelease({ source, output, run })).rejects.toThrow("outside");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("never reuses an existing release", async () => {
    const source = path.join(root, "source");
    const output = path.join(root, "release");
    await fs.mkdir(source);
    await fs.mkdir(output);
    const run = vi.fn();
    await expect(
      prepareDeployRelease({ source, output, run, resolveCommit: () => commit }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves running source bytes unchanged when preparation fails", async () => {
    const source = path.join(root, "source");
    const output = path.join(root, "release");
    await fixture(source);
    const run = vi.fn(() => {
      throw new Error("archive failed");
    });
    await expect(
      prepareDeployRelease({ source, output, run, resolveCommit: () => commit }),
    ).rejects.toThrow("archive failed");
    expect(await fs.readFile(path.join(source, "dist/entry.js"), "utf8")).toBe("// built");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([
      "git",
      ["archive", "--format=tar", `--output=${path.join(output, "source.tar")}`, commit],
      await fs.realpath(source),
    ]);
    await expect(fs.stat(path.join(output, artifactManifestName))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
