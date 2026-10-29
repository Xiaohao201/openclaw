// Resources that outlive a tool's foreground result (for example background exec)
// still belong to that run. Keep their exit promises separate from tool results.
type OwnedResource = { completion: Promise<unknown>; cancel?: () => void };
// Exec and the runner may be emitted into separate runtime chunks.
const resourceKey = Symbol.for("openclaw.runAbortResources");
const resourceStore = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<AbortSignal, Set<OwnedResource>> | undefined;
};
const resources = (resourceStore[resourceKey] ??= new WeakMap<AbortSignal, Set<OwnedResource>>());

function bucket(signal: AbortSignal): Set<OwnedResource> {
  let value = resources.get(signal);
  if (!value) {
    value = new Set();
    resources.set(signal, value);
  }
  return value;
}

export function linkRunAbortResources(child: AbortSignal, parent: AbortSignal): void {
  resources.set(child, bucket(parent));
}

export function registerRunAbortResource(
  signal: AbortSignal,
  completion: Promise<unknown>,
  cancel?: () => void,
): void {
  const pending = bucket(signal);
  const resource = { completion, cancel };
  pending.add(resource);
  void completion.then(
    () => pending.delete(resource),
    () => pending.delete(resource),
  );
}

export async function waitForRunAbortResources(signal: AbortSignal): Promise<void> {
  const pending = bucket(signal);
  while (pending.size > 0) {
    const owned = [...pending];
    // The tool signal may already have aborted routinely before user Stop.
    // Ownership, rather than a second signal event, drives forced cleanup.
    for (const resource of owned) {
      resource.cancel?.();
    }
    await Promise.allSettled(owned.map((resource) => resource.completion));
  }
}
