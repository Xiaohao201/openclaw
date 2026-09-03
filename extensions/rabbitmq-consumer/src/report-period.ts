export type ReportPeriod = "日报" | "周报" | "月报";

/** Compute the previous completed period in Asia/Shanghai time. */
export function computeDateScope(period: ReportPeriod): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const dayOfWeek = now.getDay();

  switch (period) {
    case "日报": {
      return {
        start: formatDateTime(new Date(year, month, date - 1)),
        end: formatDateTime(new Date(year, month, date)),
      };
    }
    case "周报": {
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      return {
        start: formatDateTime(new Date(year, month, date - daysFromMonday - 7)),
        end: formatDateTime(new Date(year, month, date - daysFromMonday)),
      };
    }
    case "月报": {
      const lastMonth = month === 0 ? 11 : month - 1;
      const lastMonthYear = month === 0 ? year - 1 : year;
      return {
        start: formatDateTime(new Date(lastMonthYear, lastMonth, 1)),
        end: formatDateTime(new Date(year, month, 1)),
      };
    }
    default: {
      throw new Error(`Unknown report period: ${String(period)}`);
    }
  }
}

function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
