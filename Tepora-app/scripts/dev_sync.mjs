import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend-rs");
const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");

const PORT_PATTERN = /TEPORA_PORT=(\d+)/;

let backendProcess = null;
let frontendProcess = null;
let shuttingDown = false;

function log(prefix, message) {
  process.stdout.write(`[${prefix}] ${message}\n`);
}

function terminateProcess(processHandle, name) {
  if (!processHandle || processHandle.killed) {
    return;
  }
  try {
    processHandle.kill();
  } catch (err) {
    log("dev-sync", `Failed to terminate ${name}: ${err}`);
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("dev-sync", "Shutting down...");
  terminateProcess(frontendProcess, "frontend");
  terminateProcess(backendProcess, "backend");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  log("dev-sync", "Starting backend server (dynamic port)...");

  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const backendEnv = { ...process.env };
  delete backendEnv.PORT;
  backendEnv.TEPORA_SESSION_TOKEN = sessionToken;

  backendProcess = spawn(
    "cargo",
    ["run", "--manifest-path", path.join(BACKEND_DIR, "Cargo.toml")],
    {
      cwd: BACKEND_DIR,
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const backendStdout = readline.createInterface({ input: backendProcess.stdout });
  const backendStderr = readline.createInterface({ input: backendProcess.stderr });

  let capturedPort = null;

  function maybeStartFrontend(port) {
    if (frontendProcess || !port) {
      return;
    }

    log("dev-sync", `Starting frontend with VITE_API_PORT=${port}...`);

    const frontendEnv = { ...process.env };
    frontendEnv.VITE_API_PORT = String(port);
    frontendEnv.VITE_API_KEY = sessionToken;
    frontendEnv.VITE_SESSION_TOKEN = sessionToken;

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    frontendProcess = spawn(npmCmd, ["run", "dev"], {
      cwd: FRONTEND_DIR,
      env: frontendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    readline.createInterface({ input: frontendProcess.stdout }).on("line", (line) => {
      log("frontend", line);
    });

    readline.createInterface({ input: frontendProcess.stderr }).on("line", (line) => {
      log("frontend", line);
    });

    log("dev-sync", "Development servers running:");
    log("dev-sync", `Backend:  http://localhost:${port}`);
    log("dev-sync", "Frontend: http://localhost:5173");
    log("dev-sync", "Auth:     session token injected via env");
    log("dev-sync", "Press Ctrl+C to stop");
  }

  backendStdout.on("line", (line) => {
    log("backend", line);
    if (!capturedPort) {
      const match = PORT_PATTERN.exec(line);
      if (match) {
        capturedPort = Number(match[1]);
        log("dev-sync", `Backend port captured: ${capturedPort}`);
        maybeStartFrontend(capturedPort);
      }
    }
  });

  backendStderr.on("line", (line) => {
    log("backend", line);
  });

  backendProcess.on("exit", () => {
    log("dev-sync", "Backend process exited.");
    shutdown();
  });
}

main().catch((err) => {
  log("dev-sync", `Fatal error: ${err}`);
  shutdown();
});
