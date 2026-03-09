import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectInvalidCommitMessages } from "./conventional_commits.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..");
const gitCommand = process.platform === "win32" ? "git.exe" : "git";

function parseArgs(argv) {
  const parsed = { from: null, to: "HEAD", message: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--from") {
      parsed.from = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--to") {
      parsed.to = argv[index + 1] ?? "HEAD";
      index += 1;
      continue;
    }

    if (arg === "--message") {
      parsed.message = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function runGit(args) {
  return await new Promise((resolve) => {
    const child = spawn(gitCommand, args, {
      cwd: workspaceRoot,
      env: process.env,
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

    child.on("error", (error) => {
      resolve({ ok: false, stdout, stderr, error, code: null });
    });

    child.on("exit", (code) => {
      resolve({ ok: code === 0, stdout, stderr, error: null, code });
    });
  });
}

async function collectCommitSubjects(options) {
  if (options.message) {
    return [options.message];
  }

  const range = options.from ? `${options.from}..${options.to}` : options.to;
  const result = await runGit(["log", "--no-merges", "--pretty=format:%s", range]);

  if (!result.ok) {
    throw new Error(`Failed to read git log for ${range}: ${result.stderr || result.error?.message || result.code}`);
  }

  return result.stdout
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const subjects = await collectCommitSubjects(options);
  const invalid = collectInvalidCommitMessages(subjects);

  if (invalid.length > 0) {
    console.error("Invalid commit messages detected:");
    for (const subject of invalid) {
      console.error(`- ${subject}`);
    }
    console.error("");
    console.error("Expected conventional commit format, e.g. feat(ui): add model card tags");
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${subjects.length} commit message(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});