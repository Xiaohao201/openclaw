import { safeErrorFields } from "../complaint-diagnostics.js";
import type { LocalOutcome } from "../complaint-local-contract.js";

export type ExecutionStage =
  | "attach"
  | "navigate"
  | "login"
  | "prepare"
  | "submit"
  | "verify"
  | "evidence";
export interface ComplaintDriver {
  navigate(): Promise<void>;
  checkLogin(): Promise<boolean>;
  prepare(): Promise<void>;
  submit(): Promise<void>;
  verify(): Promise<boolean>;
  screenshot(): Promise<NonNullable<LocalOutcome["screenshot"]>>;
  release(): Promise<void>;
}
export class ComplaintNeedsOperator extends Error {
  constructor(
    readonly code:
      | "CATEGORY_REQUIRED"
      | "CAPTCHA_REQUIRED"
      | "MATERIAL_REQUIRED"
      | "TARGET_UNAVAILABLE"
      | "BROWSER_HANDOFF_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

/** No retries: a submit attempt is an irreversible boundary even when the click throws. */
export async function executeNativeComplaint(params: {
  acquire: () => Promise<ComplaintDriver>;
  signal: AbortSignal;
  timeoutMs: number;
  log: (event: Record<string, unknown>) => void;
}): Promise<LocalOutcome> {
  let driver: ComplaintDriver | undefined;
  let stage: ExecutionStage = "attach";
  let attempted = false;
  let confirmed = false;
  const deadline = Date.now() + params.timeoutMs;
  const checkpoint = (next: ExecutionStage) => {
    stage = next;
    if (params.signal.aborted || Date.now() >= deadline) {
      throw new Error("Execution interrupted");
    }
    params.log({ stage });
  };
  try {
    checkpoint("attach");
    driver = await params.acquire();
    checkpoint("navigate");
    await driver.navigate();
    checkpoint("login");
    if (!(await driver.checkLogin())) {
      return {
        state: "manual_required",
        message: "尚未确认当前标签页已登录，请完成登录后核验。",
        errorCode: "LOGIN_REQUIRED",
        offline: null,
      };
    }
    checkpoint("prepare");
    await driver.prepare();
    checkpoint("submit");
    attempted = true;
    await driver.submit();
    checkpoint("verify");
    confirmed = await driver.verify();
    const result: LocalOutcome = confirmed
      ? { state: "done", message: "已观察到平台提交成功提示；不代表已受理或处置。", offline: null }
      : {
          state: "unknown",
          message: "已尝试提交但未观察到成功提示，请人工核对，勿自动重提。",
          errorCode: "RECEIPT_UNCONFIRMED",
          offline: null,
        };
    try {
      checkpoint("evidence");
      result.screenshot = await driver.screenshot();
    } catch (error) {
      params.log({ stage: "evidence", ...safeErrorFields(error) });
      result.evidenceError = "SCREENSHOT_CAPTURE_FAILED";
    }
    return result;
  } catch (error) {
    params.log({ stage, attempted, confirmed, ...safeErrorFields(error) });
    if (!attempted && error instanceof ComplaintNeedsOperator) {
      return {
        state: "manual_required",
        message: error.message,
        errorCode: error.code,
        offline: null,
      };
    }
    return {
      state: attempted ? "unknown" : "failed",
      message: attempted
        ? `阶段 ${stage} 中断，提交结果未知，请人工核对，禁止自动重提。`
        : `阶段 ${stage} 中断，未尝试提交。`,
      errorCode: params.signal.aborted
        ? "EXECUTION_CANCELLED"
        : Date.now() >= deadline
          ? "EXECUTION_TIMEOUT"
          : "EXECUTION_INTERRUPTED",
      offline: null,
    };
  } finally {
    // Await in-flight actions before releasing ownership; cleanup cannot erase a receipt.
    try {
      await driver?.release();
    } catch (error) {
      params.log({ stage: "release", ...safeErrorFields(error) });
    }
  }
}
