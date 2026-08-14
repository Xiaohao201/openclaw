import { normalizeStringEntries } from "../../shared/string-normalization.js";

export function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

export function mergeSkillFilters(
  requestedFilter?: ReadonlyArray<unknown>,
  configuredFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  const requested = normalizeSkillFilter(requestedFilter);
  const configured = normalizeSkillFilter(configuredFilter);
  if (!requested && !configured) {
    return undefined;
  }
  if (!requested) {
    return configured;
  }
  if (!configured) {
    return requested;
  }
  if (requested.length === 0 || configured.length === 0) {
    return [];
  }
  const configuredSet = new Set(configured);
  return requested.filter((name) => configuredSet.has(name));
}

export function normalizeSkillFilterForComparison(
  skillFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return Array.from(new Set(normalized)).toSorted();
}

export function matchesSkillFilter(
  cached?: ReadonlyArray<unknown>,
  next?: ReadonlyArray<unknown>,
): boolean {
  const cachedNormalized = normalizeSkillFilterForComparison(cached);
  const nextNormalized = normalizeSkillFilterForComparison(next);
  if (cachedNormalized === undefined || nextNormalized === undefined) {
    return cachedNormalized === nextNormalized;
  }
  if (cachedNormalized.length !== nextNormalized.length) {
    return false;
  }
  return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
