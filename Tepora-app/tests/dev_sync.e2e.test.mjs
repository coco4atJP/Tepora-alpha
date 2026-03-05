import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEV_SYNC_SCRIPT = path.join(PROJECT_ROOT, "scripts", "dev_sync.mjs");
const BACKEND_PORT = "43111";

async function waitFor(description, predicate, timeoutMs = 20000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function readEvents(stateFile) {
  try {
    const raw = await readFile(stateFile, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

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
      const idx = pending.indexOf("\n");
      if (idx < 0) {
        break;
      }

      const line = pending.slice(0, idx).replace(/\r$/, "");
      sink.push(line);
      pending = pending.slice(idx + 1);
    }
  });

  stream.on("end", () => {
    const line = pending.trim();
    if (line) {
      sink.push(line);
    }
  });
}

test("dev_sync forwards backend port to frontend and terminates child processes", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-sync-e2e-"));
  const stateFile = path.join(tempDir, "state.jsonl");
  const fakeCargoPath = path.join(tempDir, "fake-cargo.mjs");
  const fakeNpmPath = path.join(tempDir, "fake-npm.mjs");

  const fakeCargoCode = `
import { appendFileSync } from "node:fs";

const stateFile = process.env.DEV_SYNC_TEST_STATE_FILE;
const backendPort = process.env.DEV_SYNC_TEST_BACKEND_PORT ?? "43111";

appendFileSync(stateFile, JSON.stringify({ proc: "cargo", event: "start", argv: process.argv.slice(2) }) + "\\n");

setTimeout(() => {
  process.stdout.write(\`TEPORA_PORT=\${backendPort}\\n\`);
}, 50);

const onSignal = (signal) => {
  appendFileSync(stateFile, JSON.stringify({ proc: "cargo", event: "signal", signal }) + "\\n");
  process.exit(0);
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

setInterval(() => {}, 1000);
`;

  const fakeNpmCode = `
import { appendFileSync } from "node:fs";

const stateFile = process.env.DEV_SYNC_TEST_STATE_FILE;

appendFileSync(
  stateFile,
  JSON.stringify({
    proc: "npm",
    event: "start",
    argv: process.argv.slice(2),
    env: {
      VITE_API_PORT: process.env.VITE_API_PORT ?? null,
      VITE_API_KEY: process.env.VITE_API_KEY ?? null,
      VITE_SESSION_TOKEN: process.env.VITE_SESSION_TOKEN ?? null,
    },
  }) + "\\n"
);

const onSignal = (signal) => {
  appendFileSync(stateFile, JSON.stringify({ proc: "npm", event: "signal", signal }) + "\\n");
  process.exit(0);
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

setInterval(() => {}, 1000);
`;

  await writeFile(fakeCargoPath, fakeCargoCode, "utf8");
  await writeFile(fakeNpmPath, fakeNpmCode, "utf8");

  const outputLines = [];
  const child = spawn(process.execPath, [DEV_SYNC_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DEV_SYNC_TEST_STATE_FILE: stateFile,
      DEV_SYNC_TEST_BACKEND_PORT: BACKEND_PORT,
      TEPORA_DEV_SYNC_CARGO_CMD: process.execPath,
      TEPORA_DEV_SYNC_CARGO_PREFIX_ARGS_JSON: JSON.stringify([fakeCargoPath]),
      TEPORA_DEV_SYNC_NPM_CMD: process.execPath,
      TEPORA_DEV_SYNC_NPM_PREFIX_ARGS_JSON: JSON.stringify([fakeNpmPath]),
    },
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

  await waitFor("npm start event", async () => {
    const events = await readEvents(stateFile);
    return events.some((event) => event.proc === "npm" && event.event === "start");
  });

  const eventsAfterStartup = await readEvents(stateFile);
  const cargoStart = eventsAfterStartup.find((event) => event.proc === "cargo" && event.event === "start");
  const npmStart = eventsAfterStartup.find((event) => event.proc === "npm" && event.event === "start");

  assert.ok(cargoStart, "cargo process should be started");
  assert.ok(npmStart, "npm process should be started after backend port capture");
  assert.equal(npmStart.env.VITE_API_PORT, BACKEND_PORT, "VITE_API_PORT should match captured backend port");
  assert.ok(npmStart.env.VITE_API_KEY, "VITE_API_KEY should be injected");
  assert.ok(npmStart.env.VITE_SESSION_TOKEN, "VITE_SESSION_TOKEN should be injected");
  assert.ok(npmStart.argv.includes("--strictPort"), "frontend must be launched with --strictPort");

  await waitFor("ordered startup logs", async () => {
    const capturedIdx = outputLines.findIndex((line) => line.includes("Backend port captured:"));
    const frontendStartIdx = outputLines.findIndex((line) =>
      line.includes("Starting frontend with VITE_API_PORT=")
    );
    return capturedIdx >= 0 && frontendStartIdx > capturedIdx;
  });

  child.kill("SIGINT");
  const { code, signal } = await waitForExit(child);

  const gracefulExit = code === 0 || signal === "SIGINT";
  assert.ok(gracefulExit, "dev_sync should exit gracefully after SIGINT");

  if (process.platform !== "win32") {
    await waitFor("child process signal events", async () => {
      const events = await readEvents(stateFile);
      const cargoSignaled = events.some((event) => event.proc === "cargo" && event.event === "signal");
      const npmSignaled = events.some((event) => event.proc === "npm" && event.event === "signal");
      return cargoSignaled && npmSignaled;
    });
  }
});