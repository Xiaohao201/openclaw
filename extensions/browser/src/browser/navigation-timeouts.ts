export const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;

// Allow navigation to finish and return its result before the transport times out.
export const BROWSER_NAVIGATION_REQUEST_TIMEOUT_MS = DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS + 10_000;
