import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { renderSuiteSummary, runSuite, writeJsonReport, writeTextReport } from "./flaky_check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultConfigPath = path.resolve(__dirname, "..", "tests", "flaky", "quarantine-suites.json");

export function summarizeLane(reports) {
  const counts = reports.reduce(
    (accumulator, report) => {
      accumulator[report.status] += 1;
      return accumulator;
    },
    { stable_pass: 0, flaky: 0, stable_fail: 0 },
  );

  let overallStatus = "stable_pass";
  if (counts.stable_fail > 0) {
    overallStatus = "stable_fail";
  } else if (counts.flaky > 0) {
    overallStatus = "flaky";
  }

  return {
    overallStatus,
    suiteCount: reports.length,
    counts,
  };
}

export function renderMarkdownReport(summary, reports) {
  const lines = [
    "# Flaky Test Quarantine Report",
    "",
    `- Overall status: ${summary.overallStatus}`,
    `- Stable pass suites: ${summary.counts.stable_pass}`,
    `- Flaky suites: ${summary.counts.flaky}`,
    `- Stable fail suites: ${summary.counts.stable_fail}`,
    "",
    "## Suites",
  ];

  for (const report of reports) {
    lines.push(`- ${renderSuiteSummary(report)}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function loadSuiteConfig(configPath = defaultConfigPath) {
  const raw = await readFile(configPath, "utf8");
  const payload = JSON.parse(raw);
  const suites = Array.isArray(payload.suites) ? payload.suites : [];

  if (suites.length === 0) {
    throw new Error(`No suites configured in ${configPath}`);
  }

  return suites.map((suite) => ({
    ...suite,
    cwd: suite.cwd ?? ".",
    runs: Number(suite.runs ?? 3),
  }));
}

export async function runQuarantineLane(options = {}) {
  const configPath = path.resolve(options.configPath ?? defaultConfigPath);
  const suites = await loadSuiteConfig(configPath);
  const reports = [];

  for (const suite of suites) {
    const report = await runSuite(suite);
    reports.push(report);
    console.log(renderSuiteSummary(report));
  }

  const summary = summarizeLane(reports);
  const payload = {
    configPath,
    generatedAt: new Date().toISOString(),
    summary,
    reports,
  };

  if (options.jsonOut) {
    await writeJsonReport(options.jsonOut, payload);
  }

  if (options.markdownOut) {
    await writeTextReport(options.markdownOut, renderMarkdownReport(summary, reports));
  }

  return payload;
}

function parseCliArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    jsonOut: path.join("tests", "flaky", "quarantine-report.json"),
    markdownOut: path.join("tests", "flaky", "quarantine-report.md"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      options.configPath = argv[++index] ?? options.configPath;
    } else if (arg === "--json-out") {
      options.jsonOut = argv[++index] ?? options.jsonOut;
    } else if (arg === "--markdown-out") {
      options.markdownOut = argv[++index] ?? options.markdownOut;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const payload = await runQuarantineLane(parseCliArgs(process.argv.slice(2)));
  console.log(`Overall status: ${payload.summary.overallStatus}`);
  if (payload.summary.overallStatus !== "stable_pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
