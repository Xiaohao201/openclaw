import { expect, it, vi } from "vitest";
import {
  linkRunAbortResources,
  registerRunAbortResource,
  waitForRunAbortResources,
} from "./run-abort-resources.js";

it("waits for owned background exits without waiting for another run", async () => {
  const parent = new AbortController();
  const tool = new AbortController();
  const other = new AbortController();
  linkRunAbortResources(tool.signal, parent.signal);
  let exit!: () => void;
  registerRunAbortResource(
    tool.signal,
    new Promise<void>((resolve) => {
      exit = resolve;
    }),
  );
  registerRunAbortResource(other.signal, new Promise(() => {}));
  let settled = false;
  const wait = waitForRunAbortResources(parent.signal).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  exit();
  await wait;
  expect(settled).toBe(true);
});

it("terminates owned jobs even after their tool signal already aborted", async () => {
  const parent = new AbortController();
  const tool = new AbortController();
  linkRunAbortResources(tool.signal, parent.signal);
  let exit!: () => void;
  const completed = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const cancel = vi.fn(() => exit());
  registerRunAbortResource(tool.signal, completed, cancel);
  tool.abort();
  parent.abort("user_abort");
  await waitForRunAbortResources(parent.signal);
  expect(cancel).toHaveBeenCalledTimes(1);
});
