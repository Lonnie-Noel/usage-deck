import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  Zap
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
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

type UsageTrendPoint = {
  date: string;
  totalTokens: number;
  costUSD: number;
  models: string[];
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

const THEME_STORAGE_KEY = "usage-deck.theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

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
  const [dailyPeriodMode, setDailyPeriodMode] = useState<PeriodMode>("month");
  const [customDateRange, setCustomDateRange] = useState<DateRange>(() => getPresetRange("month"));
  const [usage, setUsage] = useState<NormalizedUsage>(() =>
    normalizeUsage(createMockCollection("Initial dashboard preview."))
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
    if (!traySettingsReady) {
      return;
    }

    saveTraySettings(traySettings);
    if (window.__TAURI_INTERNALS__) {
      void invoke("save_tray_settings", { settings: traySettings }).catch(() => undefined);
    }
  }, [traySettings, traySettingsReady]);

  const traySummary = useMemo(() => buildTrayIndicatorSummary(traySettings, usage), [traySettings, usage]);
  const modelOptions = useMemo(() => buildModelOptions(usage), [usage]);
  const activeDailyRange = useMemo(
    () =>
      dailyPeriodMode === "custom"
        ? normalizeDateRange(customDateRange)
        : getPresetRange(dailyPeriodMode, lastRefresh ?? new Date()),
    [customDateRange, dailyPeriodMode, lastRefresh]
  );
  const activeDailyRows = useMemo(() => filterUsageByRange(usage.daily, activeDailyRange), [activeDailyRange, usage.daily]);
  const activeTrendRows = useMemo(
    () => buildTrendRows(usage, dailyPeriodMode, activeDailyRange),
    [activeDailyRange, dailyPeriodMode, usage]
  );

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !traySettingsReady) {
      return;
    }
    void invoke("update_tray_indicator", { summary: traySummary }).catch(() => undefined);
  }, [traySettingsReady, traySummary]);

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
            <span>local meter</span>
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
            <Overview usage={usage} trendRows={activeTrendRows} trendMode={dailyPeriodMode} trendRange={activeDailyRange} />
          ) : null}
          {activeView === "daily" ? (
            <DailyView
              rows={activeDailyRows}
              trendRows={activeTrendRows}
              periodMode={dailyPeriodMode}
              activeRange={activeDailyRange}
              customRange={customDateRange}
              onPeriodMode={setDailyPeriodMode}
              onCustomRange={setCustomDateRange}
            />
          ) : null}
          {activeView === "monthly" ? <MonthlyView usage={usage} /> : null}
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
  trendRows,
  trendMode,
  trendRange
}: {
  usage: NormalizedUsage;
  trendRows: UsageTrendPoint[];
  trendMode: PeriodMode;
  trendRange: DateRange;
}) {
  const todayRange = getDayRange();
  const weekRange = getWeekRange();
  const monthRange = getMonthRange();
  const todaySummary = summarizeUsage(filterUsageByRange(usage.daily, todayRange));
  const weekSummary = summarizeUsage(filterUsageByRange(usage.daily, weekRange));
  const monthSummary = summarizeMonthUsage(usage, monthRange);

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
        value={usage.activeBlock ? formatNumber(usage.activeBlock.totalTokens) : "idle"}
        detail={usage.activeBlock?.timeRemaining || "no active 5-hour block"}
      />

      <section className="panel trend-panel">
        <PanelTitle icon={CalendarDays} title="Token trend" meta={formatTrendMeta(trendMode, trendRange)} />
        {trendRows.length > 0 ? <DailyChart data={trendRows} /> : <EmptyState text="No usage rows were returned." />}
      </section>

      <section className="panel model-panel">
        <PanelTitle icon={Database} title="Model mix" meta={`${usage.modelUsage.length} models`} />
        {usage.modelUsage.length > 0 ? (
          <div className="model-list">
            {usage.modelUsage.map((item) => (
              <div className="model-row" key={item.model}>
                <div className="model-row-heading">
                  <strong>{compactModelName(item.model)}</strong>
                  <span className="model-cost">{formatMoney(item.costUSD)}</span>
                </div>
                <meter value={item.totalTokens} max={usage.modelUsage[0]?.totalTokens || 1} />
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
        <TokenTape blocks={usage.blocks} />
      </section>

      <section className="panel sessions-panel">
        <PanelTitle icon={ListChecks} title="Recent sessions" meta={`${usage.sessions.length} sessions`} />
        <SessionsTable sessions={usage.sessions.slice(0, 6)} compact />
      </section>
    </div>
  );
}

function DailyView({
  rows,
  trendRows,
  periodMode,
  activeRange,
  customRange,
  onPeriodMode,
  onCustomRange
}: {
  rows: NormalizedUsage["daily"];
  trendRows: UsageTrendPoint[];
  periodMode: PeriodMode;
  activeRange: DateRange;
  customRange: DateRange;
  onPeriodMode: (mode: PeriodMode) => void;
  onCustomRange: (range: DateRange) => void;
}) {
  const showHourlyRows = isHourlyTrendMode(periodMode);
  const hourlyMeta = periodMode === "12hrs" ? "12 hours" : "24 hours";

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
        {trendRows.length > 0 ? <DailyChart data={trendRows} tall /> : <EmptyState text="No usage rows available for this period." />}
      </section>
      {showHourlyRows ? (
        <DataTable
          columns={["Hour", "Tokens", "Cost", "Sessions"]}
          rows={trendRows
            .filter((row) => row.totalTokens > 0)
            .slice()
            .reverse()
            .map((row) => [row.date, formatNumber(row.totalTokens), formatMoney(row.costUSD), String(row.sessionCount ?? 0)])}
        />
      ) : (
        <DataTable
          columns={["Date", "Tokens", "Cost", "Models"]}
          rows={rows
            .slice()
            .reverse()
            .map((row) => [row.date, formatNumber(row.totalTokens), formatMoney(row.costUSD), row.models.map(compactModelName).join(", ")])}
        />
      )}
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

function MonthlyView({ usage }: { usage: NormalizedUsage }) {
  return (
    <div className="single-column">
      <section className="panel tall-panel">
        <PanelTitle icon={BarChart3} title="Monthly cost" meta={`${usage.monthly.length} rows`} />
        {usage.monthly.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={usage.monthly}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="costUSD" fill="var(--amber)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState text="No monthly rows available." />
        )}
      </section>
      <DataTable
        columns={["Month", "Tokens", "Cost", "Models"]}
        rows={usage.monthly
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
      <header className="tray-panel-header">
        <div>
          <strong>Usage Deck</strong>
          <span>{sourceLabel(usage.collection.effectiveSourceMode)}</span>
        </div>
        <button className="icon-command compact" onClick={onRefresh} disabled={loading} aria-label="Refresh usage">
          <RefreshCw className={loading ? "spin" : ""} />
        </button>
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

function DailyChart({ data, tall = false }: { data: UsageTrendPoint[]; tall?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={tall ? 320 : 260}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--ledger)" stopOpacity={0.55} />
            <stop offset="95%" stopColor="var(--ledger)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={18} />
        <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={shortNumber} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatNumber(Number(value))} />
        <Area
          type="monotone"
          dataKey="totalTokens"
          stroke="var(--ledger)"
          fill="url(#tokenFill)"
          strokeWidth={2}
          dot={{ r: 3, fill: "var(--ledger)" }}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function buildTrendRows(usage: NormalizedUsage, mode: PeriodMode, range: DateRange): UsageTrendPoint[] {
  if (mode === "12hrs") {
    return buildRecentHourlyTrendRows(usage.sessions, range);
  }

  if (mode === "day") {
    const hourlyRows = buildHourlyTrendRows(usage.sessions, range.start);
    if (hasHourlyUsage(hourlyRows)) {
      return hourlyRows;
    }
  }

  return filterUsageByRange(usage.daily, range).map(toTrendPoint);
}

function buildRecentHourlyTrendRows(sessions: SessionPoint[], range: DateRange): UsageTrendPoint[] {
  const end = parseActivityDate(range.endDateTime ?? "") ?? new Date();
  const start = parseActivityDate(range.startDateTime ?? "") ?? new Date(end.getTime() - 12 * 60 * 60 * 1000);
  const bucketStart = startOfHour(start);
  const bucketEnd = startOfHour(end);
  const bucketCount = Math.max(1, Math.floor((bucketEnd.getTime() - bucketStart.getTime()) / 3_600_000) + 1);
  const rows = Array.from({ length: bucketCount }, (_, index) => {
    const bucketDate = new Date(bucketStart.getTime() + index * 3_600_000);
    return {
      date: formatHourBucket(bucketDate),
      totalTokens: 0,
      costUSD: 0,
      models: [] as string[],
      sessionCount: 0
    };
  });
  const modelSets = rows.map(() => new Set<string>());

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

    row.totalTokens += session.totalTokens;
    row.costUSD += session.costUSD;
    row.sessionCount = (row.sessionCount ?? 0) + 1;
    session.models.forEach((model) => modelSets[bucketIndex].add(model));
  }

  return rows.map((row, index) => ({
    ...row,
    models: [...modelSets[index]]
  }));
}

function buildHourlyTrendRows(sessions: SessionPoint[], dateKey: string): UsageTrendPoint[] {
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    date: `${String(hour).padStart(2, "0")}:00`,
    totalTokens: 0,
    costUSD: 0,
    models: [] as string[],
    sessionCount: 0
  }));
  const modelSets = rows.map(() => new Set<string>());

  for (const session of sessions) {
    const activityDate = parseActivityDate(session.lastActivity || session.firstActivity);
    if (!activityDate || toDateKey(activityDate) !== dateKey) {
      continue;
    }

    const hour = activityDate.getHours();
    rows[hour].totalTokens += session.totalTokens;
    rows[hour].costUSD += session.costUSD;
    rows[hour].sessionCount = (rows[hour].sessionCount ?? 0) + 1;
    session.models.forEach((model) => modelSets[hour].add(model));
  }

  return rows.map((row, index) => ({
    ...row,
    models: [...modelSets[index]]
  }));
}

function toTrendPoint(row: NormalizedUsage["daily"][number]): UsageTrendPoint {
  return {
    date: row.date,
    totalTokens: row.totalTokens,
    costUSD: row.costUSD,
    models: row.models
  };
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

function summarizeMonthUsage(usage: NormalizedUsage, range: DateRange): UsageSummary {
  const dailyRows = filterUsageByRange(usage.daily, range);
  if (dailyRows.length > 0) {
    return summarizeUsage(dailyRows);
  }

  const month = usage.monthly.find((point) => point.month === range.start.slice(0, 7));
  return {
    totalTokens: month?.totalTokens ?? 0,
    costUSD: month?.costUSD ?? 0
  };
}

function metricDetail(summary: UsageSummary, range: DateRange, mode: PeriodMode): string {
  return `${formatNumber(summary.totalTokens)} tokens - ${formatPeriodMeta(mode, range)}`;
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

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
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
