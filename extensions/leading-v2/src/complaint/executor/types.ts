import type { LocalComplaintItem, LocalConfig, LocalOutcome } from "../complaint-local-contract.js";
import type { BrowserHandoff } from "../complaint-session-handoff.js";

export type RunComplaint = (params: {
  item: LocalComplaintItem;
  sessionDir: string;
  config: LocalConfig;
  signal: AbortSignal;
  progress?: (message: string) => Promise<void>;
  browserHandoff?: BrowserHandoff;
  diagnosticContext?: { batchId: string; taskId?: number | null };
}) => Promise<LocalOutcome>;
