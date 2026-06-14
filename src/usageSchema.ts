import { z } from "zod";
import { filterUsageByRange, getDayRange, getMonthRange, summarizeUsage } from "./dateRanges";

export const sourceModeSchema = z.enum(["bundled", "system", "mock", "unavailable"]);
export type SourceMode = z.infer<typeof sourceModeSchema>;

export const diagnosticSchema = z.object({
  severity: z.enum(["info", "warning", "error"]).catch("warning"),
  code: z.string(),
  message: z.string()
});

export const commandReportSchema = z.object({
  command: z.enum(["daily", "monthly", "session", "blocks"]),
  ok: z.boolean(),
  exitCode: z.number().nullable().optional(),
  stdout: z.unknown().nullable().optional(),
  stderr: z.string().catch(""),
  classification: z.string().nullable().optional()
});

export const usageCollectionSchema = z.object({
  requestedSourceMode: z.string(),
  effectiveSourceMode: sourceModeSchema.catch("unavailable"),
  runnerLabel: z.string(),
  ccusageVersion: z.string().nullable().optional(),
  diagnostics: z.array(diagnosticSchema).catch([]),
  reports: z.array(commandReportSchema).catch([])
});

export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type CommandReport = z.infer<typeof commandReportSchema>;
export type UsageCollection = z.infer<typeof usageCollectionSchema>;

const numberish = z.coerce.number().finite().catch(0);
const stringArray = z.array(z.string()).catch([]);

