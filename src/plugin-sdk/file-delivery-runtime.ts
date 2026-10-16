import type { FileDeliveryRequestV1, FileDeliveryResultV1 } from "../infra/file-delivery.types.js";

export type { FileDeliveryRequestV1, FileDeliveryResultV1 } from "../infra/file-delivery.types.js";

/** Upload authorized artifact bytes using the host's configured file delivery storage. */
export async function uploadFileForDelivery(
  request: FileDeliveryRequestV1,
): Promise<FileDeliveryResultV1> {
  const runtime = await import("../infra/file-delivery.runtime.js");
  return runtime.uploadFileForDelivery(request);
}
