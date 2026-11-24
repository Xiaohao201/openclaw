export type BrowserAssistanceReason = "challenge" | "login" | "manual";
export type BrowserAssistanceNotice = {
  version: 1;
  requestId: string;
  status: "waiting" | "verifying" | "resumed" | "cancelled" | "expired" | "unavailable";
  reason: BrowserAssistanceReason;
  origin: string;
  expiresAt: number;
};
export type BrowserAssistanceFrame = {
  type: "frame";
  data: string;
  width: number;
  height: number;
  origin: string;
};
export type BrowserAssistanceControl = {
  notice: BrowserAssistanceNotice;
  startFrames: (send: (frame: BrowserAssistanceFrame) => void) => Promise<void>;
  stopFrames: () => Promise<void>;
  input: (value: unknown) => Promise<void>;
  complete: () => Promise<boolean>;
  cancel: () => void;
};
export type BrowserAssistanceSessionOptions = {
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onRequest: (control: BrowserAssistanceControl) => Promise<void>;
  onState: (notice: BrowserAssistanceNotice) => Promise<void>;
};
