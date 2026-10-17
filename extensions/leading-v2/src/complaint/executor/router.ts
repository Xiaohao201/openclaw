import type { LocalComplaintItem, LocalConfig } from "../complaint-local-contract.js";
import { localPlatforms, type LocalOutcome } from "../complaint-local-contract.js";
import type { RunComplaint } from "./types.js";

export const complaintEngine = (_item: LocalComplaintItem): "typescript" => "typescript";

export async function checkComplaintRuntime(
  _config: LocalConfig,
  items: LocalComplaintItem[],
): Promise<LocalOutcome | null> {
  return items.every(
    (item) => Object.hasOwn(localPlatforms, item.platform) || item.platform === "report12377",
  )
    ? null
    : {
        state: "failed",
        message: "不支持的举报平台，未执行。",
        errorCode: "UNSUPPORTED_PLATFORM",
        offline: null,
      };
}

/** Migration routing is chosen once, never as a fallback after execution failure. */
export const runComplaint: RunComplaint = async (params) => {
  const { runNativeComplaint } = await import("./native.runtime.js");
  return runNativeComplaint(params);
};
