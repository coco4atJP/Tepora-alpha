import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASELINE_PATH = process.env.TEPORA_PERF_BASELINE
  ? path.resolve(process.env.TEPORA_PERF_BASELINE)
  : path.join(__dirname, "perf-baseline.json");
const RESULT_PATH = process.env.TEPORA_PERF_RESULT
  ? path.resolve(process.env.TEPORA_PERF_RESULT)
  : path.join(__dirname, "perf-results.json");
const ALLOWED_REGRESSION_RATIO = Number(process.env.TEPORA_PERF_ALLOWED_RATIO ?? "1.2");

const METRICS = ["startup_ms", "ttft_ms", "peak_rss_mb"];

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function formatDelta(current, baseline) {
  if (baseline === 0) {
    return "n/a";
  }
  const ratio = current / baseline;
  const delta = (ratio - 1) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

async function main() {
  if (!Number.isFinite(ALLOWED_REGRESSION_RATIO) || ALLOWED_REGRESSION_RATIO <= 0) {
    throw new Error(`Invalid TEPORA_PERF_ALLOWED_RATIO: ${ALLOWED_REGRESSION_RATIO}`);
  }

  const baseline = await readJson(BASELINE_PATH);
  const result = await readJson(RESULT_PATH);

  const failures = [];

  console.log("[perf-gate] evaluating p95 metrics");
  for (const metric of METRICS) {
    const baselineValue = Number(baseline?.p95?.[metric]);
    const currentValue = Number(result?.p95?.[metric]);

    if (!Number.isFinite(baselineValue) || baselineValue <= 0) {
      throw new Error(`baseline metric is invalid: ${metric}`);
    }
    if (!Number.isFinite(currentValue) || currentValue <= 0) {
      throw new Error(`result metric is invalid: ${metric}`);
    }

    const threshold = baselineValue * ALLOWED_REGRESSION_RATIO;
    const pass = currentValue <= threshold;

    console.log(
      `[perf-gate] ${metric}: current=${currentValue} baseline=${baselineValue} threshold=${threshold.toFixed(2)} delta=${formatDelta(currentValue, baselineValue)} ${pass ? "PASS" : "FAIL"}`
    );

    if (!pass) {
      failures.push({ metric, currentValue, baselineValue, threshold });
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map(
        ({ metric, currentValue, baselineValue, threshold }) =>
          `${metric}: current=${currentValue} baseline=${baselineValue} threshold=${threshold.toFixed(2)}`
      )
      .join("; ");
    throw new Error(`[perf-gate] regression detected: ${summary}`);
  }

  console.log("[perf-gate] passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
