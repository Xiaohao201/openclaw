import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalConfig } from "./complaint-local-contract.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "complaint-python-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const managedPython = () =>
  join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

describe("complaint Python selection", () => {
  it("uses the runtime's installed environment for both login and reporting", async () => {
    const executable = managedPython();
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    expect(resolveLocalConfig({}, root).python).toBe(executable);
    expect(
      resolveLocalConfig({ complaintExecution: { runtimeDir: join(root, "python") } }).python,
    ).toBe(executable);
  });

  it("preserves an explicitly configured interpreter", async () => {
    await mkdir(dirname(managedPython()), { recursive: true });
    await writeFile(managedPython(), "fixture");
    expect(
      resolveLocalConfig({ complaintExecution: { python: "operator-python" } }, root).python,
    ).toBe("operator-python");
  });

  it("does not select an uninstalled environment or a directory as an executable", async () => {
    expect(resolveLocalConfig({}, root).python).toBe("python");
    await mkdir(managedPython(), { recursive: true });
    expect(resolveLocalConfig({}, root).python).toBe("python");
  });
});
