export type PeriodMode = "12hrs" | "day" | "week" | "month" | "custom";

export type DateRange = {
  start: string;
  end: string;
  startDateTime?: string;
  endDateTime?: string;
};

export type UsageRangePoint = {
  date: string;
  totalTokens: number;
  costUSD: number;
};

export type UsageSummary = {
  totalTokens: number;
  costUSD: number;
};

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function getDayRange(reference = new Date()): DateRange {
  const dateKey = toDateKey(reference);
  return { start: dateKey, end: dateKey };
}

export function getTwelveHourRange(reference = new Date()): DateRange {
  const start = new Date(reference.getTime() - 12 * 60 * 60 * 1000);
  return {
    start: toDateKey(start),
    end: toDateKey(reference),
    startDateTime: start.toISOString(),
    endDateTime: reference.toISOString()
  };
}

export function getWeekRange(reference = new Date()): DateRange {
  const date = startOfDay(reference);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDays(date, mondayOffset);
  const end = addDays(start, 6);
  return { start: toDateKey(start), end: toDateKey(end) };
}

export function getMonthRange(reference = new Date()): DateRange {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
  return { start: toDateKey(start), end: toDateKey(end) };
}

export function getPresetRange(mode: Exclude<PeriodMode, "custom">, reference = new Date()): DateRange {
  switch (mode) {
    case "12hrs":
      return getTwelveHourRange(reference);
    case "day":
      return getDayRange(reference);
    case "week":
      return getWeekRange(reference);
    case "month":
      return getMonthRange(reference);
  }
}

export function normalizeDateRange(range: DateRange): DateRange {
  if (range.start <= range.end) {
    return range;
  }
  return { start: range.end, end: range.start };
}

export function filterUsageByRange<T extends { date: string }>(rows: T[], range: DateRange): T[] {
  const normalized = normalizeDateRange(range);
  return rows.filter((row) => row.date >= normalized.start && row.date <= normalized.end);
}

export function summarizeUsage(rows: UsageRangePoint[]): UsageSummary {
  return rows.reduce(
    (summary, row) => ({
      totalTokens: summary.totalTokens + row.totalTokens,
      costUSD: summary.costUSD + row.costUSD
    }),
    { totalTokens: 0, costUSD: 0 }
  );
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}
