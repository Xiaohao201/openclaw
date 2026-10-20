import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skills-db");
const MATERIALIZE_TIMEOUT_MS = 12_000;
type MaterializeStage = "skills_query" | "scripts_query" | "resources_query" | "write_files";
type MaterializeOutcome = "success" | "timeout" | "error";

export class SkillMaterializeTiming {
  private readonly startedAt = performance.now();
  private active: { stage: MaterializeStage; startedAt: number } | undefined;
  private readonly stagesMs: Partial<Record<MaterializeStage, number>> = {};

  async stage<T>(stage: MaterializeStage, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.active = { stage, startedAt };
    try {
      return await operation();
    } finally {
      this.stagesMs[stage] = Math.round(performance.now() - startedAt);
      this.active = undefined;
    }
  }

  summary(userId: number, outcome: MaterializeOutcome) {
    const now = performance.now();
    return {
      userId,
      outcome,
      elapsedMs: Math.round(now - this.startedAt),
      stagesMs: { ...this.stagesMs },
      ...(this.active
        ? { activeStage: this.active.stage, activeStageMs: Math.round(now - this.active.startedAt) }
        : {}),
    };
  }
}

class MaterializeTimeoutError extends Error {
  constructor() {
    super(`skills materialize timed out after ${MATERIALIZE_TIMEOUT_MS}ms`);
  }
}

/** Bounds waiting, not the underlying work; late completion does not emit a second summary. */
export async function observeSkillMaterialization<T>(
  userId: number,
  operation: (timing: SkillMaterializeTiming) => Promise<T>,
): Promise<T> {
  const timing = new SkillMaterializeTiming();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MaterializeTimeoutError()), MATERIALIZE_TIMEOUT_MS);
    });
    const result = await Promise.race([operation(timing), timeout]);
    log.info("skills materialize timing", timing.summary(userId, "success"));
    return result;
  } catch (error) {
    log.warn(
      "skills materialize timing",
      timing.summary(userId, error instanceof MaterializeTimeoutError ? "timeout" : "error"),
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
