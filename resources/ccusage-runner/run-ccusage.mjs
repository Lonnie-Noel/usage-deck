import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const candidates = [
  process.env.USAGE_DECK_CCUSAGE_CLI,
  path.resolve(scriptDir, "node_modules/ccusage/dist/cli.js"),
  path.resolve(scriptDir, "../node_modules/ccusage/dist/cli.js"),
  path.resolve(scriptDir, "../../node_modules/ccusage/dist/cli.js"),
  path.resolve(process.cwd(), "node_modules/ccusage/dist/cli.js")
].filter(Boolean);

const cliPath = candidates.find((candidate) => existsSync(candidate));

if (!cliPath) {
  console.error("Usage Deck could not locate bundled ccusage 20.0.11.");
  console.error("Checked:");
  for (const candidate of candidates) {
    console.error(`- ${candidate}`);
  }
  process.exit(127);
}

const result = spawnSync(process.execPath, [cliPath, ...args], {
  env: {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1"
  },
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
