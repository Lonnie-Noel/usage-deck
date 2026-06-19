export type PeriodMode = "12hrs" | "day" | "week" | "month" | "custom";
export type BudgetWeekWindow = "calendar-week" | "assigned-week";
export type BudgetMonthWindow = "calendar-month" | "billing-cycle";

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

export function getAssignedWeekRange(resetDay: number, resetTime: string, reference = new Date()): DateRange {
  const resetWeekday = normalizeWeekday(resetDay);
  const [hour, minute] = parseTime(resetTime);
  const current = new Date(reference);
  const reset = new Date(current);
  reset.setHours(hour, minute, 0, 0);
  reset.setDate(reset.getDate() + resetWeekday - reset.getDay());

  if (current < reset) {
    reset.setDate(reset.getDate() - 7);
  }

  const end = new Date(reset);
  end.setDate(reset.getDate() + 6);
  return { start: toDateKey(reset), end: toDateKey(end) };
}

export function getMonthRange(reference = new Date()): DateRange {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
  return { start: toDateKey(start), end: toDateKey(end) };
}

export function getBillingCycleRange(startDay: number, reference = new Date()): DateRange {
  const day = normalizeMonthDay(startDay);
  const current = startOfDay(reference);
  let start = cycleDate(current.getFullYear(), current.getMonth(), day);
  if (current < start) {
    start = cycleDate(current.getFullYear(), current.getMonth() - 1, day);
  }
  const next = cycleDate(start.getFullYear(), start.getMonth() + 1, day);
  const end = addDays(next, -1);
  return { start: toDateKey(start), end: toDateKey(end) };
}

export function getBudgetWeekRange(window: BudgetWeekWindow, resetDay: number, resetTime: string, reference = new Date()): DateRange {
  if (window === "assigned-week") {
    return getAssignedWeekRange(resetDay, resetTime, reference);
  }
  return getWeekRange(reference);
}

export function getBudgetMonthRange(window: BudgetMonthWindow, billingCycleDay: number, reference = new Date()): DateRange {
  if (window === "billing-cycle") {
    return getBillingCycleRange(billingCycleDay, reference);
  }
  return getMonthRange(reference);
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

function cycleDate(year: number, month: number, requestedDay: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(normalizeMonthDay(requestedDay), lastDay));
}

function normalizeWeekday(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

function normalizeMonthDay(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 31 ? value : 1;
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return [0, 0];
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return [clampTime(hour, 0, 23), clampTime(minute, 0, 59)];
}

function clampTime(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
