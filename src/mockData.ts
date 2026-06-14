import { toDateKey } from "./dateRanges";
import type { UsageCollection } from "./usageSchema";

const models = ["claude-sonnet-4-5-20250929", "gpt-5.3-codex", "gemini-2.5-pro"];

export function createMockCollection(reason = "Mock dataset selected."): UsageCollection {
  const today = new Date();
  const daily = Array.from({ length: 45 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (44 - index));
    const multiplier = 0.64 + index * 0.028;
    const inputTokens = Math.round(18000 * multiplier);
    const outputTokens = Math.round(42000 * multiplier);
    const cacheCreationTokens = Math.round(2600 * multiplier);
    const cacheReadTokens = Math.round(11800 * multiplier);
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const used = index % 3 === 0 ? [models[0], models[1]] : [models[index % models.length]];

    return {
      date: toDateKey(date),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens,
      totalCost: Number((totalTokens / 8500).toFixed(2)),
      modelsUsed: used
    };
  });

  const totalTokens = daily.reduce((total, row) => total + row.totalTokens, 0);
  const totalCost = daily.reduce((total, row) => total + row.totalCost, 0);
  const monthly = buildMonthlyRows(daily);

  const sessions = Array.from({ length: 8 }, (_, index) => {
    const date = new Date(today);
    date.setHours(today.getHours() - index * 5);
    const inputTokens = 8000 + index * 900;
    const outputTokens = 21000 + index * 1700;
    const cacheCreationTokens = 1200 + index * 160;
    const cacheReadTokens = 7000 + index * 500;
    const sessionTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

    return {
      session: `local-thread-${String(index + 1).padStart(2, "0")}`,
      models: [models[index % models.length]],
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens: sessionTokens,
      costUSD: Number((sessionTokens / 9000).toFixed(2)),
      firstActivity: new Date(date.getTime() - 1000 * 60 * 75).toISOString(),
      lastActivity: date.toISOString()
    };
  });

  const blocks = Array.from({ length: 5 }, (_, index) => {
    const start = new Date(today);
    start.setHours(today.getHours() - index * 5, 0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 5);
    const blockTokens = 38000 + index * 7300;

    return {
      blockStart: start.toISOString(),
      blockEnd: end.toISOString(),
      isActive: index === 0,
      timeRemaining: index === 0 ? "2h 18m" : "",
      models: [models[index % models.length]],
      inputTokens: Math.round(blockTokens * 0.22),
      outputTokens: Math.round(blockTokens * 0.55),
      cacheCreationTokens: Math.round(blockTokens * 0.05),
      cacheReadTokens: Math.round(blockTokens * 0.18),
      totalTokens: blockTokens,
      costUSD: Number((blockTokens / 9200).toFixed(2)),
      burnRate: index === 0 ? 7600 : 0,
      projectedTotal: index === 0 ? 62000 : 0,
      projectedCost: index === 0 ? 6.74 : 0
    };
  });

  return {
    requestedSourceMode: "mock",
    effectiveSourceMode: "mock",
    runnerLabel: "Mock usage feed",
    ccusageVersion: "20.0.11-mock",
    diagnostics: [{ severity: "info", code: "mock-data", message: reason }],
    reports: [
      {
        command: "daily",
        ok: true,
        exitCode: 0,
        stdout: {
          daily,
          totals: {
            inputTokens: daily.reduce((total, row) => total + row.inputTokens, 0),
            outputTokens: daily.reduce((total, row) => total + row.outputTokens, 0),
            cacheCreationTokens: daily.reduce((total, row) => total + row.cacheCreationTokens, 0),
            cacheReadTokens: daily.reduce((total, row) => total + row.cacheReadTokens, 0),
            totalTokens,
            totalCost
          }
        },
        stderr: ""
      },
      {
        command: "monthly",
        ok: true,
        exitCode: 0,
        stdout: {
          type: "monthly",
          data: monthly,
          summary: {
            totalTokens,
            totalCostUSD: Number(totalCost.toFixed(2))
          }
        },
        stderr: ""
      },
      {
        command: "session",
        ok: true,
        exitCode: 0,
        stdout: { type: "session", data: sessions },
        stderr: ""
      },
      {
        command: "blocks",
        ok: true,
        exitCode: 0,
        stdout: { type: "blocks", data: blocks },
        stderr: ""
      }
    ]
  };
}

function buildMonthlyRows(
  daily: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
    modelsUsed: string[];
  }>
) {
  const monthly = new Map<
    string,
    {
      month: string;
      models: Set<string>;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      costUSD: number;
    }
  >();

  for (const row of daily) {
    const month = row.date.slice(0, 7);
    const existing =
      monthly.get(month) ??
      {
        month,
        models: new Set<string>(),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0
      };

    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.totalTokens += row.totalTokens;
    existing.costUSD += row.totalCost;
    row.modelsUsed.forEach((model) => existing.models.add(model));
    monthly.set(month, existing);
  }

  return [...monthly.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((row) => ({
      month: row.month,
      models: [...row.models].sort(),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheReadTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens,
      costUSD: Number(row.costUSD.toFixed(2))
    }));
}
