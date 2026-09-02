import { describe, expect, it } from "vitest";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VALUE,
  OPENCLAW_CLI_ENV_VAR,
} from "./openclaw-exec-env.js";

describe("markOpenClawExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", OPENCLAW_CLI: "0" };
    const marked = markOpenClawExecEnv(env, "linux");

    expect(marked).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.OPENCLAW_CLI).toBe("0");
  });

  it("defaults Python stdio to UTF-8 for Windows exec children", () => {
    expect(markOpenClawExecEnv({ PATH: "C:\\Windows" }, "win32")).toEqual({
      PATH: "C:\\Windows",
      PYTHONIOENCODING: "utf-8",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
  });

  it.each(["PYTHONIOENCODING", "pythonioencoding"])(
    "preserves an explicit %s value on Windows",
    (key) => {
      const marked = markOpenClawExecEnv({ [key]: "cp936" }, "win32");

      expect(marked[key]).toBe("cp936");
      expect(
        Object.keys(marked).filter((candidate) => candidate.toUpperCase() === "PYTHONIOENCODING"),
      ).toHaveLength(1);
    },
  );

  it("does not inject a Python encoding on non-Windows platforms", () => {
    expect(markOpenClawExecEnv({}, "darwin")).not.toHaveProperty("PYTHONIOENCODING");
  });
});

describe("ensureOpenClawExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    },
    {
      name: "overwrites an existing marker on the provided process env",
      env: { PATH: "/usr/bin", [OPENCLAW_CLI_ENV_VAR]: "0" } as NodeJS.ProcessEnv,
    },
  ])("$name", ({ env }) => {
    expect(ensureOpenClawExecMarkerOnProcess(env)).toBe(env);
    expect(env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[OPENCLAW_CLI_ENV_VAR];
    delete process.env[OPENCLAW_CLI_ENV_VAR];

    try {
      expect(ensureOpenClawExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        delete process.env[OPENCLAW_CLI_ENV_VAR];
      } else {
        process.env[OPENCLAW_CLI_ENV_VAR] = previous;
      }
    }
  });
});
