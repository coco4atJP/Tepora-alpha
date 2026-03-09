import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(PROJECT_ROOT, "scripts", "test_changed.mjs");

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function collectLines(stream, sink) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;

    while (true) {
      const index = pending.indexOf("\n");
      if (index < 0) {
        break;
      }

      sink.push(pending.slice(0, index).replace(/\r$/, ""));
      pending = pending.slice(index + 1);
    }
  });

  stream.on("end", () => {
    const tail = pending.trim();
    if (tail) {
      sink.push(tail);
    }
  });
}

async function runScript(args) {
  const lines = [];
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  collectLines(child.stdout, lines);
  collectLines(child.stderr, lines);

  const result = await waitForExit(child);
  return { ...result, lines };
}

test("test_changed skips docs-only diffs", async () => {
  const result = await runScript(["--dry-run", "--file", "docs/CHANGELOG.md"]);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.includes("No test suites selected")));
});

test("test_changed selects backend, frontend related, and app node suites", async () => {
  const result = await runScript([
    "--dry-run",
    "--file",
    "Tepora-app/backend-rs/src/lib.rs",
    "--file",
    "Tepora-app/frontend/src/test/example.test.ts",
    "--file",
    "Tepora-app/tests/task_doctor.test.mjs",
  ]);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.includes("Tepora app Node tests: App scripts/tests or task orchestration changed")));
  assert.ok(result.lines.some((line) => line.includes("Backend cargo tests: Backend Rust files changed")));
  assert.ok(result.lines.some((line) => line.includes("Frontend related Vitest tests: Frontend source-only changes can use Vitest related mode")));
});

test("test_changed falls back to full frontend tests for config changes", async () => {
  const result = await runScript([
    "--dry-run",
    "--file",
    "Tepora-app/frontend/vite.config.ts",
  ]);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.includes("Frontend full Vitest run: Frontend config or non-source files changed")));
});