import type mysql from "mysql2/promise";

/** Read-only preparation work gets a dedicated connection that Stop can destroy.
 * Never use this for writes: an interrupted write has an ambiguous commit outcome.
 */
export async function cancellableRead(
  pool: mysql.Pool,
  sql: string,
  values: Array<string | number | boolean | null> = [],
  signal?: AbortSignal,
): Promise<[mysql.RowDataPacket[], mysql.FieldPacket[]]> {
  if (!signal) {
    return values.length
      ? pool.execute<mysql.RowDataPacket[]>(sql, values)
      : pool.execute<mysql.RowDataPacket[]>(sql);
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let conn: mysql.PoolConnection | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: [mysql.RowDataPacket[], mysql.FieldPacket[]]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (result) {
        conn?.release();
        resolve(result);
      } else {
        conn?.destroy();
        reject(error);
      }
    };
    const abort = () => finish(signal.reason ?? new Error("Read cancelled"));
    const timer = setTimeout(() => finish(new Error("Preparation read timed out")), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void pool.getConnection().then(
      (acquired) => {
        if (settled) {
          acquired.release();
          return;
        }
        conn = acquired;
        void acquired.execute<mysql.RowDataPacket[]>(sql, values).then(
          (result) => finish(undefined, result),
          (error) => finish(error),
        );
      },
      (error) => finish(error),
    );
  });
}
