import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./parse-finite-number.js";

export type MysqlConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};
export type MysqlPoolSettings = {
  maxConnections: number;
  minIdle: number;
  idleTimeoutMs: number;
  queueLimit: number;
};

export function resolveMysqlPoolSettings(
  env: Record<string, string | undefined> = process.env,
): MysqlPoolSettings {
  const read = (name: string, fallback: number, allowZero = false) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") {
      return fallback;
    }
    const parsed = allowZero ? parseStrictNonNegativeInteger(raw) : parseStrictPositiveInteger(raw);
    if (parsed === undefined) {
      throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
    }
    return parsed;
  };
  const maxConnections = read("MYSQL_CONNECTION_LIMIT", 10);
  const minIdle = read("MYSQL_MIN_IDLE_CONNECTIONS", Math.min(2, maxConnections), true);
  if (minIdle > maxConnections) {
    throw new Error("MYSQL_MIN_IDLE_CONNECTIONS must not exceed MYSQL_CONNECTION_LIMIT");
  }
  return {
    maxConnections,
    minIdle,
    idleTimeoutMs: read("MYSQL_IDLE_TIMEOUT_MS", 60_000),
    queueLimit: read("MYSQL_QUEUE_LIMIT", 100),
  };
}

// mysql2 forwards raw connection events through the promise pool. Only use
// the lifecycle methods shared by both driver and promise connection types.
type ObservedConnection = {
  once(event: "end" | "error", listener: () => void): unknown;
  destroy(): void;
};

type Entry = {
  pool: mysql.Pool;
  settings: MysqlPoolSettings;
  owners: number;
  pendingOperations: number;
  closing: boolean;
  drainers: Array<() => void>;
  stop: () => void;
};
// Plugin bundles may contain separate copies of this module. The versioned
// process-global registry keeps the physical connection limit shared across them.
const registryKey = Symbol.for("openclaw.mysql-pool.v1");
function registry(): Map<string, Entry> {
  const globalRecord = globalThis as typeof globalThis & { [registryKey]?: Map<string, Entry> };
  return (globalRecord[registryKey] ??= new Map<string, Entry>());
}

function createEntry(config: MysqlConnectionConfig, settings: MysqlPoolSettings): Entry {
  const pool = mysql.createPool({
    ...config,
    connectionLimit: settings.maxConnections,
    waitForConnections: true,
    queueLimit: settings.queueLimit,
    // Disable mysql2's eviction: it has no minimum-idle floor. Our maintenance
    // uses public connection events and never evicts an acquired connection.
    maxIdle: settings.maxConnections,
    idleTimeout: settings.idleTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    charset: "utf8mb4",
    timezone: "+08:00",
  });
  const connections = new Map<ObservedConnection, number | null>();
  let stopped = false;
  let warming = false;
  let retryWarmupAfter = 0;
  const entry: Entry = {
    pool,
    settings,
    owners: 0,
    pendingOperations: 0,
    closing: false,
    drainers: [],
    stop: () => {},
  };
  pool.on("connection", (connection: ObservedConnection) => {
    connections.set(connection, null);
    const remove = () => connections.delete(connection);
    connection.once("end", remove);
    connection.once("error", remove);
  });
  pool.on("acquire", (connection: ObservedConnection) => connections.set(connection, null));
  pool.on("release", (connection: ObservedConnection) => connections.set(connection, Date.now()));

  const maintain = async () => {
    if (stopped || warming) {
      return;
    }
    const now = Date.now();
    const idle = [...connections]
      .flatMap(([connection, since]) => (since === null ? [] : [{ connection, since }]))
      .toSorted((left, right) => left.since - right.since);
    let idleCount = idle.length;
    // Oldest idle connections go first; retain the requested floor.
    for (const { connection, since } of idle) {
      if (idleCount <= settings.minIdle) {
        break;
      }
      if (now - since < settings.idleTimeoutMs) {
        continue;
      }
      connections.delete(connection);
      connection.destroy();
      idleCount--;
    }
    // User work takes priority over prewarming. mysql2 still owns all borrowing
    // and FIFO handoff, including races with new queries during maintenance.
    if (idleCount >= settings.minIdle || entry.pendingOperations > 0 || now < retryWarmupAfter) {
      return;
    }
    const available = idleCount + settings.maxConnections - connections.size;
    const reserve = Math.min(settings.minIdle, available);
    if (reserve <= idleCount) {
      return;
    }
    warming = true;
    const held: mysql.PoolConnection[] = [];
    try {
      // Hold existing idle connections until enough additional ones are created;
      // releasing each immediately would repeatedly borrow the same connection.
      for (let index = 0; index < reserve; index++) {
        if (stopped || entry.pendingOperations > 0) {
          break;
        }
        held.push(await pool.getConnection());
      }
    } catch {
      // Database outages surface through actual queries; avoid a retry storm
      // caused solely by maintaining the idle floor.
      retryWarmupAfter = Date.now() + 10_000;
    } finally {
      for (const connection of held) {
        connection.release();
      }
      warming = false;
    }
  };
  const timer = setInterval(
    () => {
      void maintain();
    },
    Math.min(1000, settings.idleTimeoutMs),
  );
  timer.unref();
  entry.stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return entry;
}

/**
 * Acquire a reference-counted handle to a process-local shared mysql2 pool.
 * Call end() once when the owning component stops. Query/execute automatically
 * borrow and return connections; explicit getConnection callers must release().
 */
export function acquireMysqlPool(config: MysqlConnectionConfig): mysql.Pool {
  const settings = resolveMysqlPoolSettings();
  // Fixed field order makes equal credentials share a pool even when callers
  // construct their config objects in a different property order. Never log keys.
  const key = createHash("sha256")
    .update(
      JSON.stringify([config.host, config.port, config.user, config.password, config.database]),
    )
    .digest("hex");
  const entries = registry();
  let entry = entries.get(key);
  if (entry?.closing) {
    throw new Error("MySQL shared pool is closing; retry after shutdown completes");
  }
  if (entry && JSON.stringify(entry.settings) !== JSON.stringify(settings)) {
    throw new Error(
      "MySQL pool settings changed while the shared pool is active; restart the service",
    );
  }
  if (!entry) {
    entry = createEntry(config, settings);
    entries.set(key, entry);
  }
  const shared = entry;
  shared.owners++;
  let released = false;
  let closing: Promise<void> | undefined;
  return new Proxy(shared.pool, {
    get(target, property) {
      if (property === "end") {
        return () => {
          if (closing) {
            return closing;
          }
          released = true;
          shared.owners--;
          if (shared.owners === 0) {
            shared.stop();
            shared.closing = true;
            closing = (async () => {
              if (shared.pendingOperations > 0) {
                await new Promise<void>((resolve) => shared.drainers.push(resolve));
              }
              await shared.pool.end();
            })().finally(() => {
              entries.delete(key);
            });
          } else {
            closing = Promise.resolve();
          }
          return closing;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "query" || property === "execute" || property === "getConnection") {
        return (...args: unknown[]) => {
          if (released) {
            return Promise.reject(new Error("MySQL pool handle is closed"));
          }
          shared.pendingOperations++;
          const finish = () => {
            shared.pendingOperations--;
            if (shared.pendingOperations === 0) {
              for (const resolve of shared.drainers.splice(0)) {
                resolve();
              }
            }
          };
          try {
            return Promise.resolve(Reflect.apply(value, target, args)).finally(finish);
          } catch (error) {
            finish();
            return Promise.reject(error);
          }
        };
      }
      return value.bind(target);
    },
  });
}
