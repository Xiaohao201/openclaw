import { describe, expect, it } from "vitest";
import { createKeyedSerialQueue } from "./keyed-serial-queue.js";

/** A manually-resolvable task that records when it starts. */
function makeGate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createKeyedSerialQueue", () => {
  it("runs same-key tasks strictly in enqueue order", async () => {
    const enqueue = createKeyedSerialQueue();
    const gate1 = makeGate();
    const started: string[] = [];

    const p1 = enqueue("u1", () => {
      started.push("task1");
      return gate1.promise;
    });
    const p2 = enqueue("u1", async () => {
      started.push("task2");
    });

    await tick();
    // task2 must not start while task1 is still pending.
    expect(started).toEqual(["task1"]);

    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(started).toEqual(["task1", "task2"]);
  });

  it("runs different-key tasks concurrently", async () => {
    const enqueue = createKeyedSerialQueue();
    const gate1 = makeGate();
    const started: string[] = [];

    const p1 = enqueue("u1", () => {
      started.push("u1-task");
      return gate1.promise;
    });
    const p2 = enqueue("u2", async () => {
      started.push("u2-task");
    });

    await tick();
    // u2 starts (and can even finish) while u1 is still pending.
    expect(started).toEqual(["u1-task", "u2-task"]);
    await p2;

    gate1.resolve();
    await p1;
  });

  it("propagates a rejection to its caller without breaking the chain", async () => {
    const enqueue = createKeyedSerialQueue();
    const started: string[] = [];

    const p1 = enqueue("u1", async () => {
      started.push("task1");
      throw new Error("boom");
    });
    const p2 = enqueue("u1", async () => {
      started.push("task2");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    // The follow-up task still runs and resolves normally.
    await expect(p2).resolves.toBe("ok");
    expect(started).toEqual(["task1", "task2"]);
  });

  it("returns each task's own result", async () => {
    const enqueue = createKeyedSerialQueue();
    const p1 = enqueue("u1", async () => 1);
    const p2 = enqueue("u1", async () => "two");
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe("two");
  });

  it("preserves order across many interleaved enqueues per key", async () => {
    const enqueue = createKeyedSerialQueue();
    const ran: string[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(
        enqueue("a", async () => {
          await tick();
          ran.push(`a${i}`);
        }),
      );
      tasks.push(
        enqueue("b", async () => {
          await tick();
          ran.push(`b${i}`);
        }),
      );
    }
    await Promise.all(tasks);
    expect(ran.filter((x) => x.startsWith("a"))).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(ran.filter((x) => x.startsWith("b"))).toEqual(["b0", "b1", "b2", "b3", "b4"]);
  });
});
