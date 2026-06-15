import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  Palette,
  RefreshCw,
  Settings,
  Terminal,
  X,
  Zap
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { createMockCollection } from "./mockData";
import { loadUsageCollection, type RequestedSourceMode } from "./usageClient";
import {
  filterUsageByRange,
  getDayRange,
  getMonthRange,
  getPresetRange,
  getWeekRange,
  normalizeDateRange,
  parseDateKey,
  summarizeUsage,
  toDateKey,
  type DateRange,
  type PeriodMode,
  type UsageSummary
} from "./dateRanges";
import {
  normalizeUsage,
  type BlockPoint,
  type Diagnostic,
  type ModelUsage,
  type NormalizedUsage,
  type SessionPoint
} from "./usageSchema";
import {
  buildModelOptions,
  buildTrayIndicatorSummary,
  defaultTraySettings,
  loadTraySettings,
  normalizeTraySettings,
  resolveModelColor,
  saveTraySettings,
  type TrayBarSetting,
  type TrayIndicatorBar,
  type TrayIndicatorSettings
} from "./traySettings";

type ViewKey = "overview" | "daily" | "monthly" | "sessions" | "blocks" | "settings";
type AppTheme = "dark" | "light" | "system";
type ResolvedAppTheme = Exclude<AppTheme, "system">;
type TrendMetric = "tokens" | "cost";
type TrendDisplayMode = "total" | "model" | "family";
type MonthlyMetric = "cost" | "tokens";
type TrendFamilyTarget = "family:gpt" | "family:claude" | "family:gemini" | "family:other";
type TrendModelTarget = "all" | TrendFamilyTarget | string;

type UsageTrendPoint = {
  date: string;
  totalTokens: number;
  costUSD: number;
  models: string[];
  sessionCount?: number;
  [seriesKey: string]: string | number | string[] | undefined;
};

type TrendSeries = {
  key: string;
  label: string;
  color: string;
  target: TrendModelTarget;
};

type TrendResult = {
  rows: UsageTrendPoint[];
  series: TrendSeries[];
  hasData: boolean;
};

type TrendPreferences = {
  metric: TrendMetric;
  displayMode: TrendDisplayMode;
  selectedTargets: TrendModelTarget[];
  periodMode: PeriodMode;
  customRange: DateRange;
};

type OverviewUsageScope = {
  activeBlock?: BlockPoint;
  blocks: BlockPoint[];
  modelUsage: ModelUsage[];
  sessions: SessionPoint[];
};

type TrendModelFilterCatalog = {
  familyOptions: ModelFilterOption[];
  modelOptions: ModelFilterOption[];
  detectedModelValues: string[];
};

type ModelFilterOption = {
  value: TrendModelTarget;
  label: string;
  detected: boolean;
  totalTokens: number;
};

type TrendUsageRow =
  | NormalizedUsage["daily"][number]
  | NormalizedUsage["monthly"][number]
  | NormalizedUsage["sessions"][number]
  | NormalizedUsage["blocks"][number];

type TrendBucket = {
  date: string;
  rows: TrendUsageRow[];
  sessionCount?: number;
};

const navItems: Array<{ key: ViewKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "daily", label: "Trends", icon: CalendarDays },
  { key: "monthly", label: "Monthly", icon: BarChart3 },
  { key: "sessions", label: "Sessions", icon: ListChecks },
  { key: "blocks", label: "Blocks", icon: Clock3 },
  { key: "settings", label: "Settings", icon: Settings }
];

const dailyPeriodOptions: Array<{ mode: PeriodMode; label: string }> = [
  { mode: "12hrs", label: "12Hrs" },
  { mode: "day", label: "Day" },
  { mode: "week", label: "Week" },
  { mode: "month", label: "Month" },
  { mode: "custom", label: "Custom" }
];

const trendDisplayOptions: Array<{ mode: TrendDisplayMode; label: string }> = [
  { mode: "total", label: "Total" },
  { mode: "model", label: "By model" },
  { mode: "family", label: "By family" }
];

const trendMetricOptions: Array<{ metric: TrendMetric; label: string }> = [
  { metric: "tokens", label: "Tokens" },
  { metric: "cost", label: "Cost" }
];

const familyTargets: Array<{ value: TrendFamilyTarget; label: string }> = [
  { value: "family:gpt", label: "GPT / OpenAI family" },
  { value: "family:claude", label: "Claude family" },
  { value: "family:gemini", label: "Gemini family" },
  { value: "family:other", label: "Other / unknown" }
];

const knownModelCandidates = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5-codex",
  "claude-sonnet-4-5",
  "claude-opus-4",
  "claude-haiku-4",
  "gemini-2.5-pro"
];

const THEME_STORAGE_KEY = "usage-deck.theme";
const TREND_PREFERENCES_STORAGE_KEY = "usage-deck.trend-preferences.v1";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const TRAY_SETTINGS_SYNC_DELAY_MS = 300;
const DEFAULT_TREND_PREFERENCES: TrendPreferences = {
  metric: "tokens",
  displayMode: "family",
  selectedTargets: ["family:gpt", "family:claude", "family:gemini"],
  periodMode: "month",
  customRange: getPresetRange("month")
};

