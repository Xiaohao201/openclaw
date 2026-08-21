const EMPTY_RESULTS_GUIDANCE =
  "Brave returned no indexed results for this exact query. This may reflect query specificity or search-index delay. Retry with a shorter entity plus distinctive action/location variants, remove exact-phrase constraints, and search relevant platform or source domains. Do not conclude that a user-reported event did not occur without checking recent, social-platform, and authority-source variants and opening promising pages with web_fetch or the browser.";

export function resolveBraveSearchGuidance(resultCount: number): string | undefined {
  return resultCount === 0 ? EMPTY_RESULTS_GUIDANCE : undefined;
}