const metricRowSchema = z
  .object({
    inputTokens: numberish,
    outputTokens: numberish,
    cacheCreationTokens: numberish,
    cacheReadTokens: numberish,
    totalTokens: numberish,
    totalCost: numberish.optional(),
    costUSD: numberish.optional(),
    models: stringArray.optional(),
    modelsUsed: stringArray.optional(),
    metadata: z
      .object({
        firstActivity: z.string().optional(),
        lastActivity: z.string().optional()
      })
      .passthrough()
      .optional(),
    breakdown: z.record(z.string(), z.unknown()).optional(),
    modelBreakdowns: z
      .array(
        z
          .object({
            modelName: z.string().catch("unknown"),
            inputTokens: numberish,
            outputTokens: numberish,
            cacheCreationTokens: numberish,
            cacheReadTokens: numberish,
            totalTokens: numberish.optional(),
            cost: numberish.optional(),
            costUSD: numberish.optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

const dailyRowSchema = metricRowSchema.extend({
  date: z.string().optional(),
  period: z.string().optional()
});

const monthlyRowSchema = metricRowSchema.extend({
  month: z.string().optional(),
  period: z.string().optional()
});

const sessionRowSchema = metricRowSchema.extend({
  session: z.string().optional(),
  period: z.string().optional(),
  firstActivity: z.string().optional(),
  lastActivity: z.string().optional()
});

const blockRowSchema = metricRowSchema.extend({
  blockStart: z.string(),
  blockEnd: z.string().optional(),
  isActive: z.boolean().catch(false),
  timeRemaining: z.string().optional(),
  burnRate: numberish.optional(),
  projectedTotal: numberish.optional(),
  projectedCost: numberish.optional()
});

export type MetricRow = z.infer<typeof metricRowSchema>;

export type DailyPoint = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  models: string[];
  modelBreakdowns?: ModelBreakdown[];
};

export type MonthlyPoint = DailyPoint & {
  month: string;
};

export type SessionPoint = DailyPoint & {
  session: string;
  firstActivity: string;
  lastActivity: string;
};

export type BlockPoint = DailyPoint & {
  blockStart: string;
  blockEnd: string;
  isActive: boolean;
  timeRemaining: string;
  burnRate: number;
  projectedTotal: number;
  projectedCost: number;
};

export type ModelUsage = {
  model: string;
  totalTokens: number;
  costUSD: number;
};

export type ModelBreakdown = ModelUsage;

export type NormalizedUsage = {
  collection: UsageCollection;
  diagnostics: Diagnostic[];
  daily: DailyPoint[];
  monthly: MonthlyPoint[];
  sessions: SessionPoint[];
  blocks: BlockPoint[];
  modelUsage: ModelUsage[];
  todayTokens: number;
  todayCost: number;
  monthCost: number;
  monthTokens: number;
  activeBlock?: BlockPoint;
  sourceNames: string[];
  hasRealData: boolean;
};

export function parseUsageCollection(input: unknown): UsageCollection {
  return usageCollectionSchema.parse(input);
}

export function normalizeUsage(collection: UsageCollection): NormalizedUsage {
  const diagnostics = [...collection.diagnostics];
  const reportMap = new Map(collection.reports.map((report) => [report.command, report]));

  for (const report of collection.reports) {
    if (!report.ok) {
      diagnostics.push({
        severity: report.classification === "usage-data-not-found" ? "warning" : "error",
        code: report.classification ?? "ccusage-report-failed",
        message: `${report.command} failed${report.exitCode === undefined ? "" : ` (${report.exitCode})`}: ${
          report.stderr || "No output"
        }`
      });
    }
  }

  const daily = parseDaily(reportMap.get("daily")?.stdout, diagnostics);
  const monthly = parseMonthly(reportMap.get("monthly")?.stdout, diagnostics);
  const sessions = parseSessions(reportMap.get("session")?.stdout, diagnostics);
  const blocks = parseBlocks(reportMap.get("blocks")?.stdout, diagnostics);
  const modelUsage = parseModelUsage(daily.length > 0 ? daily : monthly.length > 0 ? monthly : sessions.length > 0 ? sessions : blocks);

  const todayRange = getDayRange(new Date());
  const monthRange = getMonthRange(new Date());
  const today = daily.find((point) => point.date === todayRange.start);
  const currentMonth = monthRange.start.slice(0, 7);
  const month = monthly.find((point) => point.month === currentMonth);
  const monthSummary = summarizeUsage(filterUsageByRange(daily, monthRange));
  const activeBlock = blocks.find((block) => block.isActive);
  const sourceNames = inferSourceNames([...daily, ...monthly, ...sessions, ...blocks]);

  return {
    collection,
    diagnostics,
    daily,
    monthly,
    sessions,
    blocks,
    modelUsage,
    todayTokens: today?.totalTokens ?? 0,
    todayCost: today?.costUSD ?? 0,
    monthCost: month?.costUSD ?? monthSummary.costUSD,
    monthTokens: month?.totalTokens ?? monthSummary.totalTokens,
    activeBlock,
    sourceNames,
    hasRealData: daily.length + monthly.length + sessions.length + blocks.length > 0
  };
}

function parseDaily(payload: unknown, diagnostics: Diagnostic[]): DailyPoint[] {
  const rows = parseRows(payload, "daily", dailyRowSchema, diagnostics);
  return rows
    .map((row) => ({
      date: row.date ?? row.period ?? "",
      ...toMetricPoint(row)
    }))
    .filter((row) => row.date)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function parseMonthly(payload: unknown, diagnostics: Diagnostic[]): MonthlyPoint[] {
  const rows = parseRows(payload, "monthly", monthlyRowSchema, diagnostics);
  return rows
    .map((row) => ({
      month: row.month ?? row.period ?? "",
      date: `${row.month ?? row.period ?? ""}-01`,
      ...toMetricPoint(row)
    }))
    .filter((row) => row.month)
    .sort((left, right) => left.month.localeCompare(right.month));
}

function parseSessions(payload: unknown, diagnostics: Diagnostic[]): SessionPoint[] {
  const rows = parseRows(payload, "session", sessionRowSchema, diagnostics);
  return rows
    .map((row) => ({
      session: row.session ?? row.period ?? "",
      firstActivity: row.firstActivity ?? row.metadata?.firstActivity ?? "",
      lastActivity: row.lastActivity ?? row.metadata?.lastActivity ?? "",
      date: (row.lastActivity ?? row.metadata?.lastActivity ?? "").slice(0, 10),
      ...toMetricPoint(row)
    }))
    .filter((row) => row.session)
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
}

function parseBlocks(payload: unknown, diagnostics: Diagnostic[]): BlockPoint[] {
  const rows = parseRows(payload, "blocks", blockRowSchema, diagnostics);
  return rows
    .map((row) => ({
      blockStart: row.blockStart,
      blockEnd: row.blockEnd ?? "",
      isActive: row.isActive,
      timeRemaining: row.timeRemaining ?? "",
      burnRate: row.burnRate ?? 0,
      projectedTotal: row.projectedTotal ?? 0,
      projectedCost: row.projectedCost ?? 0,
      date: row.blockStart.slice(0, 10),
      ...toMetricPoint(row)
    }))
    .sort((left, right) => right.blockStart.localeCompare(left.blockStart));
}

function parseRows<T extends z.ZodTypeAny>(
  payload: unknown,
  command: string,
  schema: T,
  diagnostics: Diagnostic[]
): z.infer<T>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const candidates: unknown[] = [];

  if (Array.isArray(record.daily)) {
    candidates.push(...record.daily);
  }

  if (Array.isArray(record.monthly)) {
    candidates.push(...record.monthly);
  }

  if (Array.isArray(record.session)) {
    candidates.push(...record.session);
  }

  if (Array.isArray(record.sessions)) {
    candidates.push(...record.sessions);
  }

  if (Array.isArray(record.blocks)) {
    candidates.push(...record.blocks);
  }

  if (Array.isArray(record.data)) {
    candidates.push(...record.data);
  }

  if (record.projects && typeof record.projects === "object") {
    for (const projectRows of Object.values(record.projects as Record<string, unknown>)) {
      if (Array.isArray(projectRows)) {
        candidates.push(...projectRows);
      }
    }
  }

  const rows: z.infer<T>[] = [];
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      diagnostics.push({
        severity: "error",
        code: `${command}-schema-mismatch`,
        message: `${command} JSON row did not match the pinned ccusage schema.`
      });
    }
  }

  return rows;
}

function toMetricPoint(row: MetricRow) {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.totalTokens,
    costUSD: row.costUSD ?? row.totalCost ?? 0,
    models: [...(row.models ?? []), ...(row.modelsUsed ?? [])].filter(Boolean),
    modelBreakdowns: parseBreakdowns(row)
  };
}

function parseBreakdowns(row: MetricRow): ModelBreakdown[] {
  if (!row.modelBreakdowns?.length) {
    return [];
  }

  return row.modelBreakdowns.map((breakdown) => ({
    model: breakdown.modelName,
    totalTokens:
      breakdown.totalTokens ??
      breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheCreationTokens + breakdown.cacheReadTokens,
    costUSD: breakdown.costUSD ?? breakdown.cost ?? 0
  }));
}

function parseModelUsage(
  rows: Array<(DailyPoint | MonthlyPoint | SessionPoint | BlockPoint) & { modelBreakdowns?: ModelBreakdown[] }>
): ModelUsage[] {
  const usage = new Map<string, ModelUsage>();

  for (const row of rows) {
    if (row.modelBreakdowns?.length) {
      for (const breakdown of row.modelBreakdowns) {
        const existing = usage.get(breakdown.model) ?? { model: breakdown.model, totalTokens: 0, costUSD: 0 };
        existing.totalTokens += breakdown.totalTokens;
        existing.costUSD += breakdown.costUSD;
        usage.set(breakdown.model, existing);
      }
      continue;
    }

    const models = row.models.length > 0 ? row.models : ["unknown"];
    const tokenShare = row.totalTokens / models.length;
    const costShare = row.costUSD / models.length;

    for (const model of models) {
      const existing = usage.get(model) ?? { model, totalTokens: 0, costUSD: 0 };
      existing.totalTokens += tokenShare;
      existing.costUSD += costShare;
      usage.set(model, existing);
    }
  }

  return [...usage.values()].sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 8);
}

function inferSourceNames(rows: Array<DailyPoint | MonthlyPoint | SessionPoint | BlockPoint>): string[] {
  const labels = new Set<string>();
  const modelText = rows.flatMap((row) => row.models).join(" ").toLowerCase();

  if (modelText.includes("claude")) {
    labels.add("Claude Code");
  }
  if (modelText.includes("gpt") || modelText.includes("codex")) {
    labels.add("Codex");
  }
  if (modelText.includes("gemini")) {
    labels.add("Gemini CLI");
  }
  if (labels.size === 0 && rows.length > 0) {
    labels.add("ccusage sources");
  }

  return [...labels];
}