export function App() {
  const isTrayPanel = new URLSearchParams(window.location.search).get("panel") === "tray";
  const [activeView, setActiveView] = useState<ViewKey>("overview");
  const [sourceMode, setSourceMode] = useState<RequestedSourceMode>("bundled");
  const [refreshSeconds, setRefreshSeconds] = useState(120);
  const [theme, setTheme] = useState<AppTheme>(() => loadTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedAppTheme>(() => resolveSystemTheme());
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [traySettings, setTraySettings] = useState<TrayIndicatorSettings>(() => loadTraySettings());
  const [traySettingsReady, setTraySettingsReady] = useState(() => !window.__TAURI_INTERNALS__);
  const [trendPreferences, setTrendPreferences] = useState<TrendPreferences>(() => loadTrendPreferences());
  const [usage, setUsage] = useState<NormalizedUsage>(() =>
    normalizeUsage(createMockCollection("Initial dashboard preview."))
  );
  const appliedTraySettings = useDebouncedValue(traySettings, TRAY_SETTINGS_SYNC_DELAY_MS);
  const nativeTraySettings = useMemo(
    () => mergeImmediateTraySettings(traySettings, appliedTraySettings),
    [appliedTraySettings, traySettings]
  );
  const trendMetric = trendPreferences.metric;
  const trendDisplayMode = trendPreferences.displayMode;
  const selectedTrendTargets = trendPreferences.selectedTargets;
  const dailyPeriodMode = trendPreferences.periodMode;
  const customDateRange = trendPreferences.customRange;
  const setTrendMetric = useCallback(
    (metric: TrendMetric) => setTrendPreferences((current) => ({ ...current, metric })),
    []
  );
  const setTrendDisplayMode = useCallback(
    (displayMode: TrendDisplayMode) => setTrendPreferences((current) => ({ ...current, displayMode })),
    []
  );
  const setSelectedTrendTargets = useCallback(
    (selectedTargets: TrendModelTarget[]) => setTrendPreferences((current) => ({ ...current, selectedTargets })),
    []
  );
  const setDailyPeriodMode = useCallback(
    (periodMode: PeriodMode) => setTrendPreferences((current) => ({ ...current, periodMode })),
    []
  );
  const setCustomDateRange = useCallback(
    (customRange: DateRange) => setTrendPreferences((current) => ({ ...current, customRange })),
    []
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const collection = await loadUsageCollection(sourceMode);
      setUsage(normalizeUsage(collection));
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, [sourceMode]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const appliedTheme = theme === "system" ? systemTheme : theme;
    document.documentElement.dataset.theme = appliedTheme;
    document.documentElement.dataset.themeSetting = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [systemTheme, theme]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }

    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const syncSystemTheme = () => setSystemTheme(media.matches ? "dark" : "light");
    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    if (refreshSeconds <= 0) {
      return;
    }
    const interval = isTrayPanel ? Math.min(refreshSeconds, 60) : refreshSeconds;
    const timer = window.setInterval(() => void loadData(), interval * 1000);
    return () => window.clearInterval(timer);
  }, [isTrayPanel, loadData, refreshSeconds]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      return;
    }

    let cancelled = false;
    void invoke<unknown | null>("load_tray_settings")
      .then((storedSettings) => {
        if (cancelled || !storedSettings) {
          return;
        }
        const normalizedSettings = normalizeTraySettings(storedSettings);
        saveTraySettings(normalizedSettings);
        setTraySettings(normalizedSettings);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setTraySettingsReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<unknown>("tray-settings-changed", (event) => {
      const normalizedSettings = normalizeTraySettings(event.payload);
      saveTraySettings(normalizedSettings);
      setTraySettings((current) => (sameTraySettings(current, normalizedSettings) ? current : normalizedSettings));
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!traySettingsReady) {
      return;
    }

    saveTraySettings(nativeTraySettings);
    if (window.__TAURI_INTERNALS__ && !isTrayPanel) {
      void invoke("save_tray_settings", { settings: nativeTraySettings }).catch(() => undefined);
    }
  }, [isTrayPanel, nativeTraySettings, traySettingsReady]);

  useEffect(() => {
    saveTrendPreferences(trendPreferences);
  }, [trendPreferences]);

  const traySummary = useMemo(() => buildTrayIndicatorSummary(traySettings, usage), [traySettings, usage]);
  const nativeTraySummary = useMemo(() => buildTrayIndicatorSummary(nativeTraySettings, usage), [nativeTraySettings, usage]);
  const modelOptions = useMemo(() => buildModelOptions(usage), [usage]);
  const trendModelCatalog = useMemo(() => buildTrendModelFilterCatalog(usage), [usage]);
  const activeDailyRange = useMemo(
    () =>
      dailyPeriodMode === "custom"
        ? normalizeDateRange(customDateRange)
        : getPresetRange(dailyPeriodMode, lastRefresh ?? new Date()),
    [customDateRange, dailyPeriodMode, lastRefresh]
  );
  const activeDailyRows = useMemo(() => filterUsageByRange(usage.daily, activeDailyRange), [activeDailyRange, usage.daily]);
  const activeTrend = useMemo(
    () => buildTrendRows(usage, dailyPeriodMode, activeDailyRange, trendDisplayMode, selectedTrendTargets, trendModelCatalog, trendMetric),
    [activeDailyRange, dailyPeriodMode, selectedTrendTargets, trendDisplayMode, trendMetric, trendModelCatalog, usage]
  );

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !traySettingsReady || (nativeTraySummary.enabled && !lastRefresh)) {
      return;
    }
    void invoke("update_tray_indicator", { summary: nativeTraySummary }).catch(() => undefined);
  }, [lastRefresh, nativeTraySummary, traySettingsReady]);

  const criticalDiagnostics = usage.diagnostics.filter((item) => item.severity === "error");

  if (isTrayPanel) {
    return <TrayPanel usage={usage} summary={traySummary} loading={loading} onRefresh={() => void loadData()} />;
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-lockup">
          <div className="brand-mark">UD</div>
          <div>
            <h1>Usage Deck</h1>
            <span>AI token and cost dashboard</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Usage Deck sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={activeView === item.key ? "nav-item active" : "nav-item"}
                onClick={() => setActiveView(item.key)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="rail-footer">
          <div className="source-chip">
            <HardDrive />
            <span>{sourceLabel(usage.collection.effectiveSourceMode)}</span>
          </div>
          <span className="version-text">{formatCcusageVersion(usage.collection.ccusageVersion)}</span>
        </div>
      </aside>

      <section className="deck">
        <header className="topbar">
          <div className="topbar-copy">
            <h2>{pageTitle(activeView)}</h2>
          </div>
          <div className="topbar-actions">
            <div className="refresh-stamp">
              <span>Last refresh</span>
              <strong>{lastRefresh ? lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}</strong>
            </div>
            <button className="icon-command" onClick={() => void loadData()} disabled={loading} aria-label="Refresh usage">
              <RefreshCw className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        {criticalDiagnostics.length > 0 ? <DiagnosticBanner diagnostics={criticalDiagnostics} /> : null}

        {loading ? (
          <div className="loading-strip">
            <RefreshCw className="spin" />
            <span>Reading ccusage JSON</span>
          </div>
        ) : null}

        <section className="content-surface">
          {activeView === "overview" ? (
            <Overview
              usage={usage}
              trend={activeTrend}
              trendMetric={trendMetric}
              trendMode={dailyPeriodMode}
              trendRange={activeDailyRange}
              selectedTargets={selectedTrendTargets}
            />
          ) : null}
          {activeView === "daily" ? (
            <DailyView
              rows={activeDailyRows}
              trend={activeTrend}
              periodMode={dailyPeriodMode}
              activeRange={activeDailyRange}
              customRange={customDateRange}
              trendMetric={trendMetric}
              displayMode={trendDisplayMode}
              selectedTargets={selectedTrendTargets}
              modelCatalog={trendModelCatalog}
              onPeriodMode={setDailyPeriodMode}
              onCustomRange={setCustomDateRange}
              onTrendMetric={setTrendMetric}
              onDisplayMode={setTrendDisplayMode}
              onSelectedTargets={setSelectedTrendTargets}
            />
          ) : null}
          {activeView === "monthly" ? <MonthlyView usage={usage} selectedTargets={selectedTrendTargets} /> : null}
          {activeView === "sessions" ? <SessionsView sessions={usage.sessions} /> : null}
          {activeView === "blocks" ? <BlocksView blocks={usage.blocks} /> : null}
          {activeView === "settings" ? (
            <SettingsView
              usage={usage}
              sourceMode={sourceMode}
              refreshSeconds={refreshSeconds}
              theme={theme}
              onSourceMode={setSourceMode}
              onRefreshSeconds={setRefreshSeconds}
              onTheme={setTheme}
              traySettings={traySettings}
              traySummary={traySummary}
              modelOptions={modelOptions}
              onTraySettings={setTraySettings}
            />
          ) : null}
        </section>
      </section>
    </main>
  );
}

