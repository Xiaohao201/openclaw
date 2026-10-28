import { setTimeout as delay } from "node:timers/promises";

/** Keep execution backends usable until accepted ingress and nested work settle. */
export async function drainManagedGateway(params: {
  timeoutMs: number;
  pauseIngress: (timeoutMs: number) => Promise<void>;
  isIdle: () => boolean;
  closeAdmission: () => void;
  pauseExecution: (timeoutMs: number) => Promise<void>;
}): Promise<void> {
  const deadline = performance.now() + params.timeoutMs;
  const remaining = () => Math.max(1, deadline - performance.now());
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw new Error("Lifecycle deadline exceeded; active work was not aborted");
    }
  };
  await params.pauseIngress(remaining());
  checkDeadline();
  while (!params.isIdle()) {
    checkDeadline();
    await delay(Math.min(100, remaining()));
  }
  params.closeAdmission();
  if (!params.isIdle()) {
    throw new Error("New work arrived while closing admission");
  }
  await params.pauseExecution(remaining());
  checkDeadline();
  if (!params.isIdle()) {
    throw new Error("New work arrived while draining execution services");
  }
}
