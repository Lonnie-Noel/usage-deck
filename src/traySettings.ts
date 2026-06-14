import type { DailyPoint, ModelUsage, NormalizedUsage } from "./usageSchema";

export type TrayBudgetPeriod = "week" | "month";
export type TrayBudgetType = "tokens" | "cost";
export type TrayModelTarget = "family:gpt" | "family:claude" | "family:gemini" | "all" | string;

export type TrayBarSetting = {
  id: string;
  enabled: boolean;
  target: TrayModelTarget;
  period: TrayBudgetPeriod;
  budgetType: TrayBudgetType;
  weeklyBudget: number;
  monthlyBudget: number;
  customColor: string;
};

export type TrayIndicatorSettings = {
  enabled: boolean;
  bars: [TrayBarSetting, TrayBarSetting];
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
};

export type TrayIndicatorSummary = {
  enabled: boolean;
  bars: TrayIndicatorBar[];
  tooltip: string;
};

const STORAGE_KEY = "usage-deck.tray-indicator.v1";
const DEFAULT_GPT = "#8AB4FF";
const DEFAULT_CLAUDE = "#D98B4E";

const MODEL_COLORS = [
  "#8AB4FF",
  "#D98B4E",
  "#6FB7A8",
  "#D66F5D",
  "#B7A36F",
  "#9D8AD8",
  "#70A0AF",
  "#C47E9B"
];

export const defaultTraySettings: TrayIndicatorSettings = {
  enabled: true,
  bars: [
    {
      id: "primary",
      enabled: true,
      target: "family:gpt",
      period: "week",
      budgetType: "tokens",
      weeklyBudget: 0,
      monthlyBudget: 0,
      customColor: DEFAULT_GPT
    },
    {
      id: "secondary",
      enabled: true,
      target: "family:claude",
      period: "month",
      budgetType: "tokens",
      weeklyBudget: 0,
      monthlyBudget: 0,
      customColor: DEFAULT_CLAUDE
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
  const bars = Array.isArray(record.bars) ? record.bars : [];

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaultTraySettings.enabled,
    bars: [
      normalizeBar(bars[0], defaultTraySettings.bars[0]),
      normalizeBar(bars[1], defaultTraySettings.bars[1])
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

export function buildTrayIndicatorSummary(settings: TrayIndicatorSettings, usage: NormalizedUsage): TrayIndicatorSummary {
  if (!settings.enabled) {
    return {
      enabled: false,
      bars: [],
      tooltip: "Usage Deck tray indicator is disabled."
    };
  }

  const activeSettings = settings.bars.filter((bar) => bar.enabled).slice(0, 2);
  const periodTotals = {
    week: totalPeriodUsage(usage.daily, "week"),
    month: totalPeriodUsage(usage.daily, "month")
  };

  const bars = activeSettings.map((bar, index) => {
    const stats = sumTargetUsage(usage.daily, bar.target, bar.period);
    const configuredBudget = bar.period === "week" ? bar.weeklyBudget : bar.monthlyBudget;
    const usedValue = budgetValueForType(stats, bar.budgetType);
    const relativeBudget = budgetValueForType(periodTotals[bar.period], bar.budgetType);
    const budgetValue = configuredBudget > 0 ? configuredBudget : relativeBudget;
    const color = isHexColor(bar.customColor) ? bar.customColor : resolveModelColor(bar.target, index);
    const budgetSource: TrayIndicatorBar["budgetSource"] = configuredBudget > 0 ? "configured" : "relative";

    return {
      id: bar.id,
      label: targetLabel(bar.target),
      period: bar.period,
      color,
      usedTokens: stats.totalTokens,
      costUSD: stats.costUSD,
      usedValue,
      budgetValue,
      budgetType: bar.budgetType,
      ratio: budgetValue > 0 ? clamp(usedValue / budgetValue, 0, 1) : 0,
      budgetSource
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
    return "#8AA7E8";
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

function normalizeBar(input: unknown, fallback: TrayBarSetting): TrayBarSetting {
  const record = input && typeof input === "object" ? (input as Partial<TrayBarSetting>) : {};
  const legacyRecord = record as Partial<TrayBarSetting> & { colorMode?: "auto" | "custom" };
  const target = typeof record.target === "string" ? record.target : fallback.target;
  const preserveStoredColor = legacyRecord.colorMode === undefined ? isHexColor(record.customColor) : legacyRecord.colorMode === "custom";
  return {
    id: typeof record.id === "string" ? record.id : fallback.id,
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    target,
    period: record.period === "month" ? "month" : record.period === "week" ? "week" : fallback.period,
    budgetType: record.budgetType === "cost" ? "cost" : record.budgetType === "tokens" ? "tokens" : fallback.budgetType,
    weeklyBudget: finiteNumber(record.weeklyBudget),
    monthlyBudget: finiteNumber(record.monthlyBudget),
    customColor: isHexColor(record.customColor) && preserveStoredColor ? record.customColor : resolveModelColor(target)
  };
}

function sumTargetUsage(rows: DailyPoint[], target: TrayModelTarget, period: TrayBudgetPeriod): ModelUsage {
  return filterPeriod(rows, period).reduce<ModelUsage>(
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

function totalPeriodUsage(rows: DailyPoint[], period: TrayBudgetPeriod): ModelUsage {
  return filterPeriod(rows, period).reduce<ModelUsage>(
    (total, row) => ({
      model: "all",
      totalTokens: total.totalTokens + row.totalTokens,
      costUSD: total.costUSD + row.costUSD
    }),
    { model: "all", totalTokens: 0, costUSD: 0 }
  );
}

function filterPeriod(rows: DailyPoint[], period: TrayBudgetPeriod): DailyPoint[] {
  if (rows.length === 0) {
    return [];
  }

  const sorted = rows.slice().sort((left, right) => left.date.localeCompare(right.date));
  const latest = parseDateKey(sorted.at(-1)?.date ?? "");
  if (!latest) {
    return sorted;
  }

  if (period === "month") {
    const monthKey = sorted.at(-1)?.date.slice(0, 7) ?? "";
    return sorted.filter((row) => row.date.startsWith(monthKey));
  }

  const weekStart = new Date(latest);
  weekStart.setDate(latest.getDate() - 6);
  return sorted.filter((row) => {
    const rowDate = parseDateKey(row.date);
    return rowDate ? rowDate >= weekStart && rowDate <= latest : false;
  });
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
    return "Usage Deck: no tray bars enabled";
  }

  return [
    "Usage Deck",
    ...bars.map(
      (bar) =>
        `${bar.label} ${bar.period}: ${shortBudgetValue(bar.usedValue, bar.budgetType)} / ${
          bar.budgetSource === "configured" && bar.budgetValue > 0
            ? shortBudgetValue(bar.budgetValue, bar.budgetType)
            : relativeBudgetLabel(bar.budgetType)
        }`
    )
  ].join("\n");
}

function budgetValueForType(usage: Pick<ModelUsage, "totalTokens" | "costUSD">, type: TrayBudgetType): number {
  return type === "cost" ? usage.costUSD : usage.totalTokens;
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

function shortBudgetValue(value: number, type: TrayBudgetType): string {
  if (type === "cost") {
    return shortMoney(value);
  }
  return `${shortNumber(value)} tokens`;
}

function shortMoney(value: number): string {
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function relativeBudgetLabel(type: TrayBudgetType): string {
  return type === "cost" ? "relative cost scale" : "relative token scale";
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
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
