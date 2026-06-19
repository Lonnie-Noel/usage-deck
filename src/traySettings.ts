import type { DailyPoint, ModelUsage, NormalizedUsage } from "./usageSchema";
import {
  filterUsageByRange,
  getBudgetMonthRange,
  getBudgetWeekRange,
  type BudgetMonthWindow,
  type BudgetWeekWindow
} from "./dateRanges";

export type TrayBudgetPeriod = "week" | "month";
export type TrayBudgetType = "tokens" | "cost";
export type TrayModelTarget = "family:gpt" | "family:claude" | "family:gemini" | "all" | string;

export type TraySlotSetting = {
  id: string;
  enabled: boolean;
  target: TrayModelTarget;
  period: TrayBudgetPeriod;
};

export type TrayModelBudgetSetting = {
  target: TrayModelTarget;
  enabled: boolean;
  weeklyBudget: number;
  monthlyBudget: number;
  weeklyWindow: BudgetWeekWindow;
  monthlyWindow: BudgetMonthWindow;
  weeklyResetDay: number;
  weeklyResetTime: string;
  billingCycleDay: number;
  customColor: string;
};

export type TrayBarSetting = TraySlotSetting;

export type TrayIndicatorSettings = {
  enabled: boolean;
  panelOpacity: number;
  panelPosition?: TrayPanelPosition;
  slots: [TraySlotSetting, TraySlotSetting];
};

export type TrayPanelPosition = {
  x: number;
  y: number;
};

export type TrayIndicatorBar = {
  id: string;
  label: string;
  period: TrayBudgetPeriod;
  color: string;
  usedTokens: number;
  costUSD: number;
  usedValue: number;
  budgetValue: number;
  budgetType: TrayBudgetType;
  ratio: number;
  budgetSource: "configured" | "relative";
  windowLabel: string;
};

export type TrayIndicatorSummary = {
  enabled: boolean;
  bars: TrayIndicatorBar[];
  tooltip: string;
};

const STORAGE_KEY = "usage-deck.tray-indicator.v1";
const DEFAULT_GPT = "#8AB4FF";
const DEFAULT_CLAUDE = "#D98B4E";
const DEFAULT_GEMINI = "#A78BFA";
const WINDOWS_TRAY_TOOLTIP_LIMIT = 63;

const MODEL_COLORS = [
  "#8AB4FF",
  "#D98B4E",
  "#A78BFA",
  "#D66F5D",
  "#B7A36F",
  "#9D8AD8",
  "#70A0AF",
  "#C47E9B"
];

export const defaultTraySettings: TrayIndicatorSettings = {
  enabled: true,
  panelOpacity: 0.8,
  slots: [
    {
      id: "primary",
      enabled: true,
      target: "family:gpt",
      period: "week"
    },
    {
      id: "secondary",
      enabled: true,
      target: "family:claude",
      period: "week"
    }
  ]
};

export function loadTraySettings(): TrayIndicatorSettings {
  if (typeof window === "undefined") {
    return defaultTraySettings;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultTraySettings;
    }
    return normalizeTraySettings(JSON.parse(raw));
  } catch {
    return defaultTraySettings;
  }
}

export function saveTraySettings(settings: TrayIndicatorSettings) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function normalizeTraySettings(input: unknown): TrayIndicatorSettings {
  const record = input && typeof input === "object" ? (input as Partial<TrayIndicatorSettings>) : {};
  const legacyRecord = record as Partial<TrayIndicatorSettings> & { bars?: unknown[] };
  const slots = Array.isArray(record.slots) ? record.slots : Array.isArray(legacyRecord.bars) ? legacyRecord.bars : [];

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaultTraySettings.enabled,
    panelOpacity: normalizePanelOpacity(record.panelOpacity),
    panelPosition: normalizePanelPosition(record.panelPosition),
    slots: [
      normalizeSlot(slots[0], defaultTraySettings.slots[0]),
      normalizeSlot(slots[1], defaultTraySettings.slots[1])
    ]
  };
}

