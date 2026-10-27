/** Deployment policy, inherited by subprocesses; never configurable through agent config writes. */
export function isExternallyManagedGateway(): boolean {
  return process.env.OPENCLAW_EXTERNAL_LIFECYCLE === "1";
}

export function assertExternalLifecycleAllowed(operation: string): void {
  if (isExternallyManagedGateway()) {
    throw new Error(
      `Cannot ${operation} from a managed gateway. Only the external service manager may change its lifecycle.`,
    );
  }
}
