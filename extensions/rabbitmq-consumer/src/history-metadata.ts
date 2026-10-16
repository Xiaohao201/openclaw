/** Treat legacy null, invalid JSON and non-object metadata like the old JS merge did. */
const METADATA_OBJECT_SQL =
  "CASE WHEN JSON_VALID(metadata) THEN " +
  "CASE WHEN JSON_TYPE(metadata) = 'OBJECT' THEN metadata ELSE JSON_OBJECT() END " +
  "ELSE JSON_OBJECT() END";

/** Bind both paths and JSON values; JSON_SET preserves sibling keys and explicit nulls. */
export function createHistoryMetadataPatch(patch: Record<string, unknown>): {
  expression: string;
  values: string[];
} | null {
  const fields = Object.entries(patch).flatMap(([key, value]) => {
    const json = JSON.stringify(value);
    return json === undefined ? [] : [{ path: `$.${JSON.stringify(key)}`, json }];
  });
  if (fields.length === 0) {
    return null;
  }
  // Serialize before queuing/retrying so caller mutations cannot alter an older snapshot.
  return {
    expression: `JSON_SET(${METADATA_OBJECT_SQL}, ${fields.map(() => "?, JSON_EXTRACT(?, '$')").join(", ")})`,
    values: fields.flatMap(({ path, json }) => [path, json]),
  };
}
