import { z } from "zod";
import { GroupAdminError, mutationSchema, type GroupSnapshot } from "./admin.js";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const resultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      groups: z.record(z.string(), z.string()),
      version: z.string(),
      status: z.enum(["saved", "created_unsaved"]).optional(),
      chatId: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), chatId: z.string().optional() }),
  }),
]);
export const pendingReportSchema = z.object({
  id,
  lease: id,
  result: resultSchema.nullable(),
  chatId: z.string().optional(),
});
export type PendingReport = z.infer<typeof pendingReportSchema>;
type Dependencies = {
  api(action: "claim" | "complete", body: unknown): Promise<unknown>;
  journal: {
    read(): Promise<PendingReport | null>;
    write(value: PendingReport | null): Promise<void>;
  };
  admin: { read(): Promise<GroupSnapshot>; mutate(input: unknown): Promise<unknown> };
};

/** A claimed mutation is executed at most once. Only delivery of its durable result retries. */
export function createBridgeWorker(deps: Dependencies) {
  let busy = false;
  return {
    async tick() {
      if (busy) {
        return;
      }
      busy = true;
      try {
        let pending = await deps.journal.read();
        if (!pending) {
          const response = z
            .object({ job: z.object({ id, lease: id, input: mutationSchema }).nullable() })
            .parse(await deps.api("claim", { snapshot: await deps.admin.read() }));
          if (!response.job) {
            return;
          }
          const { input, ...claim } = response.job;
          pending = {
            ...claim,
            result: null,
            ...(input.action === "create" ? { chatId: input.requestId } : {}),
          };
          // Persist before any remote side effect. A crash here requires human reconciliation.
          await deps.journal.write(pending);
          try {
            pending.result = resultSchema.parse({
              ok: true,
              value: await deps.admin.mutate(input),
            });
          } catch (error) {
            pending.result = {
              ok: false,
              error:
                error instanceof GroupAdminError
                  ? {
                      code: error.code,
                      message: error.message,
                      ...(error.chatId ? { chatId: error.chatId } : {}),
                    }
                  : {
                      code: "EXECUTION_UNKNOWN",
                      message: "执行结果未确认，请刷新本地配置并核实后再操作",
                      ...(pending.chatId ? { chatId: pending.chatId } : {}),
                    },
            };
          }
          await deps.journal.write(pending);
        }
        if (!pending.result) {
          pending.result = {
            ok: false,
            error: {
              code: "EXECUTION_UNKNOWN",
              message: "本地执行曾中断，请核实配置及企微群状态，任务不会自动重做",
              ...(pending.chatId ? { chatId: pending.chatId } : {}),
            },
          };
          await deps.journal.write(pending);
        }
        await deps.api("complete", pending);
        await deps.journal.write(null);
      } finally {
        busy = false;
      }
    },
  };
}
