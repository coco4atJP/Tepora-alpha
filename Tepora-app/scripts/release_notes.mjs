import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseNotes, parseConventionalCommit } from "./conventional_commits.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..");
const gitCommand = process.platform === "win32" ? "git.exe" : "git";

function parseArgs(argv) {
  const parsed = {
    from: null,
    to: "HEAD",
    version: null,
    output: null,
  };

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

    if (arg === "--version") {
      parsed.version = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--output") {
      parsed.output = argv[index + 1] ?? null;
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

async function collectCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const result = await runGit(["log", "--no-merges", "--pretty=format:%H%x09%s", range]);

  if (!result.ok) {
    throw new Error(`Failed to read git log for ${range}: ${result.stderr || result.error?.message || result.code}`);
  }

  return result.stdout
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\t");
      const parsed = parseConventionalCommit(subject);
      return parsed ? { ...parsed, hash } : null;
    })
    .filter(Boolean);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commits = await collectCommits(options.from, options.to);
  const notes = buildReleaseNotes(commits, { version: options.version });

  if (options.output) {
    await writeFile(options.output, notes, "utf8");
  }

  process.stdout.write(notes);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});