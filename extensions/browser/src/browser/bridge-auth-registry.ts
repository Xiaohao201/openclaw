import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

type BridgeAuth = {
  token?: string;
  password?: string;
};

// In-process registry for loopback-only bridge servers that require auth, but
// are addressed via dynamic ephemeral ports (e.g. sandbox browser bridge).
const bridgeAuthRegistryKey = Symbol.for("openclaw.browser.bridge-auth-registry.v1");

function getAuthByPort(): Map<number, BridgeAuth> {
  // The plugin loader and lazy native-ESM bridge can instantiate this module twice.
  // They must share credentials; deleting a bridge removes them for both loaders.
  const state = globalThis as typeof globalThis & {
    [bridgeAuthRegistryKey]?: Map<number, BridgeAuth>;
  };
  return (state[bridgeAuthRegistryKey] ??= new Map<number, BridgeAuth>());
}

export function setBridgeAuthForPort(port: number, auth: BridgeAuth): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  const token = normalizeOptionalString(auth.token) ?? "";
  const password = normalizeOptionalString(auth.password) ?? "";
  getAuthByPort().set(port, {
    token: token || undefined,
    password: password || undefined,
  });
}

export function getBridgeAuthForPort(port: number): BridgeAuth | undefined {
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return getAuthByPort().get(port);
}

export function deleteBridgeAuthForPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  getAuthByPort().delete(port);
}
