import { safeErrorFields } from "../complaint-diagnostics.js";
import type { LocalOutcome } from "../complaint-local-contract.js";
import { contentIdentity } from "../platforms/targets.js";
export interface PhonePort {
  open(identity: string): Promise<void>;
  tap(label: string): Promise<void>;
  copiedLink(): Promise<string>;
  openReport(): Promise<void>;
  selectCategory(category: string, subCategory?: string): Promise<void>;
  fillReason(reason: string): Promise<void>;
  texts(): Promise<string[]>;
  checkSubmitReady(): Promise<void>;
}
export async function submitPhone(
  phone: PhonePort,
  item: { link: string; category: string; subCategory?: string; reason: string },
  preflight = false,
  log: (event: Record<string, unknown>) => void = () => {},
): Promise<LocalOutcome> {
  let attempted = false;
  let stage = "phone_target";
  const checkpoint = (next: string) => {
    stage = next;
    log({ stage });
  };
  try {
    const identity = contentIdentity("xiaohongshu", item.link);
    if (!identity) {
      throw new Error("Missing note identity");
    }
    checkpoint("phone_open");
    await phone.open(identity);
    await phone.tap("更多");
    checkpoint("phone_identity");
    if (contentIdentity("xiaohongshu", await phone.copiedLink()) !== identity) {
      throw new Error("Copied note differs from target");
    }
    await phone.openReport();
    checkpoint("phone_category");
    await phone.selectCategory(item.category, item.subCategory);
    checkpoint("phone_description");
    await phone.fillReason(item.reason);
    const texts = await phone.texts();
    if (
      !texts.includes("提交") ||
      !texts.some((text) => text.includes("举报")) ||
      texts.some((text) => ["举报成功", "提交成功"].includes(text))
    ) {
      throw new Error("Invalid submit screen");
    }
    await phone.checkSubmitReady();
    if (preflight) {
      return {
        state: "not_submitted",
        message: "手机预检完成，停在提交前。",
        errorCode: "PHONE_PREFLIGHT_READY",
        offline: null,
      };
    }
    attempted = true;
    checkpoint("phone_submit");
    await phone.tap("提交");
    checkpoint("phone_receipt");
    for (let count = 0; count < 3; count++) {
      if ((await phone.texts()).some((text) => ["举报成功", "提交成功"].includes(text))) {
        return {
          state: "done",
          message: "已观察到手机端举报成功提示，不代表平台处置。",
          offline: null,
        };
      }
    }
  } catch (error) {
    log({ stage, attempted, ...safeErrorFields(error) });
    /* Never retry an attempted click or expose device content in errors. */
  }
  return {
    state: attempted ? "unknown" : "manual_required",
    message: attempted
      ? "手机提交结果未知，请核查，禁止自动重投。"
      : "手机目标、分类或操作条件未核实，请本人检查，未提交。",
    errorCode: attempted ? "PHONE_RESULT_UNKNOWN" : "PHONE_MANUAL_REQUIRED",
    offline: null,
  };
}
