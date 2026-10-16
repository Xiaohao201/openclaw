import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createExecutorDiagnosticStream, safeErrorFields } from "./complaint-diagnostics.js";
import {
  localOutcomeSchema,
  type LocalConfig,
  type LocalComplaintItem,
  type LocalOutcome,
} from "./complaint-local-contract.js";
import type { BrowserHandoff } from "./complaint-session-handoff.js";

export type RunLocalComplaint = (params: {
  item: LocalComplaintItem;
  sessionDir: string;
  config: LocalConfig;
  signal: AbortSignal;
  browserHandoff?: BrowserHandoff;
  diagnosticContext?: { batchId: string; taskId?: number | null };
}) => Promise<LocalOutcome>;

export function complaintProcessEnv(config: LocalConfig) {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    OPENCLAW_COMPLAINT_ALLOW_FAKE_IP: config.allowFakeIp ? "1" : "0",
  };
}

export async function checkLocalComplaintRuntime(
  config: LocalConfig,
): Promise<LocalOutcome | null> {
  try {
    if ((await stat(join(config.runtimeDir, "runner.py"))).isFile()) {
      return null;
    }
  } catch {
    // Missing or unreadable files cannot be executed.
  }
  return {
    state: "failed",
    message:
      "缺少可读取的 Python 执行器 runner.py，请安装完整插件或配置 complaintExecution.runtimeDir。",
    offline: null,
    errorCode: "RUNTIME_MISSING",
  };
}

/** JSON travels over stdin, never through shell interpolation or command-line arguments. */
export const runLocalComplaint: RunLocalComplaint = async ({
  item,
  sessionDir,
  config,
  signal,
  browserHandoff,
  diagnosticContext,
}) => {
  const log = createSubsystemLogger("complaint/executor");
  const unavailable = await checkLocalComplaintRuntime(config);
  if (unavailable) {
    return unavailable;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ["-u", join(config.runtimeDir, "runner.py")], {
      cwd: config.runtimeDir,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      env: complaintProcessEnv(config),
    });
    let output = "";
    let overflow = false;
    let timedOut = false;
    const context = { ...diagnosticContext, pid: child.pid };
    log.info(`process-start ${JSON.stringify(context)}`);
    child.stderr.setEncoding("utf8");
    child.stderr.on(
      "data",
      createExecutorDiagnosticStream((event) => {
        log.info(`stage ${JSON.stringify({ ...context, ...event })}`);
      }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, config.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 65536) {
        overflow = true;
        output = "";
        child.kill();
      }
    });
    child.stdin.on("error", () => {
      /* Exit/error below determines the outcome. */
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      log.warn(`process-error ${JSON.stringify({ ...context, ...safeErrorFields(error) })}`);
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        resolve({
          state: "failed",
          message: "找不到 Python 或执行目录，请检查 complaintExecution 配置。",
          offline: null,
          errorCode: "RUNTIME_MISSING",
        });
      } else {
        reject(error);
      }
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      log.info(
        `process-exit ${JSON.stringify({ ...context, code, exitSignal, overflow, timedOut, aborted: signal.aborted })}`,
      );
      if (code !== 0 || overflow || timedOut || signal.aborted) {
        reject(new Error("Local complaint process interrupted; submission may be unknown."));
        return;
      }
      try {
        const result = localOutcomeSchema.parse(JSON.parse(output));
        if (["pending", "running"].includes(result.state)) {
          throw new Error("Nonterminal result");
        }
        resolve(result);
      } catch (error) {
        log.warn(`invalid-result ${JSON.stringify({ ...context, ...safeErrorFields(error) })}`);
        reject(error);
      }
    });
    child.stdin.end(
      JSON.stringify({
        ...item,
        sessionDir,
        headless: config.headless,
        phone: config.phone,
        browserHandoff,
      }),
    );
  });
};
