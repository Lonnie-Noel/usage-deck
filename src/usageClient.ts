import { invoke } from "@tauri-apps/api/core";
import { createMockCollection } from "./mockData";
import { parseUsageCollection, type UsageCollection } from "./usageSchema";

export type RequestedSourceMode = "bundled" | "system" | "mock";

export async function loadUsageCollection(mode: RequestedSourceMode): Promise<UsageCollection> {
  if (mode === "mock") {
    return createMockCollection("Mock mode is selected in the dashboard.");
  }

  if (!window.__TAURI_INTERNALS__) {
    return createMockCollection("Browser preview is not connected to Tauri, so mock data is shown.");
  }

  try {
    const result = await invoke("collect_usage", { sourceMode: mode });
    const collection = parseUsageCollection(result);
    const hasValidReport = collection.reports.some((report) => report.ok && report.stdout);

    if (!hasValidReport) {
      const fallback = createMockCollection("ccusage did not return usable JSON, so mock data is shown.");
      fallback.requestedSourceMode = mode;
      fallback.diagnostics = [...collection.diagnostics, ...fallback.diagnostics];
      return fallback;
    }

    return collection;
  } catch (error) {
    return createMockCollection(error instanceof Error ? error.message : "Tauri command failed before ccusage returned data.");
  }
}
