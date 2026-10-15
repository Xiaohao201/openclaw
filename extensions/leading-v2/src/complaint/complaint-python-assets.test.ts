import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("ships complete Python entrypoints in the declared build assets", async () => {
  const result = await promisify(execFile)(
    "python",
    ["-X", "utf8", "-m", "unittest", "test_packaged_runtime"],
    {
      cwd: fileURLToPath(new URL("../../python/", import.meta.url)),
      timeout: 15_000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  expect(result.stderr).toContain("OK");
});
