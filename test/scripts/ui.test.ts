import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeWindowsShellArgs,
  createUiSpawnSpec,
  shouldUseShellForCommand,
} from "../../scripts/ui.js";

describe("scripts/ui windows spawn behavior", () => {
  it("quotes the command path and forwarded arguments without shell:true", () => {
    const spec = createUiSpawnSpec("C:\\Program Files\\pnpm\\pnpm.cmd", ["run", "build", "a b"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\pnpm\\pnpm.cmd" run build "a b""',
    ]);
    expect(spec.options.shell).toBe(false);
    expect(spec.options.windowsVerbatimArguments).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "executes a launcher in a spaced directory without splitting arguments",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "openclaw ui spaces "));
      try {
        const script = path.join(directory, "echo args.cjs");
        const launcher = path.join(directory, "pnpm.cmd");
        writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
        writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
        const spec = createUiSpawnSpec(launcher, ["run", "build", "argument with spaces"], {
          cwd: directory,
          stdio: "pipe",
        });
        const result = spawnSync(spec.command, spec.args, { ...spec.options, encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["run", "build", "argument with spaces"]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("enables shell for Windows command launchers that require cmd.exe", () => {
    expect(
      shouldUseShellForCommand("C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.CMD", "win32"),
    ).toBe(true);
    expect(shouldUseShellForCommand("C:\\tools\\pnpm.bat", "win32")).toBe(true);
  });

  it("does not enable shell for non-shell launchers", () => {
    expect(shouldUseShellForCommand("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/local/bin/pnpm", "linux")).toBe(false);
  });

  it("allows safe forwarded args when shell mode is required on Windows", () => {
    expect(() =>
      assertSafeWindowsShellArgs(["run", "build", "--filter", "@openclaw/ui"], "win32"),
    ).not.toThrow();
  });

  it("rejects dangerous forwarded args when shell mode is required on Windows", () => {
    expect(() => assertSafeWindowsShellArgs(["run", "build", "evil&calc"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
    expect(() => assertSafeWindowsShellArgs(["run", "build", "%PATH%"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
  });

  it("does not reject args on non-windows platforms", () => {
    expect(() => assertSafeWindowsShellArgs(["contains&metacharacters"], "linux")).not.toThrow();
  });
});