export function buildModelOptions(usage: NormalizedUsage): Array<{ value: TrayModelTarget; label: string }> {
  const seen = new Set<string>();
  const modelOptions = usage.modelUsage
    .filter((model) => model.model !== "unknown")
    .map((model) => ({ value: model.model, label: compactModelName(model.model) }))
    .filter((option) => {
      const key = option.value.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return [
    { value: "family:gpt", label: "GPT / OpenAI family" },
    { value: "family:claude", label: "Claude family" },
    { value: "family:gemini", label: "Gemini family" },
    { value: "all", label: "All models" },
    ...modelOptions
  ];
}

export function buildTrayIndicatorSummary(
  settings: TrayIndicatorSettings,
  usage: NormalizedUsage,
  modelBudgets: Record<string, TrayModelBudgetSetting> = {}
): TrayIndicatorSummary {
  if (!settings.enabled) {
    return {
      enabled: false,
      bars: [],
      tooltip: "Tray indicator disabled."
    };
  }

  const activeSettings = settings.slots.filter((slot) => slot.enabled).slice(0, 2);
  const bars = activeSettings.map((slot, index) => {
    const budget = modelBudgets[slot.target] ?? fallbackModelBudget(slot.target, index);
    const period = resolveSlotPeriod(slot, budget);
    const range = budgetDateRange(budget, period);
    const stats = sumTargetUsage(budgetRowsForPeriod(usage, budget, period, range), slot.target);
    const configuredBudget = period === "week" ? budget.weeklyBudget : budget.monthlyBudget;
    const usedValue = stats.costUSD;
    const budgetValue = configuredBudget > 0 ? configuredBudget : 0;
    const color = isHexColor(budget.customColor) ? budget.customColor : resolveModelColor(slot.target, index);
    const budgetSource: TrayIndicatorBar["budgetSource"] = "configured";

    return {
      id: slot.id,
      label: targetLabel(slot.target),
      period,
      color,
      usedTokens: stats.totalTokens,
      costUSD: stats.costUSD,
      usedValue,
      budgetValue,
      budgetType: "cost" as const,
      ratio: budgetValue > 0 ? clamp(usedValue / budgetValue, 0, 1) : 0,
      budgetSource,
      windowLabel: budgetWindowShortLabel(budget, period, range)
    };
  });

  return {
    enabled: true,
    bars,
    tooltip: buildTooltip(bars)
  };
}

export function resolveModelColor(target: TrayModelTarget, index = 0): string {
  const lower = target.toLowerCase();

  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku")) {
    return DEFAULT_CLAUDE;
  }

  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("codex") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("o4")
  ) {
    return DEFAULT_GPT;
  }

  if (lower.includes("gemini")) {
    return DEFAULT_GEMINI;
  }

  return MODEL_COLORS[Math.abs(hashString(target) + index) % MODEL_COLORS.length];
}

export function compactModelName(model: string): string {
  return model
    .replace("family:", "")
    .replace("gpt", "GPT")
    .replace("claude", "Claude")
    .replace("gemini", "Gemini")
    .replace("all", "All")
    .replace("claude-", "claude ")
    .replace("gpt-", "gpt ")
    .replace("gemini-", "gemini ")
    .replace("-20250929", "")
    .replace("-20250805", "");
}

function normalizeSlot(input: unknown, fallback: TraySlotSetting): TraySlotSetting {
  const record = input && typeof input === "object" ? (input as Partial<TraySlotSetting>) : {};
  const target = typeof record.target === "string" ? record.target : fallback.target;
  return {
    id: typeof record.id === "string" ? record.id : fallback.id,
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    target,
    period: record.period === "week" || record.period === "month" ? record.period : fallback.period
  };
}

function normalizePanelOpacity(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultTraySettings.panelOpacity;
  }
  return clamp(number, 0.1, 1);
}

