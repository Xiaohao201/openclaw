import { EventEmitter } from "node:events";
import mysql from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireMysqlPool, resolveMysqlPoolSettings } from "./mysql-pool.js";

vi.mock("mysql2/promise", () => ({ default: { createPool: vi.fn() } }));
const config = {
  host: "db.example",
  port: 3306,
  user: "test",
  password: "example-only",
  database: "test",
};
const leases: mysql.Pool[] = [];
let sockets: FakeConnection[];
let idle: FakeConnection[];
let waiting: Array<(connection: FakeConnection) => void>;
let emitter: EventEmitter;
let settings: mysql.PoolOptions;
class FakeConnection extends EventEmitter {
  destroyed = false;
  release() {
    const next = waiting.shift();
    if (next) {
      next(this);
      return;
    }
    idle.push(this);
    emitter.emit("release", this);
  }
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    sockets = sockets.filter((socket) => socket !== this);
    idle = idle.filter((socket) => socket !== this);
    this.emit("end");
  }
}
function borrow(): Promise<FakeConnection> {
  const available = idle.pop();
  if (available) {
    emitter.emit("acquire", available);
    return Promise.resolve(available);
  }
  if (sockets.length < settings.connectionLimit!) {
    const socket = new FakeConnection();
    sockets.push(socket);
    emitter.emit("connection", socket);
    emitter.emit("acquire", socket);
    return Promise.resolve(socket);
  }
  if (waiting.length >= settings.queueLimit!) {
    return Promise.reject(new Error("Queue limit reached."));
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function acquire() {
  const lease = acquireMysqlPool(config);
  leases.push(lease);
  return lease;
}
beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  idle = [];
  waiting = [];
  emitter = new EventEmitter();
  vi.stubEnv("MYSQL_CONNECTION_LIMIT", "3");
  vi.stubEnv("MYSQL_MIN_IDLE_CONNECTIONS", "2");
  vi.stubEnv("MYSQL_IDLE_TIMEOUT_MS", "2000");
  vi.stubEnv("MYSQL_QUEUE_LIMIT", "1");
  vi.mocked(mysql.createPool).mockImplementation((options) => {
    settings = options;
    return Object.assign(emitter, {
      getConnection: vi.fn(borrow),
      execute: vi.fn(async () => {
        const socket = await borrow();
        try {
          return [[], []];
        } finally {
          socket.release();
        }
      }),
      query: vi.fn(async () => {
        const socket = await borrow();
        try {
          throw new Error("query failed");
        } finally {
          socket.release();
        }
      }),
      end: vi.fn(async () => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }),
    }) as unknown as mysql.Pool;
  });
});
afterEach(async () => {
  for (const lease of leases.splice(0)) {
    await lease.end();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("shared MySQL pool", () => {
  it("shares the physical pool and closes only after its last owner", async () => {
    const first = acquire();
    const second = acquire();
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
    await first.end();
    await first.end();
    await second.execute("SELECT 1");
    expect((emitter as unknown as mysql.Pool).end).not.toHaveBeenCalled();
    await expect(first.execute("SELECT 1")).rejects.toThrow("closed");
    await second.end();
    expect((emitter as unknown as mysql.Pool).end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("drains pending queries before the last owner closes and rejects overlapping replacement", async () => {
    const pool = acquire();
    const native = vi.mocked(mysql.createPool).mock.results[0].value as mysql.Pool;
    let complete!: () => void;
    const pending = new Promise<[mysql.RowDataPacket[], mysql.FieldPacket[]]>((resolve) => {
      complete = () => resolve([[], []]);
    });
    vi.mocked(native.execute).mockReturnValueOnce(pending);
    const query = pool.execute("SELECT 1");
    const closing = pool.end();
    expect(native.end).not.toHaveBeenCalled();
    expect(() => acquire()).toThrow("closing");
    complete();
    await query;
    await closing;
    expect(native.end).toHaveBeenCalledTimes(1);
    acquire();
    expect(mysql.createPool).toHaveBeenCalledTimes(2);
  });
  it("backs off failed prewarming without an unhandled rejection", async () => {
    acquire();
    const native = vi.mocked(mysql.createPool).mock.results[0].value as mysql.Pool;
    vi.mocked(native.getConnection).mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(native.getConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(native.getConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(idle).toHaveLength(2);
  });
  it("never evicts a borrowed connection, even with a zero idle minimum", async () => {
    vi.stubEnv("MYSQL_MIN_IDLE_CONNECTIONS", "0");
    const pool = acquire();
    const held = await pool.getConnection();
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(1);
    held.release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sockets).toHaveLength(0);
  });
  it("rejects live settings changes instead of creating a second pool", () => {
    acquire();
    vi.stubEnv("MYSQL_CONNECTION_LIMIT", "20");
    expect(() => acquire()).toThrow("restart");
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
  });
  it("keeps different credentials in separate pools", () => {
    acquire();
    leases.push(acquireMysqlPool({ ...config, password: "different" }));
    expect(mysql.createPool).toHaveBeenCalledTimes(2);
  });
  it("prewarms minimum idle connections and trims only excess idle connections", async () => {
    const pool = acquire();
    await vi.advanceTimersByTimeAsync(1000);
    expect(idle).toHaveLength(2);
    const held = await Promise.all([
      pool.getConnection(),
      pool.getConnection(),
      pool.getConnection(),
    ]);
    for (const connection of held) {
      connection.release();
    }
    expect(idle).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(idle).toHaveLength(2);
    expect(sockets).toHaveLength(2);
  });
  it("queues requests at capacity, enforces queue limit, and hands back released connections", async () => {
    const pool = acquire();
    const held = await Promise.all([
      pool.getConnection(),
      pool.getConnection(),
      pool.getConnection(),
    ]);
    const otherModule = acquire();
    const next = otherModule.getConnection();
    await expect(otherModule.getConnection()).rejects.toThrow("Queue limit");
    expect(sockets).toHaveLength(3);
    held[0].release();
    const transferred = await next;
    expect(transferred).toBe(held[0]);
    transferred.release();
    held[1].release();
    held[2].release();
  });
  it("returns connections after successful and failed queries", async () => {
    const pool = acquire();
    await pool.execute("SELECT 1");
    await expect(pool.query("broken SQL")).rejects.toThrow("query failed");
    expect(idle).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });
  it("replenishes a disconnected idle connection", async () => {
    acquire();
    await vi.advanceTimersByTimeAsync(1000);
    idle[0].destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(idle).toHaveLength(2);
  });
});
describe("MySQL pool settings", () => {
  it("provides bounded defaults", () => {
    expect(resolveMysqlPoolSettings({})).toEqual({
      maxConnections: 10,
      minIdle: 2,
      idleTimeoutMs: 60000,
      queueLimit: 100,
    });
  });
  it.each(["0", "-1", "bad", "1.5"])("rejects invalid maximum %s", (value) => {
    expect(() => resolveMysqlPoolSettings({ MYSQL_CONNECTION_LIMIT: value })).toThrow(
      "MYSQL_CONNECTION_LIMIT",
    );
  });
  it("accepts zero minimum but rejects a minimum above maximum", () => {
    expect(resolveMysqlPoolSettings({ MYSQL_MIN_IDLE_CONNECTIONS: "0" }).minIdle).toBe(0);
    expect(() =>
      resolveMysqlPoolSettings({ MYSQL_CONNECTION_LIMIT: "1", MYSQL_MIN_IDLE_CONNECTIONS: "2" }),
    ).toThrow("MYSQL_MIN_IDLE_CONNECTIONS");
  });
});
