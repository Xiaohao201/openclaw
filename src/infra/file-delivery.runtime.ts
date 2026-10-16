import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExtension, resolveOssConfig, uploadFileToOss } from "./aliyun-oss.js";
import type { FileDeliveryRequestV1, FileDeliveryResultV1 } from "./file-delivery.types.js";

export async function uploadFileForDelivery(
  request: FileDeliveryRequestV1,
): Promise<FileDeliveryResultV1> {
  const config = resolveOssConfig();
  if (!config) {
    throw new Error("File delivery storage is not configured");
  }
  const extension = fileExtension(request.displayName);
  if (
    request.version !== 1 ||
    !(request.data instanceof Uint8Array) ||
    !request.data.byteLength ||
    !Number.isFinite(config.maxFileSizeMb) ||
    config.maxFileSizeMb <= 0 ||
    request.data.byteLength > config.maxFileSizeMb * 1024 * 1024 ||
    !/^[a-z0-9]+$/.test(extension) ||
    !config.allowedExtensions.includes(extension)
  ) {
    throw new Error("File delivery artifact exceeds configured type or size limits");
  }
  // The host uploader reads a private snapshot, never a plugin-supplied file path.
  const directory = await mkdtemp(join(tmpdir(), "openclaw-file-delivery-"));
  try {
    const localPath = join(directory, `artifact.${extension}`);
    await writeFile(localPath, request.data, { flag: "wx", mode: 0o600 });
    const result = await uploadFileToOss({
      config,
      localPath,
      displayName: request.displayName,
      fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
    });
    return { version: 1, ...result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
