import { z } from "zod";

const token = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const errorFields = z.object({
  name: token.optional(),
  code: token.optional(),
  errno: z.number().int().optional(),
  sqlState: z
    .string()
    .regex(/^[A-Z0-9]{5}$/)
    .optional(),
});

/** Never copy exception messages, SQL, URLs or process output into gateway logs. */
export function safeErrorFields(error: unknown) {
  const parsed = errorFields.safeParse(error);
  if (!parsed.success) {
    return {};
  }
  const { name, ...fields } = parsed.data;
  return { ...(name ? { errorType: name } : {}), ...fields };
}

const diagnostic = z.object({ stage: token, errorType: token.optional() });
export function createExecutorDiagnosticStream(emit: (event: z.infer<typeof diagnostic>) => void) {
  let pending = "";
  let dropping = false;
  let count = 0;
  return (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) {
        pending += part;
        if (pending.length > 4096) {
          pending = "";
          dropping = true;
        }
      }
      if (!part.endsWith("\n")) {
        continue;
      }
      if (!dropping && count < 100 && pending.startsWith("OPENCLAW_DIAGNOSTIC ")) {
        try {
          const parsed = diagnostic.safeParse(JSON.parse(pending.slice(20)));
          if (parsed.success) {
            count++;
            emit(parsed.data);
          }
        } catch {
          // Unstructured stderr is deliberately discarded.
        }
      }
      pending = "";
      dropping = false;
    }
  };
}
