import type { Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { AssistancePage } from "./page.runtime.js";

const mocks = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock("../browser/pw-session.js", () => ({ getPageForTargetId: mocks.getPage }));

function mockPage(targetId: string) {
  const detach = vi.fn(async () => {});
  const send = vi.fn(async () => ({ targetInfo: { targetId } }));
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
  } as unknown as Page;
  return { page, detach };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("waits for the exact new target when CDP initially exposes only the startup tab", async () => {
  vi.useFakeTimers();
  const startup = mockPage("startup");
  const original = mockPage("original");
  mocks.getPage.mockResolvedValueOnce(startup.page).mockResolvedValue(original.page);
  const connected = AssistancePage.connect("http://127.0.0.1:12345", "original");
  const check = expect(connected).resolves.toMatchObject({ page: original.page });
  await Promise.all([check, vi.advanceTimersByTimeAsync(2_000)]);
  expect(startup.detach).toHaveBeenCalledOnce();
  expect(original.detach).toHaveBeenCalledOnce();
  expect(mocks.getPage).toHaveBeenCalledTimes(2);
});

it("fails within a bounded time without binding a different remaining page", async () => {
  vi.useFakeTimers();
  const other = mockPage("other");
  mocks.getPage.mockResolvedValue(other.page);
  const connected = AssistancePage.connect("http://127.0.0.1:12345", "missing");
  const check = expect(connected).rejects.toThrow("Original browser tab is unavailable");
  await Promise.all([check, vi.advanceTimersByTimeAsync(2_000)]);
  expect(other.detach).toHaveBeenCalledTimes(mocks.getPage.mock.calls.length);
  expect(vi.getTimerCount()).toBe(0);
});
