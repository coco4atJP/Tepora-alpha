import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend-rs");
const BACKEND_BIN = path.join(
  BACKEND_DIR,
  "target",
  "debug",
  process.platform === "win32" ? "tepora-backend.exe" : "tepora-backend"
);
const OUTPUT_PATH = process.env.TEPORA_PERF_OUTPUT
  ? path.resolve(process.env.TEPORA_PERF_OUTPUT)
  : path.join(__dirname, "perf-results.json");
const ITERATIONS = Number(process.env.TEPORA_PERF_ITERATIONS ?? "15");

const PORT_PATTERN = /TEPORA_PORT=(\d+)/;
const WS_APP_PROTOCOL = "tepora.v1";
const WS_TOKEN_PREFIX = "tepora-token.";
const execFileAsync = promisify(execFile);

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile95(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

async function readRssMb(pid) {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!match) {
        return null;
      }
      const kb = Number(match[1]);
      return kb / 1024;
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("tasklist", [
        "/FI",
        `PID eq ${pid}`,
        "/FO",
        "CSV",
        "/NH",
      ]);
      const line = stdout.trim();
      if (!line || line.startsWith("INFO:")) {
        return null;
      }
      const fields = line.replace(/^"|"$/g, "").split('","');
      if (fields.length < 5) {
        return null;
      }
      const kb = Number(fields[4].replace(/[^0-9]/g, ""));
      if (!Number.isFinite(kb) || kb <= 0) {
        return null;
      }
      return kb / 1024;
    } catch {
      return null;
    }
  }

  return null;
}

function waitForBackendPort(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const complete = (value, error) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onLine = (line) => {
      const match = PORT_PATTERN.exec(line);
      if (!match) {
        return;
      }
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0) {
        complete(port, null);
      }
    };

    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    stdout.on("line", onLine);
    stderr.on("line", onLine);

    child.once("error", (error) => complete(null, error));
    child.once("exit", (code) => {
      complete(null, new Error(`backend exited before port capture (code=${code})`));
    });

    const timer = setTimeout(() => {
      complete(null, new Error("timeout waiting for backend port"));
    }, timeoutMs);
  });
}

function runPerfProbe({ port, token, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const tokenHex = Buffer.from(token, "utf8").toString("hex");
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WS_APP_PROTOCOL, `${WS_TOKEN_PREFIX}${tokenHex}`],
      {
        headers: {
          Origin: "http://localhost:5173",
        },
      }
    );

    let sendAt = 0;
    let ttftMs = null;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for perf_probe response"));
    }, timeoutMs);

    ws.on("open", () => {
      sendAt = nowMs();
      ws.send(JSON.stringify({ type: "perf_probe", sessionId: "perf-probe-ci" }));
    });

    ws.on("message", (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (payload.type === "chunk" && ttftMs === null) {
        ttftMs = nowMs() - sendAt;
      }

      if (payload.type === "done") {
        clearTimeout(timer);
        ws.close();
        if (ttftMs === null) {
          reject(new Error("perf_probe completed without chunk"));
          return;
        }
        resolve(ttftMs);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runIteration(iteration) {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "tepora-perf-probe-"));
  const token = crypto.randomBytes(24).toString("base64url");

  const child = spawn(BACKEND_BIN, [], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      RUST_LOG: process.env.RUST_LOG ?? "error",
      TEPORA_ENV: "development",
      TEPORA_PORT: "0",
      TEPORA_SESSION_TOKEN: token,
      TEPORA_PERF_PROBE_ENABLED: "1",
      TEPORA_DATA_DIR: tempDataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let peakRssMb = 0;
  const rssTimer = setInterval(async () => {
    const rssMb = await readRssMb(child.pid);
    if (rssMb !== null && rssMb > peakRssMb) {
      peakRssMb = rssMb;
    }
  }, 80);

  const startedAt = nowMs();
  try {
    const port = await waitForBackendPort(child);
    const startupMs = nowMs() - startedAt;
    const ttftMs = await runPerfProbe({ port, token });

    child.kill("SIGINT");
    await waitForExit(child);

    return {
      iteration,
      startup_ms: round(startupMs),
      ttft_ms: round(ttftMs),
      peak_rss_mb: round(peakRssMb),
    };
  } finally {
    clearInterval(rssTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await rm(tempDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!Number.isInteger(ITERATIONS) || ITERATIONS <= 0) {
    throw new Error(`Invalid TEPORA_PERF_ITERATIONS value: ${ITERATIONS}`);
  }

  console.log(`[perf] building backend binary in ${BACKEND_DIR}`);
  const cargoCmd = process.env.CARGO ?? "cargo";
  await runCommand(cargoCmd, ["build", "--bin", "tepora-backend"], { cwd: BACKEND_DIR });

  const samples = [];
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    console.log(`[perf] iteration ${iteration}/${ITERATIONS}`);
    const sample = await runIteration(iteration);
    samples.push(sample);
    console.log(
      `[perf] startup=${sample.startup_ms}ms ttft=${sample.ttft_ms}ms peak_rss=${sample.peak_rss_mb}MB`
    );
  }

  const p95 = {
    startup_ms: round(percentile95(samples.map((s) => s.startup_ms))),
    ttft_ms: round(percentile95(samples.map((s) => s.ttft_ms))),
    peak_rss_mb: round(percentile95(samples.map((s) => s.peak_rss_mb))),
  };

  const result = {
    collected_at: new Date().toISOString(),
    iterations: ITERATIONS,
    samples,
    p95,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`[perf] wrote report: ${OUTPUT_PATH}`);
  console.log(
    `[perf] p95 startup=${p95.startup_ms}ms ttft=${p95.ttft_ms}ms peak_rss=${p95.peak_rss_mb}MB`
  );
}

main().catch((error) => {
  console.error("[perf] failed:", error);
  process.exit(1);
});
