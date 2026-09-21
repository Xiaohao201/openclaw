import { XMLParser, XMLValidator } from "fast-xml-parser";

export type Bounds = { left: number; top: number; width: number; height: number };
export type Gallery = { page: number; total: number; bounds: Bounds };
export function uiNodes(xml: string): Record<string, unknown>[] {
  if (
    xml.length > 2_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new Error("Invalid or oversized Android UI XML.");
  }
  const root: unknown = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    processEntities: true,
  }).parse(xml);
  const nodes: Record<string, unknown>[] = [];
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value.toReversed());
    } else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      nodes.push(node);
      pending.push(...Object.values(node).toReversed());
    }
  }
  return nodes;
}

export function findGallery(xml: string, packageName: string): Gallery | undefined {
  for (const node of uiNodes(xml)) {
    if (node["@_package"] !== packageName || node["@_visible-to-user"] === "false") {
      continue;
    }
    const desc = String(node["@_content-desc"] ?? "");
    const match = /图片[,，]\s*第\s*(\d+)\s*张[,，]\s*共\s*(\d+)\s*张/.exec(desc);
    const rect = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(String(node["@_bounds"] ?? ""));
    if (!match || !rect) {
      continue;
    }
    const [page, total] = [Number(match[1]), Number(match[2])];
    const [left, top, right, bottom] = rect.slice(1).map(Number);
    if (
      page < 1 ||
      page > total ||
      total > 100 ||
      right - left < 100 ||
      bottom - top < 100 ||
      right > 16000 ||
      bottom > 16000
    ) {
      continue;
    }
    return { page, total, bounds: { left, top, width: right - left, height: bottom - top } };
  }
  return undefined;
}

export type Screenshot = { path: string; page?: number; total?: number };
type StopReason =
  | "complete"
  | "image_limit"
  | "no_gallery"
  | "page_did_not_advance"
  | "duplicate_image"
  | "capture_failed";
export async function collectGallery(params: {
  initialXml: string;
  packageName: string;
  maxImages: number;
  readUi: () => Promise<string>;
  swipe: (bounds: Bounds) => Promise<void>;
  pause: (ms: number) => Promise<unknown>;
  assertForeground: () => Promise<void>;
  capture: (bounds?: Bounds) => Promise<{ path: string; hash: string }>;
  signal?: AbortSignal;
}) {
  const images: Screenshot[] = [];
  const seen = new Set<string>();
  let gallery = findGallery(params.initialXml, params.packageName);
  const firstPage = gallery?.page;
  let stopReason: StopReason = "image_limit";
  try {
    for (let index = 0; index < params.maxImages; index++) {
      params.signal?.throwIfAborted();
      await params.assertForeground();
      const screenshot = await params.capture(gallery?.bounds);
      await params.assertForeground();
      if (seen.has(screenshot.hash)) {
        stopReason = "duplicate_image";
        break;
      }
      seen.add(screenshot.hash);
      images.push({
        path: screenshot.path,
        ...(gallery ? { page: gallery.page, total: gallery.total } : {}),
      });
      if (!gallery) {
        stopReason = "no_gallery";
        break;
      }
      if (gallery.page === gallery.total) {
        stopReason = "complete";
        break;
      }
      if (images.length >= params.maxImages) {
        break;
      }
      await params.assertForeground();
      await params.swipe(gallery.bounds);
      let next: Gallery | undefined;
      for (let retry = 0; retry < 3; retry++) {
        await params.pause(1000);
        await params.assertForeground();
        next = findGallery(await params.readUi(), params.packageName);
        if (next?.page === gallery.page + 1 && next.total === gallery.total) {
          break;
        }
      }
      if (!next || next.page !== gallery.page + 1 || next.total !== gallery.total) {
        stopReason = "page_did_not_advance";
        break;
      }
      gallery = next;
    }
  } catch {
    params.signal?.throwIfAborted();
    stopReason = "capture_failed";
  }
  return { images, stopReason, complete: stopReason === "complete" && firstPage === 1 };
}
