import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DOCTOR_SCRIPT = path.join(PROJECT_ROOT, "scripts", "task_doctor.mjs");

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
      const nextBreak = pending.indexOf("\n");
      if (nextBreak < 0) {
        break;
      }

      const line = pending.slice(0, nextBreak).replace(/\r$/, "");
      sink.push(line);
      pending = pending.slice(nextBreak + 1);
    }
  });

  stream.on("end", () => {
    const line = pending.trim();
    if (line) {
      sink.push(line);
    }
  });
}

async function createFixtureProject(rootDir) {
  await mkdir(path.join(rootDir, "backend-rs"), { recursive: true });
  await mkdir(path.join(rootDir, "frontend", "src-tauri"), { recursive: true });
  await mkdir(path.join(rootDir, "frontend", "node_modules", ".bin"), { recursive: true });

  await writeFile(path.join(rootDir, "Taskfile.yml"), "version: '3'\n", "utf8");
  await writeFile(path.join(rootDir, "backend-rs", "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n", "utf8");
  await writeFile(path.join(rootDir, "frontend", "package.json"), "{\"name\":\"fixture-frontend\"}\n", "utf8");
  await writeFile(path.join(rootDir, "frontend", "package-lock.json"), "{\"lockfileVersion\":3}\n", "utf8");

  const tauriFile = process.platform === "win32" ? "tauri.cmd" : "tauri";
  await writeFile(path.join(rootDir, "frontend", "node_modules", ".bin", tauriFile), "echo tauri\n", "utf8");
}

async function createFakeToolScript(tempDir) {
  const scriptPath = path.join(tempDir, "fake-tool.mjs");
  const code = `
const tool = process.argv[2];
const args = process.argv.slice(3);

if (tool === "npm") {
  if (args[0] === "--version") {
    console.log("10.8.2");
    process.exit(0);
  }

  if (args[0] === "config" && args[1] === "get" && args[2] === "legacy-peer-deps") {
    console.log(process.env.FAKE_NPM_LEGACY_PEER_DEPS ?? "false");
    process.exit(0);
  }
}

if (tool === "cargo") {
  if (args[0] === "--version") {
    console.log("cargo 1.90.0");
    process.exit(0);
  }

  if (args[0] === "metadata") {
    console.log("{\\"packages\\":[]}");
    process.exit(0);
  }
}

if (tool === "rustc" && args[0] === "--version") {
  console.log("rustc 1.90.0");
  process.exit(0);
}

if (tool === "task") {
  if (args[0] === "--version") {
    console.log("Task version: v3.40.1");
    process.exit(0);
  }

  if (args.includes("--list")) {
    console.log("task: Available tasks");
    process.exit(0);
  }
}

console.error(\`Unexpected invocation: \${tool} \${args.join(" ")}\`);
process.exit(1);
`;

  await writeFile(scriptPath, code, "utf8");
  return scriptPath;
}

function doctorEnv(projectRoot, fakeToolScript) {
  return {
    ...process.env,
    TEPORA_DOCTOR_PROJECT_ROOT: projectRoot,
    TEPORA_DOCTOR_NPM_CMD: process.execPath,
    TEPORA_DOCTOR_NPM_PREFIX_ARGS_JSON: JSON.stringify([fakeToolScript, "npm"]),
    TEPORA_DOCTOR_CARGO_CMD: process.execPath,
    TEPORA_DOCTOR_CARGO_PREFIX_ARGS_JSON: JSON.stringify([fakeToolScript, "cargo"]),
    TEPORA_DOCTOR_RUSTC_CMD: process.execPath,
    TEPORA_DOCTOR_RUSTC_PREFIX_ARGS_JSON: JSON.stringify([fakeToolScript, "rustc"]),
    TEPORA_DOCTOR_TASK_CMD: process.execPath,
    TEPORA_DOCTOR_TASK_PREFIX_ARGS_JSON: JSON.stringify([fakeToolScript, "task"]),
  };
}

test("task doctor exits cleanly for a healthy workspace", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-doctor-ok-"));
  const outputLines = [];

  await createFixtureProject(tempDir);
  const fakeToolScript = await createFakeToolScript(tempDir);

  const child = spawn(process.execPath, [DOCTOR_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: doctorEnv(tempDir, fakeToolScript),
    stdio: ["ignore", "pipe", "pipe"],
  });

  collectLines(child.stdout, outputLines);
  collectLines(child.stderr, outputLines);

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const { code, signal } = await waitForExit(child);

  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(outputLines.some((line) => line.includes("Doctor status: OK")));
  assert.ok(outputLines.some((line) => line.includes("[PASS] Cargo:")));
  assert.ok(outputLines.some((line) => line.includes("[PASS] Tauri CLI:")));
});

test("task doctor fails when a required tool is unavailable", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-doctor-fail-"));
  const outputLines = [];

  await createFixtureProject(tempDir);
  const fakeToolScript = await createFakeToolScript(tempDir);

  const env = {
    ...doctorEnv(tempDir, fakeToolScript),
    TEPORA_DOCTOR_CARGO_CMD: "definitely-missing-cargo-command",
    TEPORA_DOCTOR_CARGO_PREFIX_ARGS_JSON: JSON.stringify([]),
  };

  const child = spawn(process.execPath, [DOCTOR_SCRIPT], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  collectLines(child.stdout, outputLines);
  collectLines(child.stderr, outputLines);

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const { code, signal } = await waitForExit(child);

  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.ok(outputLines.some((line) => line.includes("Doctor status: FAIL")));
  assert.ok(outputLines.some((line) => line.includes("[FAIL] Cargo:")));
  assert.ok(outputLines.some((line) => line.includes("Install Rust via rustup")));
});