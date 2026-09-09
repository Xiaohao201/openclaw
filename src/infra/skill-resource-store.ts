import type mysql from "mysql2/promise";
import { validateSkillResources, type SkillResource } from "./skill-resources.js";

type Executor = Pick<mysql.Pool, "execute">;

/** IDs must come from an owner/visibility-scoped parent query. */
export async function readSkillResources(
  db: Executor,
  skillIds: number[],
): Promise<Map<number, SkillResource[]>> {
  const result = new Map<number, SkillResource[]>();
  if (!skillIds.length) {
    return result;
  }
  let rows: mysql.RowDataPacket[];
  try {
    [rows] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT skill_id, path, media_type, content FROM skill_resources WHERE skill_id IN (${skillIds.map(() => "?").join(",")}) ORDER BY skill_id, path`,
      skillIds,
    );
  } catch (error) {
    // Allows rolling out the reader before the additive database migration.
    if ((error as { code?: string }).code === "ER_NO_SUCH_TABLE") {
      return result;
    }
    throw error;
  }
  for (const row of rows) {
    if (!skillIds.includes(Number(row.skill_id))) {
      continue;
    }
    const group = result.get(Number(row.skill_id)) ?? [];
    group.push({ path: row.path, mediaType: row.media_type, content: row.content });
    result.set(Number(row.skill_id), group);
  }
  for (const [id, resources] of result) {
    result.set(id, validateSkillResources(resources));
  }
  return result;
}

/** Caller holds the parent skill's ownership-checked row lock in this transaction. */
export async function replaceSkillResources(
  db: Executor,
  skillId: number,
  input: unknown,
): Promise<void> {
  const resources = validateSkillResources(input);
  // A formal attachment edit retires its old compatibility copy as well; otherwise
  // deleting it would resurrect stale content when the skill is shared/imported.
  await db.execute(
    "DELETE FROM skill_scripts WHERE skill_id = ? AND script_name IN (SELECT path FROM skill_resources WHERE skill_id = ?)",
    [skillId, skillId],
  );
  await db.execute("DELETE FROM skill_resources WHERE skill_id = ?", [skillId]);
  for (const resource of resources) {
    await db.execute(
      "INSERT INTO skill_resources (skill_id, path, media_type, content) VALUES (?, ?, ?, ?)",
      [skillId, resource.path, resource.mediaType, resource.content],
    );
  }
}

export async function withSkillTransaction<T>(
  pool: mysql.Pool,
  operation: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const value = await operation(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
