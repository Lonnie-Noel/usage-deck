import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const target = args.target ?? process.env.USAGE_DECK_TARGET_TRIPLE ?? detectTargetTriple();
const binaryPath = args.binary ?? process.env.USAGE_DECK_CCUSAGE_NATIVE_BINARY ?? resolveCcusageNativeBinary(target);
const extension = target.includes("windows") ? ".exe" : "";
const outputDir = path.join(projectRoot, "src-tauri", "binaries");
const outputPath = path.join(outputDir, `ccusage-runner-${target}${extension}`);

if (!binaryPath || !existsSync(binaryPath)) {
  console.error(`Could not locate pinned ccusage native binary for ${target}.`);
  console.error("Run npm install on the target build host or pass --binary /path/to/ccusage.");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
copyFileSync(binaryPath, outputPath);

if (!target.includes("windows")) {
  chmodSync(outputPath, 0o755);
}

console.log(`Prepared Usage Deck sidecar: ${path.relative(projectRoot, outputPath)}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--target") {
      parsed.target = values[index + 1];
      index += 1;
    } else if (value.startsWith("--target=")) {
      parsed.target = value.slice("--target=".length);
    } else if (value === "--binary") {
      parsed.binary = values[index + 1];
      index += 1;
    } else if (value.startsWith("--binary=")) {
      parsed.binary = value.slice("--binary=".length);
    }
  }
  return parsed;
}

function detectTargetTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    return platformArchToTriple(process.platform, process.arch);
  }
}

function resolveCcusageNativeBinary(targetTriple) {
  const variant = targetTripleToPackageVariant(targetTriple);
  if (!variant) {
    return undefined;
  }

  const packageName = `@ccusage/ccusage-${variant}`;
  const binaryRelativePath = targetTriple.includes("windows") ? "bin/ccusage.exe" : "bin/ccusage";

  try {
    return require.resolve(`${packageName}/${binaryRelativePath}`);
  } catch {
    return undefined;
  }
}

function targetTripleToPackageVariant(targetTriple) {
  switch (targetTriple) {
    case "x86_64-pc-windows-msvc":
      return "win32-x64";
    case "aarch64-pc-windows-msvc":
      return "win32-arm64";
    case "aarch64-apple-darwin":
      return "darwin-arm64";
    case "x86_64-apple-darwin":
      return "darwin-x64";
    case "x86_64-unknown-linux-gnu":
      return "linux-x64";
    case "aarch64-unknown-linux-gnu":
      return "linux-arm64";
    default:
      return undefined;
  }
}

function platformArchToTriple(platform, arch) {
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "win32" && arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (platform === "linux" && arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}
