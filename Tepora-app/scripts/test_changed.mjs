import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = process.env.TEPORA_TEST_CHANGED_PROJECT_ROOT
  ? path.resolve(process.env.TEPORA_TEST_CHANGED_PROJECT_ROOT)
  : path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..");

const platform = process.platform;
const defaultGitCommand = platform === "win32" ? "git.exe" : "git";
const defaultNpmCommand = platform === "win32" ? "npm.cmd" : "npm";
const defaultNpxCommand = platform === "win32" ? "npx.cmd" : "npx";

function quoteWindowsArg(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve) => {
    const shouldUseCmdShim = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = shouldUseCmdShim
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")], {
          cwd: options.cwd ?? projectRoot,
          env: process.env,
          stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
        })
      : spawn(command, args, {
          cwd: options.cwd ?? projectRoot,
          env: process.env,
          stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
        });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      resolve({ ok: false, code: null, stdout, stderr, error });
    });

    child.on("exit", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, error: null });
    });
  });
}

function parseArgs(argv) {
  const parsed = {
    base: null,
    staged: false,
    dryRun: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base") {
      parsed.base = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--staged") {
      parsed.staged = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--file") {
      const file = argv[index + 1];
      if (!file) {
        throw new Error("--file requires a path argument");
      }
      parsed.files.push(file);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function normalizeChangedPath(file) {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");

  if (/^(Tepora-app\/|docs\/|README\.md$|Taskfile\.yml$|\.pre-commit-config\.yaml$)/.test(normalized)) {
    return normalized;
  }

  if (/^(backend-rs\/|frontend\/|scripts\/|tests\/|package\.json$|Taskfile\.yml$)/.test(normalized)) {
    return `Tepora-app/${normalized}`;
  }

  return normalized;
}

function normalizeFileList(output) {
  return output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeChangedPath);
}

async function getChangedFiles(options) {
  if (options.files.length > 0) {
    return [...new Set(options.files.map(normalizeChangedPath))];
  }

  if (options.base) {
    const diff = await runCommand(defaultGitCommand, ["diff", "--name-only", `${options.base}...HEAD`], { cwd: workspaceRoot });
    if (!diff.ok) {
      throw new Error(`Failed to read git diff against ${options.base}: ${diff.stderr || diff.error?.message || diff.code}`);
    }
    return normalizeFileList(diff.stdout);
  }

  if (options.staged) {
    const diff = await runCommand(defaultGitCommand, ["diff", "--name-only", "--cached"], { cwd: workspaceRoot });
    if (!diff.ok) {
      throw new Error(`Failed to read staged git diff: ${diff.stderr || diff.error?.message || diff.code}`);
    }
    return normalizeFileList(diff.stdout);
  }

  const diff = await runCommand(defaultGitCommand, ["diff", "--name-only", "HEAD"], { cwd: workspaceRoot });
  if (!diff.ok) {
    throw new Error(`Failed to read working tree diff: ${diff.stderr || diff.error?.message || diff.code}`);
  }

  const untracked = await runCommand(defaultGitCommand, ["ls-files", "--others", "--exclude-standard"], { cwd: workspaceRoot });
  if (!untracked.ok) {
    throw new Error(`Failed to read untracked files: ${untracked.stderr || untracked.error?.message || untracked.code}`);
  }

  return [...new Set([...normalizeFileList(diff.stdout), ...normalizeFileList(untracked.stdout)])];
}

async function getNodeTestFiles() {
  const testsDir = path.join(projectRoot, "tests");
  const entries = await readdir(testsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

function buildPlan(changedFiles, nodeTestFiles) {
  const plan = [];
  const changedSet = new Set(changedFiles);

  const appNodeRelevant = changedFiles.some((file) =>
    file.startsWith("Tepora-app/scripts/") ||
    file.startsWith("Tepora-app/tests/") ||
    file === "Tepora-app/package.json" ||
    file === "Tepora-app/Taskfile.yml"
  );

  if (appNodeRelevant) {
    plan.push({
      id: "app-node-tests",
      title: "Tepora app Node tests",
      command: process.execPath,
      args: ["--test", ...nodeTestFiles],
      cwd: projectRoot,
      reason: "App scripts/tests or task orchestration changed",
    });
  }

  if (changedFiles.some((file) => file.startsWith("Tepora-app/backend-rs/"))) {
    plan.push({
      id: "backend-tests",
      title: "Backend cargo tests",
      command: "cargo",
      args: ["test", "--manifest-path", "Cargo.toml", "--all-targets"],
      cwd: path.join(projectRoot, "backend-rs"),
      reason: "Backend Rust files changed",
    });
  }

  const frontendFiles = changedFiles.filter((file) => file.startsWith("Tepora-app/frontend/"));

  if (frontendFiles.length > 0) {
    const relatedEligible = frontendFiles.every((file) =>
      file.startsWith("Tepora-app/frontend/src/") && /\.(ts|tsx|js|jsx|json)$/i.test(file)
    );

    if (relatedEligible) {
      plan.push({
        id: "frontend-related-tests",
        title: "Frontend related Vitest tests",
        command: defaultNpxCommand,
        args: [
          "--prefix",
          path.join(projectRoot, "frontend"),
          "vitest",
          "related",
          "--run",
          ...frontendFiles.map((file) => file.replace(/^Tepora-app\/frontend\//, "")),
        ],
        cwd: projectRoot,
        reason: "Frontend source-only changes can use Vitest related mode",
      });
    } else {
      plan.push({
        id: "frontend-full-tests",
        title: "Frontend full Vitest run",
        command: defaultNpmCommand,
        args: ["--prefix", path.join(projectRoot, "frontend"), "run", "test", "--", "--run"],
        cwd: projectRoot,
        reason: "Frontend config or non-source files changed",
      });
    }
  }

  const devSyncRelevant = changedSet.has("Taskfile.yml") || changedSet.has("Tepora-app/Taskfile.yml") || changedSet.has("Tepora-app/package.json") || changedFiles.some((file) => file === "Tepora-app/scripts/dev_sync.mjs" || file === "Tepora-app/tests/dev_sync.e2e.test.mjs");

  if (devSyncRelevant && !plan.some((entry) => entry.id === "app-node-tests")) {
    plan.push({
      id: "app-node-tests",
      title: "Tepora app Node tests",
      command: process.execPath,
      args: ["--test", ...nodeTestFiles],
      cwd: projectRoot,
      reason: "Task or dev_sync orchestration changed",
    });
  }

  return plan;
}

function formatCommand(entry) {
  return [entry.command, ...entry.args].join(" ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const changedFiles = await getChangedFiles(options);
  const nodeTestFiles = await getNodeTestFiles();
  const plan = buildPlan(changedFiles, nodeTestFiles);

  console.log("Tepora changed-test planner");
  console.log(`Project root: ${projectRoot}`);
  console.log(`Changed files: ${changedFiles.length}`);

  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      console.log(`  - ${file}`);
    }
  }

  if (plan.length === 0) {
    console.log("No test suites selected for the current diff.");
    return;
  }

  console.log("");
  console.log("Selected suites:");
  for (const entry of plan) {
    console.log(`- ${entry.title}: ${entry.reason}`);
    console.log(`  ${formatCommand(entry)}`);
  }

  if (options.dryRun) {
    console.log("");
    console.log("Dry run only. No commands executed.");
    return;
  }

  console.log("");

  for (const entry of plan) {
    console.log(`Running ${entry.title}...`);
    const result = await runCommand(entry.command, entry.args, {
      cwd: entry.cwd,
      stdio: "inherit",
    });

    if (!result.ok) {
      const failure = result.stderr || result.error?.message || `exit code ${result.code}`;
      throw new Error(`${entry.title} failed: ${failure}`);
    }
  }

  console.log("");
  console.log("Changed-test run completed successfully.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});