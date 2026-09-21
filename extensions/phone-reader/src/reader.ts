import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";

export type AppRoute = { host: string; package: string };
export type PhoneOptions = { adbPath?: string; serial?: string; apps?: AppRoute[] };
type Navigation = { uri: string; package: string; detail: boolean };
type ErrorCode =
  | "invalid_url"
  | "unsupported_url"
  | "device_unavailable"
  | "device_busy"
  | "device_locked"
  | "navigation_unconfirmed"
  | "invalid_ui"
  | "no_visible_content";
export class PhoneError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function planNavigation(value: string, apps: AppRoute[]): Navigation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PhoneError("invalid_url", "Expected an HTTP(S) URL.");
  }
  if (
    value.length > 8192 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new PhoneError("invalid_url", "Use an HTTP(S) URL without credentials or a custom port.");
  }
  if (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com")) {
    const match = /^\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([a-f\d]{24})\/?$/i.exec(
      url.pathname,
    );
    if (match) {
      return {
        uri: `xhsdiscover://item/${match[1].toLowerCase()}?type=normal`,
        package: "com.xingin.xhs",
        detail: true,
      };
    }
  }
  const app = apps.find((entry) => entry.host.toLowerCase() === url.hostname);
  if (!app || !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(app.package)) {
    throw new PhoneError(
      "unsupported_url",
      "No phone app route for this URL. Expand short links with web_fetch, or configure an exact host and Android package in phone-reader.apps.",
    );
  }
  return { uri: url.href, package: app.package, detail: false };
}

// adb shell joins arguments on the device. Host execFile alone does not prevent remote shell injection.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function selectDevice(output: string, requested?: string): string {
  const devices = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[1] === "device")
    .map((row) => row[0]);
  if (requested && devices.includes(requested)) {
    return requested;
  }
  if (!requested && devices.length === 1) {
    return devices[0];
  }
  throw new PhoneError(
    "device_unavailable",
    devices.length > 1 && !requested
      ? "There are multiple phones; configure phone-reader.serial."
      : "Connect and authorize the selected Android phone with USB debugging enabled.",
  );
}

export function parseVisibleText(xml: string, packageName: string): string[] {
  if (
    xml.length > 2_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new PhoneError("invalid_ui", "Invalid or oversized Android UI XML.");
  }
  const root: unknown = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    processEntities: true,
  }).parse(xml);
  const text = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (node["@_package"] === packageName && node["@_visible-to-user"] !== "false") {
      for (const key of ["@_text", "@_content-desc"]) {
        const item = node[key];
        if (typeof item === "string" && item.trim()) {
          text.add(item.trim());
        }
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(root);
  return [...text];
}

export function createAdbRunner(executable: string, signal?: AbortSignal) {
  return async (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { encoding: "utf8", timeout: 15_000, maxBuffer: 2_000_000, windowsHide: true, signal },
        (error, stdout) => {
          if (error) {
            reject(
              new PhoneError(
                "device_unavailable",
                "ADB failed, timed out, or was canceled. Check adbPath, USB authorization, and device state.",
              ),
            );
          } else {
            resolve(stdout);
          }
        },
      );
    });
}

const activeDevices = new Set<string>();
async function lockDevice(serial: string): Promise<() => Promise<void>> {
  if (activeDevices.has(serial)) {
    throw new PhoneError("device_busy", "Another phone read is in progress.");
  }
  activeDevices.add(serial);
  try {
    const key = createHash("sha256").update(serial).digest("hex");
    const lock = await acquireFileLock(path.join(os.tmpdir(), `openclaw-phone-${key}`), {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 180_000,
    });
    return async () => {
      try {
        await lock.release();
      } finally {
        activeDevices.delete(serial);
      }
    };
  } catch {
    activeDevices.delete(serial);
    throw new PhoneError(
      "device_busy",
      "Phone lock is unavailable or another process is reading this phone.",
    );
  }
}

type Dependencies = {
  run: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<unknown>;
  lock: (serial: string) => Promise<() => Promise<void>>;
};
export async function readPhone(
  url: string,
  options: PhoneOptions,
  deps?: Partial<Dependencies>,
  signal?: AbortSignal,
) {
  const navigation = planNavigation(url, options.apps ?? []);
  const deadline = AbortSignal.timeout(120_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const run = deps?.run ?? createAdbRunner(options.adbPath ?? "adb", combined);
  const pause = deps?.sleep ?? ((ms: number) => sleep(ms, undefined, { signal: combined }));
  const serial = selectDevice(await run(["devices"]), options.serial);
  const release = await (deps?.lock ?? lockDevice)(serial);
  const shell = (...args: string[]) => run(["-s", serial, "shell", args.map(shellQuote).join(" ")]);
  const foreground = async () => {
    const dump = await shell("dumpsys", "activity", "activities");
    return dump.split(/\r?\n/).some((line) => {
      if (!/mResumedActivity|topResumedActivity|mFocusedActivity/.test(line)) {
        return false;
      }
      const component = /\s([\w.]+)\/([^\s}]+)/.exec(line);
      return (
        component?.[1] === navigation.package &&
        (!navigation.detail || /detail/i.test(component[2]))
      );
    });
  };
  try {
    const window = await shell("dumpsys", "window", "policy");
    if (/(?:mShowingLockscreen|isStatusBarKeyguard|showing|mKeyguardShowing)=true/.test(window)) {
      throw new PhoneError("device_locked", "Unlock the phone manually before reading.");
    }
    const launch = await shell(
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      navigation.uri,
      "-p",
      navigation.package,
    );
    if (/Error:|Exception|unable to resolve/i.test(launch)) {
      throw new PhoneError(
        "navigation_unconfirmed",
        "Android could not open this URL in the configured app.",
      );
    }
    let previous: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(attempt === 0 ? 2500 : 1200);
      if (!(await foreground())) {
        continue;
      }
      const remote = `/sdcard/openclaw-phone-${randomUUID()}.xml`;
      let xml: string;
      try {
        await shell("uiautomator", "dump", remote);
        xml = await shell("cat", remote);
      } finally {
        // Cleanup still runs if the caller canceled or the operation deadline elapsed.
        const cleanup = deps?.run ?? createAdbRunner(options.adbPath ?? "adb");
        await cleanup([
          "-s",
          serial,
          "shell",
          ["rm", "-f", remote].map(shellQuote).join(" "),
        ]).catch(() => {});
      }
      if (!(await foreground())) {
        throw new PhoneError(
          "navigation_unconfirmed",
          "The foreground app changed during reading.",
        );
      }
      const text = parseVisibleText(xml, navigation.package).join("\n");
      if (text && text === previous) {
        return {
          source: "phone",
          url,
          identityVerified: false,
          scope: "current_screen",
          text: text.slice(0, 24000),
          truncated: text.length > 24000,
          warning:
            "Visible accessibility text only; target identity is unverified. This is not full article text, image OCR, video transcription, or all comments. Verify relevance and report login/error pages as failures.",
        };
      }
      previous = text;
    }
    throw new PhoneError(
      previous !== undefined ? "no_visible_content" : "navigation_unconfirmed",
      previous !== undefined
        ? "No stable accessible content was observed. Check login and page loading on the phone."
        : "The requested app detail page was not observed in the foreground.",
    );
  } finally {
    await release();
  }
}
