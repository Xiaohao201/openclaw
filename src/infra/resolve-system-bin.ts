import fs from "node:fs";
import path from "node:path";
import {
  getWindowsInstallRoots,
  getWindowsProgramFilesRoots,
  normalizeWindowsInstallRoot,
} from "./windows-install-roots.js";

/**
 * Trust level for system binary resolution.
 * - "strict": Only fixed OS-managed directories. Use for security-critical
 *   binaries like openssl where a compromised binary has high impact.
 * - "standard": Strict dirs plus common local-admin/package-manager
 *   directories appended after system dirs, plus any directory the operator
 *   opted into via `OPENCLAW_SYSTEM_BIN_DIRS`. Use for tool binaries like
 *   ffmpeg that are rarely available via the OS itself.
 */
export type SystemBinTrust = "strict" | "standard";

// Unix directories where OS-managed or system-installed binaries live.
// User-writable or package-manager-managed directories are excluded so that
// attacker-planted binaries cannot shadow legitimate system executables.
const UNIX_BASE_TRUSTED_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

// Package-manager directories appended in "standard" trust on macOS.
// These come after strict dirs so OS binaries always take priority.
// Could be acceptable for tooling binaries like ffmpeg but NOT for
// security-critical ones like openssl — callers needing higher
// assurance should stick with "strict".
const DARWIN_STANDARD_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const LINUX_STANDARD_DIRS = ["/usr/local/bin"] as const;

// Windows extensions to probe when searching for executables.
const WIN_PATHEXT = [".exe", ".cmd", ".bat", ".com"] as const;

// Operator opt-in for tool binaries installed outside the OS-managed dirs
// (a portable ffmpeg build on D:\, a pip-installed yt-dlp, ...). PATH is never
// read: trust must be declared deliberately, and only "standard" honors this.
export const SYSTEM_BIN_DIRS_ENV = "OPENCLAW_SYSTEM_BIN_DIRS";

const resolvedCacheStrict = new Map<string, string>();
const resolvedCacheStandard = new Map<string, string>();

