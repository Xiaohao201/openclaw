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
export type ComplaintPrepareStep =
  | "wait_report_entry"
  | "hover_more"
  | "open_report"
  | "wait_report_form"
  | "select_category"
  | "fill_description"
  | "verify_description"
  | "check_submit";
export type ComplaintVerification =
  | { confirmed: true }
  | { confirmed: false; errorCode: "RECEIPT_UNCONFIRMED"; message: string }
  | {
      confirmed: false;
      errorCode: "FORM_VALIDATION_FAILED";
      validationError:
        | "DESCRIPTION_REQUIRED"
        | "DESCRIPTION_TOO_LONG"
        | "CATEGORY_REQUIRED"
        | "OTHER";
      message: string;
    };
export interface ComplaintDriver {
  navigate(): Promise<void>;
  checkLogin(): Promise<boolean>;
  prepare(onStep?: (step: ComplaintPrepareStep) => void): Promise<void>;
  submit(): Promise<void>;
  verify(): Promise<boolean | ComplaintVerification>;
  screenshot(): Promise<NonNullable<LocalOutcome["screenshot"]>>;
  release(): Promise<void>;
}
export class ComplaintNeedsOperator extends Error {
  constructor(
    readonly code:
      | "CATEGORY_REQUIRED"
      | "CAPTCHA_REQUIRED"
      | "MATERIAL_REQUIRED"
      | "REASON_TOO_LONG"
      | "DESCRIPTION_WRITE_FAILED"
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
  let prepareStep: ComplaintPrepareStep | undefined;
  const deadline = Date.now() + params.timeoutMs;
  const checkpoint = (next: ExecutionStage) => {
    stage = next;
    if (next !== "prepare") {
      prepareStep = undefined;
    }
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
    await driver.prepare((step) => {
      prepareStep = step;
      params.log({ stage: "prepare", step });
    });
    checkpoint("submit");
    attempted = true;
    await driver.submit();
    checkpoint("verify");
    const receipt = await driver.verify();
    // Existing platform adapters may still return a boolean receipt.
    const verification: ComplaintVerification =
      typeof receipt === "boolean"
        ? receipt
          ? { confirmed: true }
          : {
              confirmed: false,
              errorCode: "RECEIPT_UNCONFIRMED",
              message: "已尝试提交但未观察到成功提示，请人工核对，勿自动重提。",
            }
        : receipt;
    confirmed = verification.confirmed;
    const result: LocalOutcome = verification.confirmed
      ? { state: "done", message: "已观察到平台提交成功提示；不代表已受理或处置。", offline: null }
      : {
          state: "unknown",
          message: verification.message,
          errorCode: verification.errorCode,
          offline: null,
        };
    params.log({
      stage: "verify",
      event: "verification_result",
      attempted,
      confirmed,
      state: result.state,
      ...(!verification.confirmed ? { errorCode: verification.errorCode } : {}),
      ...(!verification.confirmed && verification.errorCode === "FORM_VALIDATION_FAILED"
        ? { validationError: verification.validationError }
        : {}),
    });
    try {
      checkpoint("evidence");
      result.screenshot = await driver.screenshot();
    } catch (error) {
      params.log({ stage: "evidence", ...safeErrorFields(error) });
      result.evidenceError = "SCREENSHOT_CAPTURE_FAILED";
    }
    return result;
  } catch (error) {
    params.log({
      stage,
      ...(prepareStep ? { step: prepareStep } : {}),
      attempted,
      confirmed,
      ...safeErrorFields(error),
    });
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
