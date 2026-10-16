import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import {
  PROFILE_ATTACH_RETRY_TIMEOUT_MS,
  PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState, mockLaunchedChrome } from "./server-context.test-harness.js";

const lifecycleInfo = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => {
  const logger = {
    info: lifecycleInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();

  const launchOpenClawChrome = vi.mocked(chromeModule.launchOpenClawChrome);
  const stopOpenClawChrome = vi.mocked(chromeModule.stopOpenClawChrome);
  const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
  const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
  isChromeReachable.mockResolvedValue(false);

  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");

  return { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("records overlapping ensures for the same runtime and clears the counter", async () => {
    const { profile, isChromeCdpReady } = setupEnsureBrowserAvailableHarness();
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(true);
    isChromeCdpReady.mockResolvedValue(true);
    await Promise.all([profile.ensureBrowserAvailable(), profile.ensureBrowserAvailable()]);
    await profile.ensureBrowserAvailable();
    const starts = lifecycleInfo.mock.calls
      .map(([message]) => message as string)
      .filter((message) => message.startsWith("ensure-start "))
      .map((message) => JSON.parse(message.slice("ensure-start ".length)));
    expect(starts.map((event) => event.active)).toEqual([1, 2, 1]);
    expect(new Set(starts.map((event) => event.requestId)).size).toBe(3);
  });
  it("waits for CDP readiness after launching to avoid follow-up PortInUseError races (#21149)", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockLaunchedChrome(launchOpenClawChrome, 123);

    const promise = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();

    expect(
      lifecycleInfo.mock.calls.some(
        ([message]) =>
          message.startsWith("launch-request ") && message.includes('"reason":"http_unreachable"'),
      ),
    ).toBe(true);
    expect(
      lifecycleInfo.mock.calls.some(
        ([message]) => message.startsWith("launch-complete ") && message.includes('"pid":123'),
      ),
    ).toBe(true);
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(false);
    mockLaunchedChrome(launchOpenClawChrome, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    await vi.advanceTimersByTimeAsync(8100);
    await rejected;

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
  });

  it("reuses a pre-existing loopback browser after an initial short probe miss", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    state.resolved.ssrfPolicy = {};

    isChromeReachable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:18800",
      PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      undefined,
    );
    expect(isChromeReachable).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:18800",
      PROFILE_ATTACH_RETRY_TIMEOUT_MS,
      undefined,
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("retries remote CDP websocket reachability once before failing", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);

    const state = makeBrowserServerState();
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://browserless:3001",
      color: "#00AA00",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");
    const expectedRemoteHttpTimeoutMs = state.resolved.remoteCdpTimeoutMs;
    const expectedRemoteWsTimeoutMs = state.resolved.remoteCdpHandshakeTimeoutMs;

    isChromeReachable.mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalledTimes(2);
    expect(isChromeCdpReady).toHaveBeenNthCalledWith(
      1,
      "ws://browserless:3001",
      expectedRemoteHttpTimeoutMs,
      expectedRemoteWsTimeoutMs,
      {
        allowPrivateNetwork: true,
      },
    );
    expect(isChromeCdpReady).toHaveBeenNthCalledWith(
      2,
      "ws://browserless:3001",
      expectedRemoteHttpTimeoutMs,
      expectedRemoteWsTimeoutMs,
      {
        allowPrivateNetwork: true,
      },
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("treats attachOnly loopback CDP as local control with remote-class probe timeouts", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome } = setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);

    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("manual-cdp");

    isChromeReachable.mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
    );
    expect(isChromeCdpReady).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });
});
