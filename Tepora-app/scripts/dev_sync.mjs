import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend-rs");
const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");

const PORT_PATTERN = /TEPORA_PORT=(\d+)/;

function parseJsonArrayEnv(raw, variableName) {
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} must be a JSON array of strings.`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${variableName} must be a JSON array of strings.`);
  }

  return parsed;
}

export function parseBackendPort(line) {
  const match = PORT_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

export function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to reserve frontend port")));
        return;
      }

      const { port } = addr;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

export function createDevSyncRunner(options = {}) {
  const spawnCommand = options.spawnCommand ?? nodeSpawn;
  const createLineInterface =
    options.createLineInterface ?? ((input) => readline.createInterface({ input }));
  const reservePort = options.reservePort ?? reserveEphemeralPort;
  const processLike = options.processLike ?? process;
  const log =
    options.log ??
    ((prefix, message) => {
      processLike.stdout.write(`[${prefix}] ${message}\n`);
    });

  let backendProcess = null;
  let frontendProcess = null;
  let shuttingDown = false;
  let signalHandlersRegistered = false;

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

  function shutdown(exitCode = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log("dev-sync", "Shutting down...");
    terminateProcess(frontendProcess, "frontend");
    terminateProcess(backendProcess, "backend");
    processLike.exit(exitCode);
  }

  function registerSignalHandlers() {
    if (signalHandlersRegistered) {
      return;
    }

    signalHandlersRegistered = true;
    processLike.on("SIGINT", () => shutdown(0));
    processLike.on("SIGTERM", () => shutdown(0));
  }

  function buildBackendSpawnConfig(sessionToken) {
    const backendEnv = { ...processLike.env };
    delete backendEnv.PORT;
    backendEnv.TEPORA_PORT = "0";
    backendEnv.TEPORA_SESSION_TOKEN = sessionToken;

    const backendCommand = backendEnv.TEPORA_DEV_SYNC_CARGO_CMD ?? "cargo";
    const backendPrefixArgs = parseJsonArrayEnv(
      backendEnv.TEPORA_DEV_SYNC_CARGO_PREFIX_ARGS_JSON,
      "TEPORA_DEV_SYNC_CARGO_PREFIX_ARGS_JSON"
    );
    const backendArgs = [
      ...backendPrefixArgs,
      "run",
      "--bin",
      "tepora-backend",
      "--manifest-path",
      path.join(BACKEND_DIR, "Cargo.toml"),
    ];

    return {
      command: backendCommand,
      args: backendArgs,
      options: {
        cwd: BACKEND_DIR,
        env: backendEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    };
  }

  function buildFrontendSpawnConfig({ backendPort, frontendPort, sessionToken }) {
    const frontendEnv = { ...processLike.env };
    frontendEnv.VITE_API_PORT = String(backendPort);
    frontendEnv.VITE_API_KEY = sessionToken;
    frontendEnv.VITE_SESSION_TOKEN = sessionToken;

    const customNpmCommand = frontendEnv.TEPORA_DEV_SYNC_NPM_CMD;
    const frontendCommand =
      customNpmCommand ?? (processLike.platform === "win32" ? "npm.cmd" : "npm");
    const frontendPrefixArgs = parseJsonArrayEnv(
      frontendEnv.TEPORA_DEV_SYNC_NPM_PREFIX_ARGS_JSON,
      "TEPORA_DEV_SYNC_NPM_PREFIX_ARGS_JSON"
    );
    const frontendArgs = [
      ...frontendPrefixArgs,
      "run",
      "dev",
      "--",
      "--port",
      String(frontendPort),
      "--strictPort",
    ];

    return {
      command: frontendCommand,
      args: frontendArgs,
      options: {
        cwd: FRONTEND_DIR,
        env: frontendEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: !customNpmCommand && processLike.platform === "win32",
      },
    };
  }

  async function run() {
    registerSignalHandlers();
    log("dev-sync", "Starting backend server (dynamic port)...");

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const backendConfig = buildBackendSpawnConfig(sessionToken);

    backendProcess = spawnCommand(backendConfig.command, backendConfig.args, backendConfig.options);

    const backendStdout = createLineInterface(backendProcess.stdout);
    const backendStderr = createLineInterface(backendProcess.stderr);

    let capturedPort = null;

    async function maybeStartFrontend(port) {
      if (frontendProcess || !port) {
        return;
      }

      let frontendPort;
      try {
        frontendPort = await reservePort();
      } catch (err) {
        log("dev-sync", `Failed to reserve frontend port: ${err}`);
        shutdown(1);
        return;
      }

      log(
        "dev-sync",
        `Starting frontend with VITE_API_PORT=${port} and VITE_PORT=${frontendPort}...`
      );

      const frontendConfig = buildFrontendSpawnConfig({
        backendPort: port,
        frontendPort,
        sessionToken,
      });

      frontendProcess = spawnCommand(
        frontendConfig.command,
        frontendConfig.args,
        frontendConfig.options
      );

      createLineInterface(frontendProcess.stdout).on("line", (line) => {
        log("frontend", line);
      });

      createLineInterface(frontendProcess.stderr).on("line", (line) => {
        log("frontend", line);
      });

      frontendProcess.on("error", (err) => {
        log("dev-sync", `Frontend process error: ${err}`);
        shutdown(1);
      });

      log("dev-sync", "Development servers running:");
      log("dev-sync", `Backend:  http://localhost:${port}`);
      log("dev-sync", `Frontend: http://localhost:${frontendPort}`);
      log("dev-sync", "Auth:     session token injected via env");
      log("dev-sync", "Press Ctrl+C to stop");
    }

    function checkForPort(line) {
      if (capturedPort) {
        return;
      }

      const parsedPort = parseBackendPort(line);
      if (parsedPort !== null) {
        capturedPort = parsedPort;
        log("dev-sync", `Backend port captured: ${capturedPort}`);
        void maybeStartFrontend(capturedPort);
      }
    }

    backendStdout.on("line", (line) => {
      log("backend", line);
      checkForPort(line);
    });

    backendStderr.on("line", (line) => {
      log("backend", line);
      checkForPort(line);
    });

    backendProcess.on("error", (err) => {
      log("dev-sync", `Backend process error: ${err}`);
      shutdown(1);
    });

    backendProcess.on("exit", (code) => {
      log("dev-sync", "Backend process exited.");
      shutdown(typeof code === "number" ? code : 0);
    });
  }

  return {
    run,
    shutdown,
  };
}

function isDirectExecution() {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return pathToFileURL(path.resolve(entryPoint)).href === import.meta.url;
}

async function runCli() {
  const runner = createDevSyncRunner();

  try {
    await runner.run();
  } catch (err) {
    process.stdout.write(`[dev-sync] Fatal error: ${err}\n`);
    runner.shutdown(1);
  }
}

if (isDirectExecution()) {
  void runCli();
}