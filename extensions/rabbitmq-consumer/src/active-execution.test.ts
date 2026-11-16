import path from "node:path";
import { expect, it } from "vitest";
import {
  isInactiveExecution,
  registerActiveExecution,
  scopeExecutionTool,
} from "./active-execution.js";

it("blocks cancelled, settled, and orphan executions without blocking the next turn", () => {
  const old = "agent:rabbitmq-42:rabbitmq:42:s1:turn:1";
  const next = "agent:rabbitmq-42:rabbitmq:42:s1:turn:2";
  const controller = new AbortController();
  expect(isInactiveExecution(old)).toBe(true);
  const closeOld = registerActiveExecution(old, controller.signal);
  const closeNext = registerActiveExecution(next);
  try {
    expect(isInactiveExecution(old)).toBe(false);
    controller.abort();
    expect(isInactiveExecution(old)).toBe(true);
    expect(isInactiveExecution(next)).toBe(false);
    expect(isInactiveExecution("agent:main:main")).toBe(false);
  } finally {
    closeOld();
    closeNext();
  }
  expect(isInactiveExecution(next)).toBe(true);
});

it("scopes artifact tools to the current execution and rejects writes to sibling turns", () => {
  const key = "agent:rabbitmq-42:rabbitmq:42:s1:turn:1";
  const directory = path.resolve("workspace/runs/1");
  const close = registerActiveExecution(key, undefined, directory);
  try {
    expect(scopeExecutionTool(key, "write", { path: "report.json", content: "x" })).toEqual({
      params: { path: path.join(directory, "report.json"), content: "x" },
    });
    expect(scopeExecutionTool(key, "edit", { file_path: "../2/report.json" })).toMatchObject({
      block: true,
    });
    expect(
      scopeExecutionTool(key, "exec", { command: "python build.py", workdir: "elsewhere" }),
    ).toEqual({ params: { command: "python build.py", workdir: directory } });
    expect(scopeExecutionTool(key, "read", { path: "shared-input.json" })).toBeUndefined();
  } finally {
    close();
  }
});
