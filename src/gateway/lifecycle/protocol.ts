import { z } from "zod";

export const LifecycleCommandSchema = z
  .object({
    protocol: z.literal("openclaw-lifecycle-v1"),
    id: z.string().min(1).max(100),
    action: z.enum(["activate", "quiesce", "resume", "deactivate", "status"]),
    timeoutMs: z.number().int().min(1).max(3_600_000),
  })
  .strict();

export type LifecycleCommand = z.infer<typeof LifecycleCommandSchema>;

export const LifecycleResponseSchema = z
  .object({
    protocol: z.literal("openclaw-lifecycle-v1"),
    id: z.string(),
    ok: z.boolean(),
    state: z.enum(["prepared", "active", "pausing", "quiesced", "failed"]),
    error: z.string().optional(),
  })
  .strict();

export type LifecycleResponse = z.infer<typeof LifecycleResponseSchema>;
