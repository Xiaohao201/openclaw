// Consume whole URLs so embedded URLs in query strings are never rewritten.
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`[\]()，。；！？]+/gi;
const DOWNLOAD_DATE_PATTERN =
  /^(https?:\/\/oss\.ibtai\.com)(\/ibtai\/assistant-agent\/outputs\/)(\d{4})-(\d{2})-(\d{2})\//;

/** Correct only the known OSS date-directory format; this does not verify file existence. */
export function normalizeEmailDownloadLinks(content: string): string {
  return content.replace(URL_PATTERN, (url) => {
    const match = DOWNLOAD_DATE_PATTERN.exec(url);
    if (!match) {
      return url;
    }
    const [, origin, prefix, year, month, day] = match;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) {
      return url;
    }
    // Splice only the directory prefix: URL serialization could alter signed query bytes.
    return `${origin}${prefix}${year}/${month}/${day}/${url.slice(match[0].length)}`;
  });
}