function Overview({
  usage,
  trend,
  trendMetric,
  trendMode,
  trendRange,
  selectedTargets
}: {
  usage: NormalizedUsage;
  trend: TrendResult;
  trendMetric: TrendMetric;
  trendMode: PeriodMode;
  trendRange: DateRange;
  selectedTargets: TrendModelTarget[];
}) {
  const todayRange = getDayRange();
  const weekRange = getWeekRange();
  const monthRange = getMonthRange();
  const overviewScope = buildOverviewUsageScope(usage, selectedTargets);
  const todaySummary = summarizeSelectedUsage(filterUsageByRange(usage.daily, todayRange), selectedTargets);
  const weekSummary = summarizeSelectedUsage(filterUsageByRange(usage.daily, weekRange), selectedTargets);
  const monthSummary = summarizeMonthUsage(usage, monthRange, selectedTargets);
  const scopeMeta = selectedTargets.includes("all") ? "all models" : "selected models";
  const modelMixMeta = formatModelMixMeta(overviewScope.modelUsage.length, selectedTargets);

  return (
    <div className="overview-grid">
      <MetricCard
        icon={Activity}
        label="Today"
        value={formatMoney(todaySummary.costUSD)}
        detail={metricDetail(todaySummary, todayRange, "day")}
      />
      <MetricCard
        icon={CalendarDays}
        label="Week"
        value={formatMoney(weekSummary.costUSD)}
        detail={metricDetail(weekSummary, weekRange, "week")}
      />
      <MetricCard
        icon={BarChart3}
        label="Month cost"
        value={formatMoney(monthSummary.costUSD)}
        detail={metricDetail(monthSummary, monthRange, "month")}
      />
      <MetricCard
        icon={Zap}
        label="Active block"
        value={overviewScope.activeBlock ? formatNumber(overviewScope.activeBlock.totalTokens) : "idle"}
        detail={overviewScope.activeBlock?.timeRemaining || (usage.activeBlock ? "no matching active block" : "no active 5-hour block")}
      />

      <section className="panel trend-panel">
        <PanelTitle
          icon={CalendarDays}
          title={`${formatTrendMetricLabel(trendMetric)} trend`}
          meta={`${formatTrendMeta(trendMode, trendRange)} · ${scopeMeta}`}
        />
        {trend.hasData ? (
          <DailyChart data={trend.rows} series={trend.series} metric={trendMetric} />
        ) : (
          <EmptyState text="No usage rows were returned." />
        )}
      </section>

      <section className="panel model-panel">
        <PanelTitle icon={Database} title="Model mix" meta={modelMixMeta} />
        {overviewScope.modelUsage.length > 0 ? (
          <div className="model-list">
            {overviewScope.modelUsage.map((item) => (
              <div className="model-row" key={item.model}>
                <div className="model-row-heading">
                  <strong>{compactModelName(item.model)}</strong>
                  <span className="model-cost">{formatMoney(item.costUSD)}</span>
                </div>
                <meter value={item.totalTokens} max={overviewScope.modelUsage[0]?.totalTokens || 1} />
                <span className="model-tokens">{formatNumber(Math.round(item.totalTokens))} tokens</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState text="No model names were found in the JSON payload." />
        )}
      </section>

      <section className="panel tape-panel">
        <PanelTitle icon={Clock3} title="Token tape" meta="recent blocks" />
        <TokenTape blocks={overviewScope.blocks} />
      </section>

      <section className="panel sessions-panel">
        <PanelTitle icon={ListChecks} title="Recent sessions" meta={`${overviewScope.sessions.length} sessions`} />
        <SessionsTable sessions={overviewScope.sessions.slice(0, 6)} compact />
      </section>
    </div>
  );
}

function DailyView({
  rows,
  trend,
  periodMode,
  activeRange,
  customRange,
  trendMetric,
  displayMode,
  selectedTargets,
  modelCatalog,
  onPeriodMode,
  onCustomRange,
  onTrendMetric,
  onDisplayMode,
  onSelectedTargets
}: {
  rows: NormalizedUsage["daily"];
  trend: TrendResult;
  periodMode: PeriodMode;
  activeRange: DateRange;
  customRange: DateRange;
  trendMetric: TrendMetric;
  displayMode: TrendDisplayMode;
  selectedTargets: TrendModelTarget[];
  modelCatalog: TrendModelFilterCatalog;
  onPeriodMode: (mode: PeriodMode) => void;
  onCustomRange: (range: DateRange) => void;
  onTrendMetric: (metric: TrendMetric) => void;
  onDisplayMode: (mode: TrendDisplayMode) => void;
  onSelectedTargets: (targets: TrendModelTarget[]) => void;
}) {
  const showHourlyRows = isHourlyTrendMode(periodMode);
  const hourlyMeta = periodMode === "12hrs" ? "12 hours" : "24 hours";
  const trendRows = trend.rows;
  const trendColumns = showHourlyRows
    ? trendMetric === "cost"
      ? ["Hour", "Cost", "Tokens", "Sessions"]
      : ["Hour", "Tokens", "Cost", "Sessions"]
    : trendMetric === "cost"
      ? ["Date", "Cost", "Tokens", "Models"]
      : ["Date", "Tokens", "Cost", "Models"];

  return (
    <div className="single-column">
      <section className="panel tall-panel">
        <PanelTitle icon={CalendarDays} title="Usage trend" meta={showHourlyRows ? hourlyMeta : `${rows.length} rows`} />
        <PeriodControls
          mode={periodMode}
          activeRange={activeRange}
          customRange={customRange}
          onMode={onPeriodMode}
          onCustomRange={onCustomRange}
        />
        <TrendMetricControls metric={trendMetric} onMetric={onTrendMetric} />
        <ModelFilterControls
          displayMode={displayMode}
          selectedTargets={selectedTargets}
          catalog={modelCatalog}
          onDisplayMode={onDisplayMode}
          onSelectedTargets={onSelectedTargets}
        />
        {trend.hasData ? (
          <DailyChart data={trendRows} series={trend.series} metric={trendMetric} tall />
        ) : (
          <EmptyState text="No usage rows available for this period." />
        )}
      </section>
      {showHourlyRows ? (
        <DataTable
          columns={trendColumns}
          rows={trendRows
            .filter((row) => row.totalTokens > 0)
            .slice()
            .reverse()
            .map((row) =>
              trendMetric === "cost"
                ? [row.date, formatMoney(row.costUSD), formatNumber(row.totalTokens), String(row.sessionCount ?? 0)]
                : [row.date, formatNumber(row.totalTokens), formatMoney(row.costUSD), String(row.sessionCount ?? 0)]
            )}
        />
      ) : (
        <DataTable
          columns={trendColumns}
          rows={trendRows
            .slice()
            .reverse()
            .map((row) =>
              trendMetric === "cost"
                ? [row.date, formatMoney(row.costUSD), formatNumber(row.totalTokens), row.models.map(compactModelName).join(", ")]
                : [row.date, formatNumber(row.totalTokens), formatMoney(row.costUSD), row.models.map(compactModelName).join(", ")]
            )}
        />
      )}
    </div>
  );
}

function TrendMetricControls({ metric, onMetric }: { metric: TrendMetric; onMetric: (metric: TrendMetric) => void }) {
  return (
    <div className="trend-metric-controls">
      <div className="segmented-control metric-toggle" role="group" aria-label="Trend metric">
        {trendMetricOptions.map((option) => (
          <button
            type="button"
            className={metric === option.metric ? "period-button active" : "period-button"}
            aria-pressed={metric === option.metric}
            key={option.metric}
            onClick={() => onMetric(option.metric)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PeriodControls({
  mode,
  activeRange,
  customRange,
  onMode,
  onCustomRange
}: {
  mode: PeriodMode;
  activeRange: DateRange;
  customRange: DateRange;
  onMode: (mode: PeriodMode) => void;
  onCustomRange: (range: DateRange) => void;
}) {
  return (
    <div className="period-controls">
      <div className="period-control-row">
        <div className="segmented-control" role="group" aria-label="Trend period">
          {dailyPeriodOptions.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={mode === option.mode ? "period-button active" : "period-button"}
              aria-pressed={mode === option.mode}
              onClick={() => onMode(option.mode)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="period-meta">{formatPeriodMeta(mode, activeRange)}</span>
      </div>

      {mode === "custom" ? (
        <div className="date-range-fields">
          <label>
            <span>Start</span>
            <input
              type="date"
              value={customRange.start}
              max={customRange.end}
              onInput={(event) => onCustomRange({ ...customRange, start: event.currentTarget.value || customRange.start })}
              onChange={(event) => onCustomRange({ ...customRange, start: event.target.value || customRange.start })}
            />
          </label>
          <label>
            <span>End</span>
            <input
              type="date"
              value={customRange.end}
              min={customRange.start}
              onInput={(event) => onCustomRange({ ...customRange, end: event.currentTarget.value || customRange.end })}
              onChange={(event) => onCustomRange({ ...customRange, end: event.target.value || customRange.end })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function ModelFilterControls({
  displayMode,
  selectedTargets,
  catalog,
  onDisplayMode,
  onSelectedTargets
}: {
  displayMode: TrendDisplayMode;
  selectedTargets: TrendModelTarget[];
  catalog: TrendModelFilterCatalog;
  onDisplayMode: (mode: TrendDisplayMode) => void;
  onSelectedTargets: (targets: TrendModelTarget[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const selectedSet = new Set(selectedTargets);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = catalog.modelOptions.filter((option) => !normalizedQuery || option.label.toLowerCase().includes(normalizedQuery));
  const selectedLabel = selectedSet.has("all")
    ? displayMode === "family"
      ? "All detected families"
      : "All detected models"
    : selectedTargets.length === 0
      ? displayMode === "family"
        ? "No families"
        : "No models"
      : `${selectedTargets.length} selected`;
  const visibleOptions = displayMode === "family" ? catalog.familyOptions : visibleModels;
  const optionNoun = displayMode === "family" ? "families" : "models";

  const toggleTarget = (target: TrendModelTarget) => {
    if (target === "all") {
      onSelectedTargets(selectedSet.has("all") ? [] : ["all"]);
      return;
    }

    const next = selectedTargets.filter((item) => item !== "all");
    if (next.includes(target)) {
      onSelectedTargets(next.filter((item) => item !== target));
      return;
    }
    onSelectedTargets([...next, target]);
  };
  const changeDisplayMode = (mode: TrendDisplayMode) => {
    onDisplayMode(mode);
    setQuery("");
    if (mode === "total") {
      onSelectedTargets(["all"]);
      return;
    }
    if (mode === "family" && !selectedTargets.some((target) => target === "all" || isFamilyTarget(target))) {
      onSelectedTargets(["all"]);
    }
    if (mode === "model" && !selectedTargets.some((target) => target === "all" || !isFamilyTarget(target))) {
      onSelectedTargets(["all"]);
    }
  };
  const selectDetected = () => {
    if (displayMode === "family") {
      onSelectedTargets(catalog.familyOptions.filter((option) => option.detected).map((option) => option.value));
      return;
    }
    onSelectedTargets(catalog.detectedModelValues);
  };

  return (
    <div className="model-filter-shell">
      <button
        aria-expanded={expanded}
        className="model-filter-summary"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>Scope: {selectedLabel}</span>
        <strong>{trendDisplayOptions.find((option) => option.mode === displayMode)?.label ?? "Total"}</strong>
      </button>

      {expanded ? (
        <div className="model-filter-panel">
        <div className="model-filter-topline">
        <div className="mode-switch" role="group" aria-label="Trend display mode">
          {trendDisplayOptions.map((option) => (
            <button
              className={displayMode === option.mode ? "period-button active" : "period-button"}
              aria-pressed={displayMode === option.mode}
              key={option.mode}
              onClick={() => changeDisplayMode(option.mode)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="model-filter-count">{selectedLabel}</span>
      </div>

      {displayMode !== "total" ? (
        <div className="model-filter-actions">
        {displayMode === "model" ? (
          <input
            aria-label="Filter models"
            placeholder="Filter models"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <button className="secondary-command" type="button" onClick={selectDetected}>
          All detected {optionNoun}
        </button>
        <button className="secondary-command" type="button" onClick={() => onSelectedTargets([])}>
          Clear
        </button>
        <button
          className="secondary-command"
          type="button"
          onClick={() => {
            onDisplayMode("total");
            onSelectedTargets(["all"]);
          }}
        >
          Total only
        </button>
      </div>
      ) : null}

      {displayMode !== "total" ? (
        <div className={displayMode === "family" ? "model-filter-grid" : "model-filter-models"}>
          <label className={selectedSet.has("all") ? "model-filter-option active" : "model-filter-option"}>
            <input type="checkbox" checked={selectedSet.has("all")} onChange={() => toggleTarget("all")} />
            <span>
              <strong>All detected {optionNoun}</strong>
              <small>Breakdown source</small>
            </span>
          </label>

          {visibleOptions.map((option) => (
            <ModelFilterOptionControl
              checked={selectedSet.has(option.value)}
              key={option.value}
              option={option}
              onToggle={() => toggleTarget(option.value)}
            />
          ))}
          {visibleOptions.length === 0 ? <span className="model-filter-empty">No matching models.</span> : null}
        </div>
      ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelFilterOptionControl({
  option,
  checked,
  onToggle
}: {
  option: ModelFilterOption;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={checked ? "model-filter-option active" : "model-filter-option"}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span>
        <strong>{option.label}</strong>
        <small>{option.detected ? `${shortNumber(option.totalTokens)} tokens detected` : "available"}</small>
      </span>
      {option.detected ? <em>detected</em> : null}
    </label>
  );
}

function MonthlyView({ usage, selectedTargets }: { usage: NormalizedUsage; selectedTargets: TrendModelTarget[] }) {
  const [monthlyMetric, setMonthlyMetric] = useState<MonthlyMetric>("cost");
  const monthlyRows = filterUsageRowsByTargets(usage.monthly, selectedTargets);
  const dataKey = monthlyMetric === "cost" ? "costUSD" : "totalTokens";
  const title = monthlyMetric === "cost" ? "Monthly cost" : "Monthly tokens";
  const scopeMeta = selectedTargets.includes("all") ? "all models" : "selected models";
  const cursorTint = monthlyMetric === "cost" ? "rgba(201, 151, 75, 0.16)" : "rgba(111, 183, 168, 0.16)";

  return (
    <div className="single-column">
      <section className="panel tall-panel">
        <PanelTitle icon={BarChart3} title={title} meta={`${monthlyRows.length} rows · ${scopeMeta}`} />
        <div className="monthly-toolbar">
          <div className="segmented-control metric-toggle" role="group" aria-label="Monthly metric">
            <button
              type="button"
              className={monthlyMetric === "cost" ? "period-button active" : "period-button"}
              aria-pressed={monthlyMetric === "cost"}
              onClick={() => setMonthlyMetric("cost")}
            >
              Cost
            </button>
            <button
              type="button"
              className={monthlyMetric === "tokens" ? "period-button active" : "period-button"}
              aria-pressed={monthlyMetric === "tokens"}
              onClick={() => setMonthlyMetric("tokens")}
            >
              Tokens
            </button>
          </div>
          <span className="period-meta">{scopeMeta}</span>
        </div>
        {monthlyRows.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={monthlyRows}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fill: "var(--muted)", fontSize: 12 }}
                axisLine={false}
                tickFormatter={(value) => (monthlyMetric === "cost" ? formatMoney(Number(value)) : shortNumber(Number(value)))}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ fill: cursorTint }}
                formatter={(value) => (monthlyMetric === "cost" ? formatMoney(Number(value)) : formatNumber(Number(value)))}
              />
              <Bar dataKey={dataKey} fill={monthlyMetric === "cost" ? "var(--amber)" : "var(--ledger)"} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState text="No monthly rows available." />
        )}
      </section>
      <DataTable
        columns={["Month", "Tokens", "Cost", "Models"]}
        rows={monthlyRows
          .slice()
          .reverse()
          .map((row) => [row.month, formatNumber(row.totalTokens), formatMoney(row.costUSD), row.models.map(compactModelName).join(", ")])}
      />
    </div>
  );
}

function SessionsView({ sessions }: { sessions: SessionPoint[] }) {
  return (
    <div className="single-column">
      <section className="panel">
        <PanelTitle icon={ListChecks} title="Sessions" meta={`${sessions.length} rows`} />
        <SessionsTable sessions={sessions} />
      </section>
    </div>
  );
}

function BlocksView({ blocks }: { blocks: BlockPoint[] }) {
  return (
    <div className="single-column">
      <section className="panel">
        <PanelTitle icon={Clock3} title="5-hour blocks" meta={`${blocks.length} rows`} />
        <TokenTape blocks={blocks} />
        <DataTable
          columns={["Start", "State", "Tokens", "Burn rate", "Projected"]}
          rows={blocks.map((block) => [
            formatDateTime(block.blockStart),
            block.isActive ? `active ${block.timeRemaining}` : "closed",
            formatNumber(block.totalTokens),
            block.burnRate ? `${formatNumber(block.burnRate)}/h` : "-",
            block.projectedTotal ? formatNumber(block.projectedTotal) : "-"
          ])}
        />
      </section>
    </div>
  );
}

function SettingsView({
  usage,
  sourceMode,
  refreshSeconds,
  theme,
  onSourceMode,
  onRefreshSeconds,
  onTheme,
  traySettings,
  traySummary,
  modelOptions,
  onTraySettings
}: {
  usage: NormalizedUsage;
  sourceMode: RequestedSourceMode;
  refreshSeconds: number;
  theme: AppTheme;
  onSourceMode: (mode: RequestedSourceMode) => void;
  onRefreshSeconds: (seconds: number) => void;
  onTheme: (theme: AppTheme) => void;
  traySettings: TrayIndicatorSettings;
  traySummary: ReturnType<typeof buildTrayIndicatorSummary>;
  modelOptions: Array<{ value: string; label: string }>;
  onTraySettings: (settings: TrayIndicatorSettings) => void;
}) {
  const reportRows = usage.collection.reports.map((report) => [
    report.command,
    report.ok ? "ok" : report.classification ?? "failed",
    report.exitCode === undefined || report.exitCode === null ? "-" : String(report.exitCode),
    report.stderr ? report.stderr.slice(0, 140) : "-"
  ]);

  return (
    <div className="settings-grid">
      <section className="panel">
        <PanelTitle icon={HardDrive} title="Runner" meta={usage.collection.effectiveSourceMode} />
        <dl className="detail-list">
          <div>
            <dt>Mode</dt>
            <dd>{sourceLabel(usage.collection.effectiveSourceMode)}</dd>
          </div>
          <div>
            <dt>Runner</dt>
            <dd>{usage.collection.runnerLabel}</dd>
          </div>
          <div>
            <dt>ccusage version</dt>
            <dd>{usage.collection.ccusageVersion ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Detected sources</dt>
            <dd>{usage.sourceNames.length ? usage.sourceNames.join(", ") : "none"}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <PanelTitle icon={Settings} title="Controls" meta="local only" />
        <div className="settings-form">
          <label>
            <span>Data source</span>
            <select value={sourceMode} onChange={(event) => onSourceMode(event.target.value as RequestedSourceMode)}>
              <option value="bundled">Bundled ccusage</option>
              <option value="system">System ccusage</option>
              <option value="mock">Mock</option>
            </select>
          </label>
          <label>
            <span>Refresh interval</span>
            <select value={refreshSeconds} onChange={(event) => onRefreshSeconds(Number(event.target.value))}>
              <option value={0}>Off</option>
              <option value={30}>30 seconds</option>
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes</option>
            </select>
          </label>
          <label>
            <span>Theme</span>
            <select value={theme} onChange={(event) => onTheme(event.target.value as AppTheme)}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel wide">
        <PanelTitle icon={Palette} title="Tray Indicator" meta="advanced bars" />
        <TraySettingsPanel
          settings={traySettings}
          summary={traySummary}
          modelOptions={modelOptions}
          onChange={onTraySettings}
        />
      </section>

      <section className="panel wide">
        <PanelTitle icon={Terminal} title="Command status" meta="daily / monthly / session / blocks" />
        <DataTable columns={["Command", "Status", "Exit", "Stderr"]} rows={reportRows} />
      </section>

      <section className="panel wide">
        <PanelTitle icon={AlertTriangle} title="Diagnostics" meta={`${usage.diagnostics.length} messages`} />
        <DiagnosticsList diagnostics={usage.diagnostics} />
      </section>
    </div>
  );
}

function TraySettingsPanel({
  settings,
  summary,
  modelOptions,
  onChange
}: {
  settings: TrayIndicatorSettings;
  summary: ReturnType<typeof buildTrayIndicatorSummary>;
  modelOptions: Array<{ value: string; label: string }>;
  onChange: (settings: TrayIndicatorSettings) => void;
}) {
  const updateBar = (index: number, patch: Partial<TrayBarSetting>) => {
    const bars = settings.bars.map((bar, barIndex) => (barIndex === index ? { ...bar, ...patch } : bar)) as [
      TrayBarSetting,
      TrayBarSetting
    ];
    onChange({ ...settings, bars });
  };

  return (
    <div className="tray-settings">
      <div className="tray-settings-header">
        <label className="toggle-row">
          <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
          <span>Enable tray indicator</span>
        </label>
        <button className="secondary-command" type="button" onClick={() => onChange(defaultTraySettings)}>
          Reset
        </button>
      </div>

      <div className={summary.bars.length === 1 ? "tray-preview single" : "tray-preview"}>
        <TrayIconPreview enabled={summary.enabled} bars={summary.bars} />
        <div className="tray-preview-copy">
          <strong>{!summary.enabled ? "Tray icon hidden" : summary.bars.length === 1 ? "Single bar icon" : "Two bar icon"}</strong>
          <span>{summary.tooltip}</span>
        </div>
      </div>

      <div className="tray-bar-settings">
        {settings.bars.map((bar, index) => (
          <section className="tray-bar-editor" key={bar.id}>
            <div className="tray-bar-editor-title">
              <label className="toggle-row">
                <input type="checkbox" checked={bar.enabled} onChange={(event) => updateBar(index, { enabled: event.target.checked })} />
                <span>{bar.period === "week" ? "Weekly" : "Monthly"} {bar.budgetType === "cost" ? "cost" : "token"} gauge {index + 1}</span>
              </label>
            </div>

            <div className="tray-editor-grid">
              <label>
                <span>Model</span>
                <select
                  value={bar.target}
                  onChange={(event) => {
                    const target = event.target.value;
                    const patch: Partial<TrayBarSetting> = { target };
                    if (bar.customColor === resolveModelColor(bar.target, index)) {
                      patch.customColor = resolveModelColor(target, index);
                    }
                    updateBar(index, patch);
                  }}
                >
                  {modelOptions.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Budget type</span>
                <select value={bar.budgetType} onChange={(event) => updateBar(index, { budgetType: event.target.value as TrayBarSetting["budgetType"] })}>
                  <option value="tokens">Tokens</option>
                  <option value="cost">USD</option>
                </select>
              </label>

              <label>
                <span>Budget window</span>
                <select value={bar.period} onChange={(event) => updateBar(index, { period: event.target.value as TrayBarSetting["period"] })}>
                  <option value="week">Weekly</option>
                  <option value="month">Monthly</option>
                </select>
              </label>

              <label>
                <span>{bar.period === "week" ? "Weekly" : "Monthly"} budget ({bar.budgetType === "cost" ? "USD" : "tokens"})</span>
                <input
                  type="number"
                  min="0"
                  step={bar.budgetType === "cost" ? "1" : "1000"}
                  value={(bar.period === "week" ? bar.weeklyBudget : bar.monthlyBudget) || ""}
                  placeholder={bar.budgetType === "cost" ? "Relative cost" : "Relative tokens"}
                  onChange={(event) =>
                    updateBar(index, bar.period === "week" ? { weeklyBudget: Number(event.target.value) } : { monthlyBudget: Number(event.target.value) })
                  }
                />
              </label>

              <label className="color-control">
                <span>Color</span>
                <input
                  type="color"
                  value={bar.customColor}
                  onChange={(event) => updateBar(index, { customColor: event.target.value })}
                />
              </label>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function TrayIconPreview({ enabled, bars }: { enabled: boolean; bars: TrayIndicatorBar[] }) {
  if (!enabled) {
    return <div className="tray-icon-preview hidden" aria-label="Tray icon hidden" />;
  }

  if (bars.length === 0) {
    return <div className="tray-icon-preview empty" aria-label="No tray bars enabled" />;
  }

  return (
    <div className={bars.length === 1 ? "tray-icon-preview single" : "tray-icon-preview"} aria-label="Tray icon preview">
      {bars.map((bar) => (
        <div className="mini-gauge" key={bar.id}>
          <span style={{ width: `${Math.round(bar.ratio * 100)}%`, background: bar.color }} />
        </div>
      ))}
    </div>
  );
}

function TrayPanel({
  usage,
  summary,
  loading,
  onRefresh
}: {
  usage: NormalizedUsage;
  summary: ReturnType<typeof buildTrayIndicatorSummary>;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <main className="tray-panel-shell">
      <header className="tray-panel-header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <strong>Usage Deck</strong>
          <span>{sourceLabel(usage.collection.effectiveSourceMode)}</span>
        </div>
        <div className="tray-panel-actions">
          <button className="icon-command compact" onClick={onRefresh} disabled={loading} aria-label="Refresh usage">
            <RefreshCw className={loading ? "spin" : ""} />
          </button>
          <button
            className="icon-command compact"
            onClick={() => void invoke("hide_tray_panel").catch(() => undefined)}
            aria-label="Close quick panel"
          >
            <X />
          </button>
        </div>
      </header>

      <section className="tray-panel-bars">
        {summary.bars.length > 0 ? (
          summary.bars.map((bar) => <TrayPanelBar bar={bar} key={bar.id} />)
        ) : (
          <EmptyState text="No tray bars enabled." />
        )}
      </section>

      <footer className="tray-panel-footer">
        <button className="secondary-command" type="button" onClick={() => void invoke("show_dashboard").catch(() => undefined)}>
          Open Dashboard
        </button>
      </footer>
    </main>
  );
}

function TrayPanelBar({ bar }: { bar: TrayIndicatorBar }) {
  return (
    <div className="tray-panel-bar">
      <div>
        <strong>{bar.label}</strong>
        <span>{bar.period === "week" ? "Weekly" : "Monthly"}</span>
      </div>
      <div className="tray-panel-meter">
        <span style={{ width: `${Math.round(bar.ratio * 100)}%`, background: bar.color }} />
      </div>
      <div>
        <span>{formatTrayUsed(bar)}</span>
        <span>{formatTrayBudget(bar)}</span>
        <span>{bar.budgetType === "cost" ? `${formatNumber(bar.usedTokens)} tokens` : formatMoney(bar.costUSD)}</span>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="metric-card">
      <div className="metric-icon">
        <Icon />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

function PanelTitle({ icon: Icon, title, meta }: { icon: typeof Activity; title: string; meta?: string }) {
  return (
    <div className="panel-title">
      <div>
        <Icon />
        <h3>{title}</h3>
      </div>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function trendMetricDataKey(metric: TrendMetric): "totalTokens" | "costUSD" {
  return metric === "cost" ? "costUSD" : "totalTokens";
}

function trendMetricValue(row: { totalTokens: number; costUSD: number }, metric: TrendMetric): number {
  return metric === "cost" ? row.costUSD : row.totalTokens;
}

function DailyChart({
  data,
  series,
  metric,
  tall = false
}: {
  data: UsageTrendPoint[];
  series: TrendSeries[];
  metric: TrendMetric;
  tall?: boolean;
}) {
  const height = tall ? 320 : 260;
  const dataKey = trendMetricDataKey(metric);
  const totalSeries = series.length <= 1 && series[0]?.key === dataKey;
  const chartColor = metric === "cost" ? "var(--amber)" : "var(--ledger)";
  const fillId = metric === "cost" ? "costFill" : "tokenFill";

  if (!totalSeries) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={18} />
          <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => shortTrendValue(metric, Number(value))} />
          <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [formatTrendValue(metric, Number(value)), name]} />
          <Legend wrapperStyle={{ color: "var(--muted)", fontSize: 12 }} />
          {series.map((item) => (
            <Line
              activeDot={{ r: 4 }}
              dataKey={item.key}
              dot={{ r: 2 }}
              key={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColor} stopOpacity={0.55} />
            <stop offset="95%" stopColor={chartColor} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={18} />
        <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => shortTrendValue(metric, Number(value))} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTrendValue(metric, Number(value))} />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={chartColor}
          fill={`url(#${fillId})`}
          strokeWidth={2}
          dot={{ r: 3, fill: chartColor }}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function buildTrendRows(
  usage: NormalizedUsage,
  mode: PeriodMode,
  range: DateRange,
  displayMode: TrendDisplayMode,
  selectedTargets: TrendModelTarget[],
  catalog: TrendModelFilterCatalog,
  metric: TrendMetric
): TrendResult {
  const buckets = buildTrendBuckets(usage, mode, range);
  const series = buildTrendSeries(displayMode, selectedTargets, catalog, metric);
  const rows = buckets.map((bucket) => buildTrendPoint(bucket, displayMode, selectedTargets, series, metric));

  return {
    rows,
    series,
    hasData: series.length > 0 && rows.some((row) => trendMetricValue(row, metric) > 0)
  };
}

function buildTrendBuckets(usage: NormalizedUsage, mode: PeriodMode, range: DateRange): TrendBucket[] {
  if (mode === "12hrs") {
    return buildRecentHourlyTrendBuckets(usage.sessions, range);
  }

  if (mode === "day") {
    const hourlyBuckets = buildHourlyTrendBuckets(usage.sessions, range.start);
    if (hourlyBuckets.some((bucket) => bucket.rows.length > 0)) {
      return hourlyBuckets;
    }
  }

  return filterUsageByRange(usage.daily, range).map((row) => ({
    date: row.date,
    rows: [row]
  }));
}

function buildRecentHourlyTrendBuckets(sessions: SessionPoint[], range: DateRange): TrendBucket[] {
  const end = parseActivityDate(range.endDateTime ?? "") ?? new Date();
  const start = parseActivityDate(range.startDateTime ?? "") ?? new Date(end.getTime() - 12 * 60 * 60 * 1000);
  const bucketStart = startOfHour(start);
  const bucketEnd = startOfHour(end);
  const bucketCount = Math.max(1, Math.floor((bucketEnd.getTime() - bucketStart.getTime()) / 3_600_000) + 1);
  const rows = Array.from({ length: bucketCount }, (_, index) => {
    const bucketDate = new Date(bucketStart.getTime() + index * 3_600_000);
    return {
      date: formatHourBucket(bucketDate),
      rows: [] as TrendUsageRow[],
      sessionCount: 0
    };
  });

  for (const session of sessions) {
    const activityDate = parseActivityDate(session.lastActivity || session.firstActivity);
    if (!activityDate || activityDate < start || activityDate > end) {
      continue;
    }

    const bucketIndex = Math.floor((startOfHour(activityDate).getTime() - bucketStart.getTime()) / 3_600_000);
    const row = rows[bucketIndex];
    if (!row) {
      continue;
    }

    row.rows.push(session);
    row.sessionCount = (row.sessionCount ?? 0) + 1;
  }

  return rows;
}

function buildHourlyTrendBuckets(sessions: SessionPoint[], dateKey: string): TrendBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    date: `${String(hour).padStart(2, "0")}:00`,
    rows: [] as TrendUsageRow[],
    sessionCount: 0
  }));

  for (const session of sessions) {
    const activityDate = parseActivityDate(session.lastActivity || session.firstActivity);
    if (!activityDate || toDateKey(activityDate) !== dateKey) {
      continue;
    }

    const hour = activityDate.getHours();
    buckets[hour].rows.push(session);
    buckets[hour].sessionCount = (buckets[hour].sessionCount ?? 0) + 1;
  }

  return buckets;
}

function buildTrendPoint(
  bucket: TrendBucket,
  displayMode: TrendDisplayMode,
  selectedTargets: TrendModelTarget[],
  series: TrendSeries[],
  metric: TrendMetric
): UsageTrendPoint {
  const point: UsageTrendPoint = {
    date: bucket.date,
    totalTokens: 0,
    costUSD: 0,
    models: [],
    sessionCount: bucket.sessionCount
  };
  const modelSet = new Set<string>();
  const seriesLookup = new Map(series.map((item) => [item.target, item]));

  for (const item of series) {
    point[item.key] = 0;
  }

  for (const row of bucket.rows) {
    for (const breakdown of breakdownsForTrendRow(row)) {
      if (!matchesSelectedTrendTargets(breakdown.model, selectedTargets)) {
        continue;
      }

      point.totalTokens += breakdown.totalTokens;
      point.costUSD += breakdown.costUSD;
      modelSet.add(breakdown.model);
      const trendValue = trendMetricValue(breakdown, metric);

      if (displayMode === "model") {
        const modelSeries = seriesLookup.get(breakdown.model);
        if (modelSeries) {
          point[modelSeries.key] = Number(point[modelSeries.key] ?? 0) + trendValue;
        }
      } else if (displayMode === "family") {
        const familySeries = seriesLookup.get(familyTargetForModel(breakdown.model));
        if (familySeries) {
          point[familySeries.key] = Number(point[familySeries.key] ?? 0) + trendValue;
        }
      }
    }
  }

  if (displayMode === "total" && series[0]) {
    point[series[0].key] = trendMetricValue(point, metric);
  }

  point.models = [...modelSet];
  return point;
}

function buildTrendModelFilterCatalog(usage: NormalizedUsage): TrendModelFilterCatalog {
  const totals = new Map<string, number>();
  const rows: TrendUsageRow[] = [...usage.daily, ...usage.monthly, ...usage.sessions, ...usage.blocks];

  for (const row of rows) {
    for (const breakdown of breakdownsForTrendRow(row)) {
      totals.set(breakdown.model, (totals.get(breakdown.model) ?? 0) + breakdown.totalTokens);
    }
  }

  const detectedModels = [...totals.entries()]
    .filter(([model]) => model !== "unknown")
    .sort((left, right) => right[1] - left[1])
    .map(([model, totalTokens]) => ({
      value: model,
      label: compactModelName(model),
      detected: true,
      totalTokens
    }));
  const detectedKeys = new Set(detectedModels.map((model) => model.value.toLowerCase()));
  const candidateModels = knownModelCandidates
    .filter((model) => !detectedKeys.has(model.toLowerCase()))
    .map((model) => ({
      value: model,
      label: compactModelName(model),
      detected: false,
      totalTokens: 0
    }));
  const familyOptions = familyTargets.map((family) => {
    const totalTokens = [...totals.entries()].reduce(
      (total, [model, tokens]) => (familyTargetForModel(model) === family.value ? total + tokens : total),
      0
    );
    return {
      value: family.value,
      label: family.label,
      detected: totalTokens > 0,
      totalTokens
    };
  });

  return {
    familyOptions,
    modelOptions: [...detectedModels, ...candidateModels],
    detectedModelValues: detectedModels.map((model) => model.value)
  };
}

function buildTrendSeries(
  displayMode: TrendDisplayMode,
  selectedTargets: TrendModelTarget[],
  catalog: TrendModelFilterCatalog,
  metric: TrendMetric
): TrendSeries[] {
  if (selectedTargets.length === 0) {
    return [];
  }

  if (displayMode === "total") {
    return [
      {
        key: trendMetricDataKey(metric),
        label: metric === "cost" ? "Total cost" : "Total tokens",
        color: metric === "cost" ? "var(--amber)" : "var(--ledger)",
        target: "all"
      }
    ];
  }

  if (displayMode === "model") {
    return expandSelectedModels(selectedTargets, catalog).map((model) => ({
      key: trendSeriesKey(model),
      label: compactModelName(model),
      color: trendModelColor(model, catalog),
      target: model
    }));
  }

  return expandSelectedFamilies(selectedTargets, catalog).map((family, index) => ({
    key: trendSeriesKey(family),
    label: trendFamilyLabel(family),
    color: trendTargetColor(family, index),
    target: family
  }));
}

function expandSelectedModels(selectedTargets: TrendModelTarget[], catalog: TrendModelFilterCatalog): string[] {
  if (selectedTargets.includes("all")) {
    return catalog.detectedModelValues;
  }

  const models = new Set<string>();
  const catalogModels = catalog.modelOptions.map((option) => option.value);
  for (const target of selectedTargets) {
    if (isFamilyTarget(target)) {
      catalog.detectedModelValues
        .filter((model) => familyTargetForModel(model) === target)
        .forEach((model) => models.add(model));
      continue;
    }
    if (catalogModels.some((model) => model.toLowerCase() === target.toLowerCase())) {
      models.add(target);
    }
  }
  return [...models];
}

function expandSelectedFamilies(selectedTargets: TrendModelTarget[], catalog: TrendModelFilterCatalog): TrendFamilyTarget[] {
  if (selectedTargets.includes("all")) {
    return catalog.familyOptions.filter((option) => option.detected).map((option) => option.value as TrendFamilyTarget);
  }

  const families = new Set<TrendFamilyTarget>();
  for (const target of selectedTargets) {
    if (isFamilyTarget(target)) {
      families.add(target);
    }
  }
  return [...families].sort((left, right) => familyOrder(left) - familyOrder(right));
}

function breakdownsForTrendRow(row: TrendUsageRow): ModelUsage[] {
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

function matchesSelectedTrendTargets(model: string, selectedTargets: TrendModelTarget[]): boolean {
  if (selectedTargets.includes("all")) {
    return true;
  }
  if (selectedTargets.length === 0) {
    return false;
  }

  const lower = model.toLowerCase();
  return selectedTargets.some((target) => {
    if (isFamilyTarget(target)) {
      return familyTargetForModel(model) === target;
    }
    return lower === target.toLowerCase();
  });
}

function familyTargetForModel(model: string): TrendFamilyTarget {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku")) {
    return "family:claude";
  }
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("codex") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("o4")
  ) {
    return "family:gpt";
  }
  if (lower.includes("gemini")) {
    return "family:gemini";
  }
  return "family:other";
}

function isFamilyTarget(target: TrendModelTarget): target is TrendFamilyTarget {
  return target.startsWith("family:");
}

function trendFamilyLabel(target: TrendFamilyTarget): string {
  return familyTargets.find((family) => family.value === target)?.label ?? "Other / unknown";
}

function trendTargetColor(target: TrendModelTarget, index = 0): string {
  if (target === "family:other") {
    return "#B7A36F";
  }
  return resolveModelColor(target, index);
}

function trendModelColor(model: string, catalog: TrendModelFilterCatalog): string {
  const variants = trendFamilyColorVariants(familyTargetForModel(model));
  return variants[trendModelVariantIndex(model, catalog) % variants.length];
}

function trendFamilyColorVariants(target: TrendFamilyTarget): string[] {
  switch (target) {
    case "family:gpt":
      return ["#8AB4FF", "#2F73E6", "#C9DDFF", "#0F55B7", "#78A8FF", "#EAF2FF"];
    case "family:claude":
      return ["#D98B4E", "#9B4F25", "#F5BE86", "#6F3519", "#FF9E4F", "#F8DDC5"];
    case "family:gemini":
      return ["#3DDC84", "#149E55", "#9AF2C1", "#08763D", "#63E6A0", "#D6FFE6"];
    case "family:other":
      return ["#B7A36F", "#7D6D39", "#DDCB91", "#4E4526", "#C9B15F", "#EFE5BD"];
  }
}

function trendModelVariantIndex(model: string, catalog: TrendModelFilterCatalog): number {
  const family = familyTargetForModel(model);
  const familyModels = catalog.modelOptions
    .map((option) => option.value)
    .filter((candidate) => familyTargetForModel(candidate) === family)
    .sort((left, right) => compactModelName(left).localeCompare(compactModelName(right)));
  const modelIndex = familyModels.indexOf(model);
  return modelIndex >= 0 ? modelIndex : 0;
}

function trendSeriesKey(target: TrendModelTarget): string {
  return `series_${target.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function familyOrder(target: TrendFamilyTarget): number {
  return familyTargets.findIndex((family) => family.value === target);
}

function parseActivityDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfHour(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
}

function formatHourBucket(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function hasHourlyUsage(rows: UsageTrendPoint[]): boolean {
  return rows.some((row) => (row.sessionCount ?? 0) > 0);
}

function isHourlyTrendMode(mode: PeriodMode): boolean {
  return mode === "12hrs" || mode === "day";
}

function TokenTape({ blocks }: { blocks: BlockPoint[] }) {
  const max = Math.max(...blocks.map((block) => block.totalTokens), 1);

  if (blocks.length === 0) {
    return <EmptyState text="No block rows available." />;
  }

  return (
    <div className="token-tape" aria-label="Recent token blocks">
      {blocks.slice(0, 10).map((block) => (
        <div className={block.isActive ? "tape-segment active" : "tape-segment"} key={block.blockStart}>
          <span style={{ width: `${Math.max(8, (block.totalTokens / max) * 100)}%` }} />
          <div>
            <strong>{formatNumber(block.totalTokens)}</strong>
            <small>{block.isActive ? `active ${block.timeRemaining}` : formatDateTime(block.blockStart)}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionsTable({ sessions, compact = false }: { sessions: SessionPoint[]; compact?: boolean }) {
  if (sessions.length === 0) {
    return <EmptyState text="No session rows available." />;
  }

  return (
    <DataTable
      columns={["Session", "Last activity", "Tokens", "Cost", "Models"]}
      className={compact ? "sessions-table compact" : "sessions-table"}
      rows={sessions.map((session) => [
        session.session,
        formatDateTime(session.lastActivity),
        formatNumber(session.totalTokens),
        formatMoney(session.costUSD),
        session.models.map(compactModelName).join(", ")
      ])}
    />
  );
}

function DataTable({ columns, rows, className }: { columns: string[]; rows: string[][]; className?: string }) {
  if (rows.length === 0) {
    return <EmptyState text="No rows available." />;
  }

  return (
    <div className={className ? `table-wrap ${className}` : "table-wrap"}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.join("-")}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`} title={cell || "-"}>
                  <span className="table-cell-text">{cell || "-"}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosticBanner({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <div className="diagnostic-banner">
      <AlertTriangle />
      <div>
        <strong>{diagnostics.length} runner issue{diagnostics.length === 1 ? "" : "s"}</strong>
        <span>{diagnostics[0]?.message}</span>
      </div>
    </div>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <div className="empty-state success">
        <CheckCircle2 />
        <span>No diagnostics.</span>
      </div>
    );
  }

  return (
    <div className="diagnostics-list">
      {diagnostics.map((diagnostic, index) => (
        <div className={`diagnostic-row ${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}>
          <strong>{diagnostic.code}</strong>
          <span>{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Database />
      <span>{text}</span>
    </div>
  );
}

function buildOverviewUsageScope(usage: NormalizedUsage, selectedTargets: TrendModelTarget[]): OverviewUsageScope {
  if (selectedTargets.includes("all")) {
    return {
      activeBlock: usage.activeBlock,
      blocks: usage.blocks,
      modelUsage: usage.modelUsage,
      sessions: usage.sessions
    };
  }

  return {
    activeBlock: usage.activeBlock ? filterUsageRowByTargets(usage.activeBlock, selectedTargets) ?? undefined : undefined,
    blocks: filterUsageRowsByTargets(usage.blocks, selectedTargets),
    modelUsage: buildSelectedModelUsage(usage, selectedTargets),
    sessions: filterUsageRowsByTargets(usage.sessions, selectedTargets)
  };
}

function summarizeSelectedUsage(rows: TrendUsageRow[], selectedTargets: TrendModelTarget[]): UsageSummary {
  if (selectedTargets.includes("all")) {
    return summarizeUsage(rows);
  }

  return rows.reduce<UsageSummary>(
    (summary, row) => {
      for (const breakdown of breakdownsForTrendRow(row)) {
        if (!matchesSelectedTrendTargets(breakdown.model, selectedTargets)) {
          continue;
        }
        summary.totalTokens += breakdown.totalTokens;
        summary.costUSD += breakdown.costUSD;
      }
      return summary;
    },
    { totalTokens: 0, costUSD: 0 }
  );
}

function filterUsageRowsByTargets<T extends TrendUsageRow>(rows: T[], selectedTargets: TrendModelTarget[]): T[] {
  if (selectedTargets.includes("all")) {
    return rows;
  }

  return rows.flatMap((row) => {
    const filtered = filterUsageRowByTargets(row, selectedTargets);
    return filtered ? [filtered] : [];
  });
}

function filterUsageRowByTargets<T extends TrendUsageRow>(row: T, selectedTargets: TrendModelTarget[]): T | null {
  if (selectedTargets.includes("all")) {
    return row;
  }

  const modelBreakdowns = breakdownsForTrendRow(row).filter((breakdown) => matchesSelectedTrendTargets(breakdown.model, selectedTargets));
  if (modelBreakdowns.length === 0) {
    return null;
  }

  return {
    ...row,
    totalTokens: modelBreakdowns.reduce((total, breakdown) => total + breakdown.totalTokens, 0),
    costUSD: modelBreakdowns.reduce((total, breakdown) => total + breakdown.costUSD, 0),
    models: uniqueModels(modelBreakdowns.map((breakdown) => breakdown.model)),
    modelBreakdowns
  };
}

function buildSelectedModelUsage(usage: NormalizedUsage, selectedTargets: TrendModelTarget[]): ModelUsage[] {
  if (selectedTargets.includes("all")) {
    return usage.modelUsage;
  }

  const modelUsage = new Map<string, ModelUsage>();
  for (const row of modelUsageSourceRows(usage)) {
    for (const breakdown of breakdownsForTrendRow(row)) {
      if (!matchesSelectedTrendTargets(breakdown.model, selectedTargets)) {
        continue;
      }
      const existing = modelUsage.get(breakdown.model) ?? { model: breakdown.model, totalTokens: 0, costUSD: 0 };
      existing.totalTokens += breakdown.totalTokens;
      existing.costUSD += breakdown.costUSD;
      modelUsage.set(breakdown.model, existing);
    }
  }

  return [...modelUsage.values()].sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 8);
}

function modelUsageSourceRows(usage: NormalizedUsage): TrendUsageRow[] {
  if (usage.daily.length > 0) {
    return usage.daily;
  }
  if (usage.monthly.length > 0) {
    return usage.monthly;
  }
  if (usage.sessions.length > 0) {
    return usage.sessions;
  }
  return usage.blocks;
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models)];
}

function formatModelMixMeta(count: number, selectedTargets: TrendModelTarget[]): string {
  const noun = count === 1 ? "model" : "models";
  return selectedTargets.includes("all") ? `${count} ${noun}` : `${count} selected ${noun}`;
}

function summarizeMonthUsage(usage: NormalizedUsage, range: DateRange, selectedTargets: TrendModelTarget[]): UsageSummary {
  const dailyRows = filterUsageByRange(usage.daily, range);
  if (dailyRows.length > 0) {
    return summarizeSelectedUsage(dailyRows, selectedTargets);
  }

  const month = usage.monthly.find((point) => point.month === range.start.slice(0, 7));
  return month ? summarizeSelectedUsage([month], selectedTargets) : { totalTokens: 0, costUSD: 0 };
}

function metricDetail(summary: UsageSummary, range: DateRange, mode: PeriodMode): string {
  const periodLabel = mode === "week" ? formatDateRangeWithoutYear(range) : formatPeriodMeta(mode, range);
  return `${formatNumber(summary.totalTokens)} tokens - ${periodLabel}`;
}

function formatTrendMeta(mode: PeriodMode, range: DateRange): string {
  return `${formatTrendModeLabel(mode)} · ${formatPeriodMeta(mode, range)}`;
}

function formatTrendModeLabel(mode: PeriodMode): string {
  switch (mode) {
    case "12hrs":
      return "12Hrs";
    case "day":
      return "Day";
    case "week":
      return "Week";
    case "month":
      return "Monthly";
    case "custom":
      return "Custom";
  }
}

function formatPeriodMeta(mode: PeriodMode, range: DateRange): string {
  const normalized = normalizeDateRange(range);
  switch (mode) {
    case "12hrs":
      return formatDateTimeRange(normalized);
    case "day":
      return formatDateKey(normalized.start);
    case "month":
      return formatMonthLabel(normalized.start);
    case "week":
    case "custom":
      return formatDateRange(normalized);
  }
}

function formatDateTimeRange(range: DateRange): string {
  const start = parseActivityDate(range.startDateTime ?? "");
  const end = parseActivityDate(range.endDateTime ?? "");
  if (!start || !end) {
    return formatDateRange(range);
  }

  const startLabel = start.toLocaleDateString([], { month: "short", day: "numeric" });
  const startTime = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const endTime = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (toDateKey(start) === toDateKey(end)) {
    return `${startLabel} ${startTime} - ${endTime}`;
  }

  const endLabel = end.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${startLabel} ${startTime} - ${endLabel} ${endTime}`;
}

function formatDateRange(range: DateRange): string {
  if (range.start === range.end) {
    return formatDateKey(range.start);
  }

  const start = parseDateKey(range.start);
  const end = parseDateKey(range.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${range.start} - ${range.end}`;
  }

  const sameYear = start.getFullYear() === end.getFullYear();
  const startLabel = start.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  const endLabel = end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} - ${endLabel}`;
}

function formatDateRangeWithoutYear(range: DateRange): string {
  if (range.start === range.end) {
    const date = parseDateKey(range.start);
    return Number.isNaN(date.getTime()) ? range.start || "-" : date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const start = parseDateKey(range.start);
  const end = parseDateKey(range.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${range.start} - ${range.end}`;
  }

  return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} - ${end.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function formatDateKey(value: string): string {
  const date = parseDateKey(value);
  if (Number.isNaN(date.getTime())) {
    return value || "-";
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatMonthLabel(value: string): string {
  const date = parseDateKey(`${value.slice(0, 7)}-01`);
  if (Number.isNaN(date.getTime())) {
    return value || "-";
  }
  return date.toLocaleDateString([], { month: "short", year: "numeric" });
}

function pageTitle(view: ViewKey): string {
  switch (view) {
    case "daily":
      return "Usage Trend";
    case "monthly":
      return "Monthly Rollup";
    case "sessions":
      return "Session Ledger";
    case "blocks":
      return "Block Monitor";
    case "settings":
      return "Runner Settings";
    default:
      return "Overview";
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "bundled":
      return "Bundled ccusage";
    case "system":
      return "System ccusage";
    case "mock":
      return "Mock feed";
    default:
      return "Unavailable";
  }
}

function loadTheme(): AppTheme {
  if (typeof window === "undefined") {
    return "system";
  }

  const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return theme === "dark" || theme === "light" || theme === "system" ? theme : "system";
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

function loadTrendPreferences(): TrendPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_TREND_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(TREND_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_TREND_PREFERENCES;
    }
    return normalizeTrendPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_TREND_PREFERENCES;
  }
}

function saveTrendPreferences(preferences: TrendPreferences) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(TREND_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizeTrendPreferences(preferences)));
  } catch {
    // Local persistence is a convenience layer; the dashboard should continue without it.
  }
}

function normalizeTrendPreferences(input: unknown): TrendPreferences {
  const record = input && typeof input === "object" ? (input as Partial<TrendPreferences>) : {};
  const displayMode = isTrendDisplayMode(record.displayMode) ? record.displayMode : DEFAULT_TREND_PREFERENCES.displayMode;
  const selectedTargets = Array.isArray(record.selectedTargets)
    ? record.selectedTargets.filter((target): target is TrendModelTarget => typeof target === "string" && target.trim().length > 0)
    : DEFAULT_TREND_PREFERENCES.selectedTargets;

  return {
    metric: isTrendMetric(record.metric) ? record.metric : DEFAULT_TREND_PREFERENCES.metric,
    displayMode,
    selectedTargets: displayMode === "total" ? ["all"] : selectedTargets,
    periodMode: isPeriodMode(record.periodMode) ? record.periodMode : DEFAULT_TREND_PREFERENCES.periodMode,
    customRange: normalizeStoredDateRange(record.customRange)
  };
}

function isTrendMetric(value: unknown): value is TrendMetric {
  return value === "tokens" || value === "cost";
}

function isTrendDisplayMode(value: unknown): value is TrendDisplayMode {
  return value === "total" || value === "model" || value === "family";
}

function isPeriodMode(value: unknown): value is PeriodMode {
  return value === "12hrs" || value === "day" || value === "week" || value === "month" || value === "custom";
}

function normalizeStoredDateRange(value: unknown): DateRange {
  if (!value || typeof value !== "object") {
    return DEFAULT_TREND_PREFERENCES.customRange;
  }

  const range = value as Partial<DateRange>;
  if (!isDateKeyString(range.start) || !isDateKeyString(range.end)) {
    return DEFAULT_TREND_PREFERENCES.customRange;
  }

  return normalizeDateRange({ start: range.start, end: range.end });
}

function isDateKeyString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sameTraySettings(left: TrayIndicatorSettings, right: TrayIndicatorSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeImmediateTraySettings(current: TrayIndicatorSettings, debounced: TrayIndicatorSettings): TrayIndicatorSettings {
  if (sameTraySettingsExceptColors(current, debounced)) {
    return debounced;
  }

  return {
    ...current,
    bars: current.bars.map((bar, index) => ({
      ...bar,
      customColor: debounced.bars[index]?.customColor ?? bar.customColor
    })) as [TrayBarSetting, TrayBarSetting]
  };
}

function sameTraySettingsExceptColors(left: TrayIndicatorSettings, right: TrayIndicatorSettings): boolean {
  if (left.enabled !== right.enabled || left.bars.length !== right.bars.length) {
    return false;
  }

  return left.bars.every((bar, index) => {
    const other = right.bars[index];
    return (
      Boolean(other) &&
      bar.id === other.id &&
      bar.enabled === other.enabled &&
      bar.target === other.target &&
      bar.period === other.period &&
      bar.budgetType === other.budgetType &&
      bar.weeklyBudget === other.weeklyBudget &&
      bar.monthlyBudget === other.monthlyBudget
    );
  });
}

function resolveSystemTheme(): ResolvedAppTheme {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }

  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "dark" : "light";
}

function formatCcusageVersion(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) {
    return "ccusage unknown";
  }
  return value.toLowerCase().startsWith("ccusage") ? value : `ccusage ${value}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function shortNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

function shortMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatTrendMetricLabel(metric: TrendMetric): string {
  return metric === "cost" ? "Cost" : "Token";
}

function formatTrendValue(metric: TrendMetric, value: number): string {
  return metric === "cost" ? formatMoney(value) : formatNumber(value);
}

function shortTrendValue(metric: TrendMetric, value: number): string {
  return metric === "cost" ? shortMoney(value) : shortNumber(value);
}

function formatTrayUsed(bar: TrayIndicatorBar): string {
  if (bar.budgetType === "cost") {
    return formatMoney(bar.costUSD);
  }
  return `${formatNumber(bar.usedTokens)} tokens`;
}

function formatTrayBudget(bar: TrayIndicatorBar): string {
  if (bar.budgetSource !== "configured") {
    return bar.budgetType === "cost" ? "relative cost scale" : "relative token scale";
  }
  if (bar.budgetType === "cost") {
    return `${formatMoney(bar.budgetValue)} budget`;
  }
  return `${formatNumber(bar.budgetValue)} token budget`;
}

function formatDateTime(value: string): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compactModelName(model: string): string {
  return model
    .replace("claude-", "claude ")
    .replace("gpt-", "gpt ")
    .replace("gemini-", "gemini ")
    .replace("-20250929", "")
    .replace("-20250805", "");
}

const tooltipStyle = {
  background: "var(--tooltip-bg)",
  border: "1px solid var(--tooltip-border)",
  borderRadius: 6,
  color: "var(--tooltip-text)"
};