function defaultIsExecutable(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      fs.accessSync(filePath, fs.constants.R_OK);
    } else {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

let isExecutableFn: (filePath: string) => boolean = defaultIsExecutable;

/**
 * Build the trusted-dir list for Windows. Only system-managed directories
 * are included; user-profile paths like %LOCALAPPDATA% are excluded.
 */
function buildWindowsTrustedDirs(): readonly string[] {
  const dirs: string[] = [];
  const { systemRoot } = getWindowsInstallRoots();
  dirs.push(path.win32.join(systemRoot, "System32"));
  dirs.push(path.win32.join(systemRoot, "SysWOW64"));

  for (const programFilesRoot of getWindowsProgramFilesRoots()) {
    // Trust the machine's validated Program Files roots rather than assuming C:.
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL-Win64", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "ffmpeg", "bin"));
  }

  return dirs;
}

/**
 * Build the trusted-dir list for Unix (macOS, Linux, etc.), extending
 * UNIX_BASE_TRUSTED_DIRS with platform/environment-specific paths.
 *
 * Strict: only fixed OS-managed directories.
 *
 * Standard: strict dirs plus platform package-manager directories appended
 * after, so OS binaries always take priority.
 */
function buildUnixTrustedDirs(trust: SystemBinTrust): readonly string[] {
  const dirs: string[] = [...UNIX_BASE_TRUSTED_DIRS];
  const platform = process.platform;

  if (platform === "linux") {
    // Fixed NixOS system profile path. Never derive trust from NIX_PROFILES:
    // env-controlled Nix store/profile entries can be attacker-selected.
    // Callers that intentionally rely on non-default Nix paths must opt in via extraDirs.
    dirs.push("/run/current-system/sw/bin");
    dirs.push("/snap/bin");
  }

  // "standard" trust widens the search for non-security-critical tools in
  // common local-admin/package-manager directories, while keeping strict dirs
  // first so OS binaries always take priority.
  if (trust === "standard") {
    if (platform === "darwin") {
      dirs.push(...DARWIN_STANDARD_DIRS);
    } else if (platform === "linux") {
      dirs.push(...LINUX_STANDARD_DIRS);
    }
  }

  return dirs;
}

/**
 * Normalize one `OPENCLAW_SYSTEM_BIN_DIRS` entry, rejecting anything that is not
 * a plain local absolute directory (drive-relative paths, UNC shares, injected
 * newlines) so a malformed entry cannot widen trust in unexpected ways.
 */
function normalizeExtraStandardDir(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\r") || trimmed.includes("\n")) {
    return null;
  }
  if (process.platform === "win32") {
    return normalizeWindowsInstallRoot(trimmed);
  }
  const normalized = path.posix.normalize(trimmed);
  if (!path.posix.isAbsolute(normalized) || normalized === "/") {
    return null;
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Directories an operator explicitly added via `OPENCLAW_SYSTEM_BIN_DIRS`
 * (delimiter-separated, `;` on Windows and `:` elsewhere). Appended after the
 * built-in dirs so OS-managed binaries always take priority.
 */
function getExtraStandardDirs(): readonly string[] {
  const raw = process.env[SYSTEM_BIN_DIRS_ENV];
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const normalized = normalizeExtraStandardDir(entry);
    if (!normalized) {
      continue;
    }
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dirs.push(normalized);
  }
  return dirs;
}

function buildBaseTrustedDirs(trust: SystemBinTrust): readonly string[] {
  return process.platform === "win32" ? buildWindowsTrustedDirs() : buildUnixTrustedDirs(trust);
}

let trustedDirsStrict: readonly string[] | null = null;
let trustedDirsStandard: readonly string[] | null = null;

function getTrustedDirs(trust: SystemBinTrust): readonly string[] {
  if (trust === "standard") {
    trustedDirsStandard ??= [...buildBaseTrustedDirs("standard"), ...getExtraStandardDirs()];
    return trustedDirsStandard;
  }
  trustedDirsStrict ??= buildBaseTrustedDirs("strict");
  return trustedDirsStrict;
}

/**
 * Resolve a binary name to an absolute path by searching only trusted system
 * directories. Returns `null` when the binary is not found. Results are cached
 * for the lifetime of the process.
 *
 * This MUST be used instead of bare binary names in `execFile`/`spawn` calls
 * for internal infrastructure binaries (ffmpeg, ffprobe, openssl, etc.) to
 * prevent PATH-hijack attacks via user-writable directories.
 */
export function resolveSystemBin(
  name: string,
  opts?: { trust?: SystemBinTrust; extraDirs?: readonly string[] },
): string | null {
  const trust = opts?.trust ?? "strict";
  const hasExtra = (opts?.extraDirs?.length ?? 0) > 0;
  const cache = trust === "standard" ? resolvedCacheStandard : resolvedCacheStrict;

  if (!hasExtra) {
    const cached = cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
  }

  const dirs = [...getTrustedDirs(trust), ...(opts?.extraDirs ?? [])];
  const isWin = process.platform === "win32";
  const hasExt = isWin && path.win32.extname(name).length > 0;

  for (const dir of dirs) {
    if (isWin && !hasExt) {
      for (const ext of WIN_PATHEXT) {
        const candidate = path.win32.join(dir, name + ext);
        if (isExecutableFn(candidate)) {
          if (!hasExtra) {
            cache.set(name, candidate);
          }
          return candidate;
        }
      }
    } else {
      const candidate = path.join(dir, name);
      if (isExecutableFn(candidate)) {
        if (!hasExtra) {
          cache.set(name, candidate);
        }
        return candidate;
      }
    }
  }

  return null;
}

/** Visible for tests: the computed trusted directories. */
export function _getTrustedDirs(trust: SystemBinTrust = "strict"): readonly string[] {
  return getTrustedDirs(trust);
}

/** Reset cache and optionally override the executable-check function (for tests). */
export function _resetResolveSystemBin(overrideIsExecutable?: (p: string) => boolean): void {
  resolvedCacheStrict.clear();
  resolvedCacheStandard.clear();
  trustedDirsStrict = null;
  trustedDirsStandard = null;
  isExecutableFn = overrideIsExecutable ?? defaultIsExecutable;
}
