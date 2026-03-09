import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export function parseArgs(argv) {
  const parsed = {
    dataset: null,
    variants: [],
    baseline: null,
    candidate: null,
    outputJson: null,
    outputMd: null,
    failOnRegression: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dataset") {
      parsed.dataset = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--variant") {
      parsed.variants.push(parseVariantArg(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }

    if (arg === "--baseline") {
      parsed.baseline = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--candidate") {
      parsed.candidate = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--output-json") {
      parsed.outputJson = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--output-md") {
      parsed.outputMd = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--fail-on-regression") {
      parsed.failOnRegression = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.dataset) {
    throw new Error("Missing required argument: --dataset <path>");
  }

  if (parsed.variants.length < 2) {
    throw new Error("At least two --variant <id>=<path> arguments are required");
  }

  return parsed;
}

function parseVariantArg(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid --variant value: ${value}. Expected <id>=<path>`);
  }

  return {
    id: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

async function loadJson(filePath) {
  const absolutePath = path.resolve(projectRoot, filePath);
  const raw = await readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }

  return value;
}

function jsonEquals(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function getJsonPathValue(value, jsonPath) {
  return jsonPath.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (/^\d+$/.test(segment)) {
      return current[Number(segment)];
    }

    return current[segment];
  }, value);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r/g, "").trim();
}

function includesTerm(haystack, needle, ignoreCase) {
  if (ignoreCase) {
    return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  }

  return haystack.includes(needle);
}

export function scoreCheck(responseText, check) {
  const text = normalizeText(responseText);
  const points = Number(check.points ?? 1);
  const ignoreCase = check.ignoreCase !== false;

  let passed = false;
  let detail = "";

  switch (check.type) {
    case "includes_all": {
      const terms = check.terms ?? [];
      const missing = terms.filter((term) => !includesTerm(text, term, ignoreCase));
      passed = missing.length === 0;
      detail = passed ? `matched ${terms.length} required terms` : `missing: ${missing.join(", ")}`;
      break;
    }
    case "excludes_all": {
      const terms = check.terms ?? [];
      const present = terms.filter((term) => includesTerm(text, term, ignoreCase));
      passed = present.length === 0;
      detail = passed ? `excluded ${terms.length} forbidden terms` : `present: ${present.join(", ")}`;
      break;
    }
    case "exact_equals": {
      const expected = normalizeText(check.expected ?? "");
      passed = text === expected;
      detail = passed ? "exact match" : `expected ${JSON.stringify(expected)}`;
      break;
    }
    case "regex_match": {
      const regex = new RegExp(check.pattern, check.flags ?? "");
      passed = regex.test(text);
      detail = passed ? `matched /${check.pattern}/${check.flags ?? ""}` : `did not match /${check.pattern}/${check.flags ?? ""}`;
      break;
    }
    case "max_length": {
      const maxLength = Number(check.value ?? 0);
      passed = text.length <= maxLength;
      detail = passed ? `length ${text.length} <= ${maxLength}` : `length ${text.length} > ${maxLength}`;
      break;
    }
    case "min_length": {
      const minLength = Number(check.value ?? 0);
      passed = text.length >= minLength;
      detail = passed ? `length ${text.length} >= ${minLength}` : `length ${text.length} < ${minLength}`;
      break;
    }
    case "json_equals": {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      passed = parsed !== undefined && jsonEquals(parsed, check.expected);
      detail = passed ? "JSON matched expected value" : "JSON mismatch";
      break;
    }
    case "json_path_equals": {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const actual = parsed === undefined ? undefined : getJsonPathValue(parsed, check.path);
      passed = parsed !== undefined && jsonEquals(actual, check.expected);
      detail = passed ? `${check.path} matched expected value` : `${check.path} mismatch`;
      break;
    }
    default:
      throw new Error(`Unsupported check type: ${check.type}`);
  }

  return {
    type: check.type,
    passed,
    pointsEarned: passed ? points : 0,
    pointsPossible: points,
    detail,
  };
}

export function evaluateCase(caseDef, responseText) {
  const checks = (caseDef.checks ?? []).map((check) => scoreCheck(responseText, check));
  const score = checks.reduce((total, check) => total + check.pointsEarned, 0);
  const maxScore = checks.reduce((total, check) => total + check.pointsPossible, 0);

  return {
    id: caseDef.id,
    prompt: caseDef.prompt,
    response: normalizeText(responseText),
    score,
    maxScore,
    checks,
    missingResponse: responseText === undefined,
  };
}

export function evaluateVariant(dataset, variant) {
  const responses = variant.responses ?? {};
  const cases = dataset.cases.map((caseDef) => evaluateCase(caseDef, responses[caseDef.id]));
  const totalScore = cases.reduce((total, caseResult) => total + caseResult.score, 0);
  const maxScore = cases.reduce((total, caseResult) => total + caseResult.maxScore, 0);

  return {
    id: variant.id,
    label: variant.label ?? variant.id,
    source: variant.source,
    totalScore,
    maxScore,
    passRate: maxScore === 0 ? 1 : totalScore / maxScore,
    cases,
  };
}

export function compareVariants(results, options = {}) {
  if (results.length < 2) {
    return null;
  }

  const baselineId = options.baseline ?? results[0]?.id;
  const candidateId = options.candidate ?? results[1]?.id;
  const baseline = results.find((result) => result.id === baselineId);
  const candidate = results.find((result) => result.id === candidateId);

  if (!baseline || !candidate) {
    throw new Error(`Unable to compare variants baseline=${baselineId} candidate=${candidateId}`);
  }

  const caseComparisons = baseline.cases.map((baselineCase) => {
    const candidateCase = candidate.cases.find((caseResult) => caseResult.id === baselineCase.id);
    const delta = (candidateCase?.score ?? 0) - baselineCase.score;

    let winner = "tie";
    if (delta > 0) {
      winner = candidate.id;
    } else if (delta < 0) {
      winner = baseline.id;
    }

    return {
      id: baselineCase.id,
      baselineScore: baselineCase.score,
      candidateScore: candidateCase?.score ?? 0,
      delta,
      winner,
    };
  });

  const wins = caseComparisons.filter((comparison) => comparison.winner === candidate.id).length;
  const losses = caseComparisons.filter((comparison) => comparison.winner === baseline.id).length;
  const ties = caseComparisons.length - wins - losses;
  const totalDelta = candidate.totalScore - baseline.totalScore;

  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    baselineScore: baseline.totalScore,
    candidateScore: candidate.totalScore,
    totalDelta,
    wins,
    losses,
    ties,
    regression: totalDelta < 0,
    caseComparisons,
  };
}

export function renderMarkdownReport(dataset, report) {
  const lines = [
    `## ${dataset.name}`,
    "",
  ];

  if (dataset.description) {
    lines.push(dataset.description, "");
  }

  lines.push("### Variant Summary", "", "| Variant | Score | Pass Rate |", "| --- | ---: | ---: |");
  for (const variant of report.variants) {
    lines.push(`| ${variant.label} | ${variant.totalScore}/${variant.maxScore} | ${(variant.passRate * 100).toFixed(1)}% |`);
  }

  if (report.comparison) {
    lines.push(
      "",
      `### A/B Comparison (${report.comparison.candidateId} vs ${report.comparison.baselineId})`,
      "",
      `- Total delta: ${report.comparison.totalDelta >= 0 ? "+" : ""}${report.comparison.totalDelta}`,
      `- Case wins: ${report.comparison.wins}`,
      `- Case losses: ${report.comparison.losses}`,
      `- Ties: ${report.comparison.ties}`,
      "",
      "| Case | Baseline | Candidate | Delta | Winner |",
      "| --- | ---: | ---: | ---: | --- |",
    );

    for (const comparison of report.comparison.caseComparisons) {
      lines.push(
        `| ${comparison.id} | ${comparison.baselineScore} | ${comparison.candidateScore} | ${comparison.delta >= 0 ? "+" : ""}${comparison.delta} | ${comparison.winner} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function evaluateBehaviorDataset(options) {
  const dataset = await loadJson(options.dataset);
  const variants = [];

  for (const variantOption of options.variants) {
    const loaded = await loadJson(variantOption.path);
    variants.push({
      id: variantOption.id,
      label: loaded.label ?? variantOption.id,
      source: variantOption.path,
      responses: loaded.responses ?? loaded,
    });
  }

  const variantResults = variants.map((variant) => evaluateVariant(dataset, variant));
  const comparison = compareVariants(variantResults, {
    baseline: options.baseline,
    candidate: options.candidate,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: {
      name: dataset.name,
      description: dataset.description ?? "",
      caseCount: dataset.cases.length,
    },
    variants: variantResults,
    comparison,
  };
  const markdown = renderMarkdownReport(dataset, report);

  if (options.outputJson) {
    await mkdir(path.dirname(path.resolve(projectRoot, options.outputJson)), { recursive: true });
    await writeFile(path.resolve(projectRoot, options.outputJson), JSON.stringify(report, null, 2), "utf8");
  }

  if (options.outputMd) {
    await mkdir(path.dirname(path.resolve(projectRoot, options.outputMd)), { recursive: true });
    await writeFile(path.resolve(projectRoot, options.outputMd), markdown, "utf8");
  }

  return { dataset, report, markdown };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report, markdown } = await evaluateBehaviorDataset(options);
  process.stdout.write(markdown);

  if (options.failOnRegression && report.comparison && report.comparison.regression) {
    throw new Error(
      `Behavior regression detected: ${report.comparison.candidateId} scored ${report.comparison.totalDelta} points vs ${report.comparison.baselineId}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

