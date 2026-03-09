import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const projectRoot = path.resolve(__dirname, "..");

export function quoteWindowsArg(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function normalizeCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }

  if (command === "npm") {
    return "npm.cmd";
  }

  if (command === "npx") {
    return "npx.cmd";
  }

  return command;
}

export async function runCommand(command, commandArgs = [], options = {}) {
  const cwd = path.resolve(options.cwd ?? projectRoot);
  const resolvedCommand = normalizeCommand(command);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const useCmdShim = process.platform === "win32" && /\.(cmd|bat)$/iu.test(resolvedCommand);
    const child = useCmdShim
      ? spawn(process.env.ComSpec || "cmd.exe", [
          "/d",
          "/s",
          "/c",
          [resolvedCommand, ...commandArgs].map(quoteWindowsArg).join(" "),
        ], {
          cwd,
          env: { ...process.env, ...(options.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(resolvedCommand, commandArgs, {
          cwd,
          env: { ...process.env, ...(options.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
        });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function classifyAttempts(attempts) {
  const passedRuns = attempts.filter((attempt) => attempt.exitCode === 0).length;
  const failedRuns = attempts.length - passedRuns;

  let status = "stable_pass";
  if (passedRuns === 0) {
    status = "stable_fail";
  } else if (failedRuns > 0) {
    status = "flaky";
  }

  return {
    status,
    passedRuns,
    failedRuns,
  };
}

export async function runSuite(suite) {
  if (!Array.isArray(suite.command) || suite.command.length === 0) {
    throw new Error("Suite command is required");
  }

  const attempts = [];
  for (let index = 0; index < suite.runs; index += 1) {
    const result = await runCommand(suite.command[0], suite.command.slice(1), {
      cwd: suite.cwd,
      env: suite.env,
    });
    attempts.push({
      attempt: index + 1,
      ...result,
    });
  }

  return {
    label: suite.label,
    cwd: path.resolve(projectRoot, suite.cwd ?? "."),
    command: suite.command,
    runsRequested: suite.runs,
    ...classifyAttempts(attempts),
    attempts,
  };
}

export function renderSuiteSummary(report) {
  const icon = report.status === "stable_pass" ? "PASS" : report.status === "flaky" ? "FLAKY" : "FAIL";
  return `${icon} ${report.label}: ${report.passedRuns}/${report.runsRequested} passing runs`;
}

export async function writeJsonReport(targetPath, payload) {
  const resolvedPath = path.resolve(projectRoot, targetPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function writeTextReport(targetPath, text) {
  const resolvedPath = path.resolve(projectRoot, targetPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, text, "utf8");
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const command = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const options = {
    label: "flaky-check",
    runs: 3,
    cwd: ".",
    jsonOut: null,
  };

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--label") {
      options.label = optionArgs[++index] ?? options.label;
    } else if (arg === "--runs") {
      options.runs = Number(optionArgs[++index] ?? options.runs);
    } else if (arg === "--cwd") {
      options.cwd = optionArgs[++index] ?? options.cwd;
    } else if (arg === "--json-out") {
      options.jsonOut = optionArgs[++index] ?? options.jsonOut;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 2) {
    throw new Error("--runs must be an integer >= 2");
  }

  if (command.length === 0) {
    throw new Error("A command is required after '--'");
  }

  return {
    ...options,
    command,
  };
}

async function main() {
  const suite = parseCliArgs(process.argv.slice(2));
  const report = await runSuite(suite);

  console.log(renderSuiteSummary(report));
  for (const attempt of report.attempts) {
    const status = attempt.exitCode === 0 ? "pass" : "fail";
    console.log(`  attempt ${attempt.attempt}: ${status} (${attempt.durationMs}ms)`);
  }

  if (suite.jsonOut) {
    await writeJsonReport(suite.jsonOut, report);
    console.log(`Report written to ${path.resolve(projectRoot, suite.jsonOut)}`);
  }

  if (report.status !== "stable_pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

