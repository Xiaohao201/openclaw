/** Admission state is process-local; the Gateway lock remains the execution fence. */
export class DeploymentAdmission {
  draining = false;
  active = 0;

  accepts(method: string): boolean {
    // Completion/approval traffic must still reach runs that are draining.
    return (
      !this.draining ||
      [
        "chat.history",
        "chat.abort",
        "exec.approval.resolve",
        "plugin.approval.resolve",
        "node.invoke.result",
        "health",
        "status",
      ].includes(method)
    );
  }
}

export async function drainDeployment(params: {
  admission: DeploymentAdmission;
  stopProducers: () => Promise<void>;
  pending: () => number;
  wait?: () => Promise<void>;
}): Promise<void> {
  params.admission.draining = true;
  await params.stopProducers();
  // Do not mark the command queue draining: accepted plugin deliveries can still
  // need to enqueue their next model run while their consumer is stopping.
  while (params.pending() + params.admission.active > 0) {
    await (params.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 100)));
  }
}