function normalizePanelPosition(value: unknown): TrayPanelPosition | undefined {
  const record = value && typeof value === "object" ? (value as Partial<TrayPanelPosition>) : {};
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function fallbackModelBudget(target: TrayModelTarget, index = 0): TrayModelBudgetSetting {
  return {
    target,
    enabled: true,
    weeklyBudget: 0,
    monthlyBudget: 0,
    ...defaultBudgetWindowSettings(target),
    customColor: resolveModelColor(target, index)
  };
}

function resolveSlotPeriod(slot: TraySlotSetting, budget: TrayModelBudgetSetting): TrayBudgetPeriod {
  const hasWeeklyBudget = budget.weeklyBudget > 0;
  const hasMonthlyBudget = budget.monthlyBudget > 0;
  if (hasWeeklyBudget && !hasMonthlyBudget) {
    return "week";
  }
  if (hasMonthlyBudget && !hasWeeklyBudget) {
    return "month";
  }
  if (hasWeeklyBudget && hasMonthlyBudget) {
    return slot.period === "month" ? "month" : "week";
  }
  return slot.period;
}

export function defaultBudgetPeriodForTarget(target: TrayModelTarget): TrayBudgetPeriod {
  const lower = target.toLowerCase();
  return lower.includes("gpt") || lower.includes("openai") || lower.includes("codex") ? "week" : "month";
}

function sumTargetUsage(rows: DailyPoint[], target: TrayModelTarget): ModelUsage {
  return rows.reduce<ModelUsage>(
    (total, row) => {
      for (const breakdown of breakdownsForRow(row)) {
        if (matchesTarget(breakdown.model, target)) {
          total.totalTokens += breakdown.totalTokens;
          total.costUSD += breakdown.costUSD;
        }
      }
      return total;
    },
    { model: target, totalTokens: 0, costUSD: 0 }
  );
}

function budgetRowsForPeriod(
  usage: NormalizedUsage,
  budget: TrayModelBudgetSetting,
  period: TrayBudgetPeriod,
  range: { start: string; end: string }
): DailyPoint[] {
  const dailyRows = filterUsageByRange(usage.daily, range);
  if (dailyRows.length > 0 || period !== "month" || budget.monthlyWindow !== "calendar-month" || range.start.slice(0, 7) !== range.end.slice(0, 7)) {
    return dailyRows;
  }
  return usage.monthly.filter((row) => row.month === range.start.slice(0, 7));
}

function breakdownsForRow(row: DailyPoint): ModelUsage[] {
  if (row.modelBreakdowns?.length) {
    return row.modelBreakdowns;
  }

  const models = row.models.length > 0 ? row.models : ["unknown"];
  return models.map((model) => ({
    model,
    totalTokens: row.totalTokens / models.length,
    costUSD: row.costUSD / models.length
  }));
}

function matchesTarget(model: string, target: TrayModelTarget): boolean {
  if (target === "all") {
    return true;
  }

  const lower = model.toLowerCase();
  if (target === "family:gpt") {
    return lower.includes("gpt") || lower.includes("openai") || lower.includes("codex") || /\bo[134]\b/.test(lower);
  }
  if (target === "family:claude") {
    return lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku");
  }
  if (target === "family:gemini") {
    return lower.includes("gemini");
  }

  return lower === target.toLowerCase();
}

function targetLabel(target: TrayModelTarget): string {
  switch (target) {
    case "family:gpt":
      return "GPT family";
    case "family:claude":
      return "Claude family";
    case "family:gemini":
      return "Gemini family";
    case "all":
      return "All models";
    default:
      return compactModelName(target);
  }
}

function buildTooltip(bars: TrayIndicatorBar[]): string {
  if (bars.length === 0) {
    return "No tray bars enabled";
  }

  const tooltip = bars.map((bar) => trayTooltipSegment(bar, false)).join("\n");
  return tooltip.length <= WINDOWS_TRAY_TOOLTIP_LIMIT ? tooltip : bars.map((bar) => trayTooltipSegment(bar, true)).join("\n");
}

function periodTooltipLabel(period: TrayBudgetPeriod): string {
  return period === "week" ? "Weekly" : "Month";
}

function tooltipTargetLabel(label: string): string {
  if (label === "GPT family") {
    return "GPT";
  }
  if (label === "Claude family") {
    return "Claude";
  }
  if (label === "Gemini family") {
    return "Gemini";
  }
  if (label === "All models") {
    return "All";
  }
  return label.length > 10 ? `${label.slice(0, 9)}...` : label;
}

function trayTooltipSegment(bar: TrayIndicatorBar, extraCompact: boolean): string {
  const label = tooltipTargetLabel(bar.label);
  const target = extraCompact && label.length > 6 ? label.slice(0, 6) : label;
  return `${target} ${periodTooltipLabel(bar.period)} ${budgetPairLabel(bar)}`;
}

function budgetPairLabel(bar: TrayIndicatorBar): string {
  const used = shortBudgetValueForPair(bar.usedValue, bar.budgetType);
  if (bar.budgetValue <= 0) {
    return `${used} · ${shortNumber(bar.usedTokens)} tokens`;
  }
  const budget = shortBudgetValueForPair(bar.budgetValue, bar.budgetType);
  return `${used}/${budget}`;
}

export function defaultBudgetWindowSettings(_target: TrayModelTarget): Pick<
  TrayModelBudgetSetting,
  "weeklyWindow" | "monthlyWindow" | "weeklyResetDay" | "weeklyResetTime" | "billingCycleDay"
> {
  return {
    weeklyWindow: "calendar-week",
    monthlyWindow: "calendar-month",
    weeklyResetDay: 1,
    weeklyResetTime: "00:00",
    billingCycleDay: 1
  };
}

export function budgetDateRange(setting: TrayModelBudgetSetting, period: TrayBudgetPeriod, reference = new Date()) {
  if (period === "month") {
    return getBudgetMonthRange(setting.monthlyWindow, setting.billingCycleDay, reference);
  }
  return getBudgetWeekRange(setting.weeklyWindow, setting.weeklyResetDay, setting.weeklyResetTime, reference);
}

function formatShortRange(range: { start: string; end: string }): string {
  if (range.start === range.end) {
    return shortDateLabel(range.start);
  }
  return `${shortDateLabel(range.start)} - ${shortDateLabel(range.end)}`;
}

function budgetWindowShortLabel(setting: TrayModelBudgetSetting, period: TrayBudgetPeriod, range: { start: string; end: string }): string {
  const rangeLabel = formatShortRange(range);
  if (period === "week") {
    const windowLabel =
      setting.weeklyWindow === "assigned-week"
        ? `Reset ${weekdayLabel(setting.weeklyResetDay)} ${setting.weeklyResetTime}`
        : "Calendar week";
    return `${windowLabel} · ${rangeLabel}`;
  }

  const windowLabel = setting.monthlyWindow === "billing-cycle" ? `Billing day ${setting.billingCycleDay}` : "Calendar month";
  return `${windowLabel} · ${rangeLabel}`;
}

function weekdayLabel(value: number): string {
  const labels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return labels[value] ?? "Monday";
}

function shortDateLabel(value: string): string {
  const date = parseDateKey(value);
  if (!date) {
    return value;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortBudgetValueForPair(value: number, type: TrayBudgetType): string {
  return type === "cost" ? shortMoney(value) : shortNumber(value);
}

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shortNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(Math.round(value));
}

function shortMoney(value: number): string {
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
