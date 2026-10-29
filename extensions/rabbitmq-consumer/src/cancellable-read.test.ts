import type mysql from "mysql2/promise";
import { expect, it, vi } from "vitest";
import { cancellableRead } from "./cancellable-read.js";

it("releases successful reads and removes their cancellation listener", async () => {
  const result = [[{ value: 1 }], []];
  const conn = { execute: vi.fn(async () => result), destroy: vi.fn(), release: vi.fn() };
  const pool = { getConnection: async () => conn } as unknown as mysql.Pool;
  const controller = new AbortController();
  expect(await cancellableRead(pool, "SELECT 1", [], controller.signal)).toBe(result);
  controller.abort();
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(conn.destroy).not.toHaveBeenCalled();
});

it("bounds a stuck read and destroys its dedicated connection", async () => {
  vi.useFakeTimers();
  try {
    const conn = {
      execute: vi.fn(() => new Promise(() => {})),
      destroy: vi.fn(),
      release: vi.fn(),
    };
    const pool = { getConnection: async () => conn } as unknown as mysql.Pool;
    const pending = cancellableRead(pool, "SELECT 1", [], new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("Preparation read timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("destroys only the checked-out connection on cancellation", async () => {
  const execute = vi.fn(() => new Promise(() => {}));
  const conn = { execute, destroy: vi.fn(), release: vi.fn() };
  const pool = { getConnection: async () => conn } as unknown as mysql.Pool;
  const controller = new AbortController();
  const pending = cancellableRead(pool, "SELECT 1", [], controller.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(execute).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(conn.destroy).toHaveBeenCalledTimes(1);
  expect(conn.release).not.toHaveBeenCalled();
});

it("releases a connection arriving after cancellation without executing SQL", async () => {
  const conn = { execute: vi.fn(), release: vi.fn() };
  let acquire!: (value: unknown) => void;
  const pool = {
    getConnection: () =>
      new Promise((resolve) => {
        acquire = resolve;
      }),
  } as unknown as mysql.Pool;
  const controller = new AbortController();
  const pending = cancellableRead(pool, "SELECT 1", [], controller.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  controller.abort();
  await rejected;
  acquire(conn);
  await vi.waitFor(() => expect(conn.release).toHaveBeenCalledTimes(1));
  expect(conn.execute).not.toHaveBeenCalled();
});
