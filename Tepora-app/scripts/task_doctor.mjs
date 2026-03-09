import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = process.env.TEPORA_DOCTOR_PROJECT_ROOT
  ? path.resolve(process.env.TEPORA_DOCTOR_PROJECT_ROOT)
  : path.resolve(__dirname, "..");

const platform = process.platform;
const minimumNodeMajor = 18;
const defaultNpmCommand = platform === "win32" ? "npm.cmd" : "npm";

function toolEnvKey(tool) {
  return `TEPORA_DOCTOR_${tool}_CMD`;
}

function toolPrefixEnvKey(tool) {
  return `TEPORA_DOCTOR_${tool}_PREFIX_ARGS_JSON`;
}

function resolveToolCommand(tool, fallback) {
  return process.env[toolEnvKey(tool)] || fallback;
}

function resolveToolPrefixArgs(tool) {
  const raw = process.env[toolPrefixEnvKey(tool)];

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function normalizeOutput(text) {
  return text.replace(/\r/g, "").trim();
}

function parseMajorVersion(text) {
  const match = text.match(/v?(\d+)(?:\.\d+)?(?:\.\d+)?/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function quoteWindowsArg(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runTool(tool, fallbackCommand, args, options = {}) {
  const command = resolveToolCommand(tool, fallbackCommand);
  const prefixArgs = resolveToolPrefixArgs(tool);

  return await new Promise((resolve) => {
    const commandArgs = [...prefixArgs, ...args];
    const shouldUseCmdShim = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = shouldUseCmdShim
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [command, ...commandArgs].map(quoteWindowsArg).join(" ")], {
          cwd: projectRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(command, commandArgs, {
          cwd: projectRoot,
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
      resolve({
        ok: false,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(stderr),
        error,
        command,
      });
    });

    child.on("exit", (code) => {
      const ok = options.allowNonZero ? true : code === 0;
      resolve({
        ok,
        code,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(stderr),
        error: null,
        command,
      });
    });
  });
}

function formatToolError(result) {
  if (result.error) {
    return `${result.command}: ${result.error.message}`;
  }

  if (result.stderr) {
    return result.stderr;
  }

  if (typeof result.code === "number") {
    return `Exited with code ${result.code}`;
  }

  return `Unable to run ${result.command}`;
}

function printResult(result) {
  const label = result.status.toUpperCase();
  const detailText = result.detail ? ` (${result.detail})` : "";
  console.log(`[${label}] ${result.title}: ${result.summary}${detailText}`);

  if (result.fix) {
    console.log(`        Fix: ${result.fix}`);
  }
}

function makePath(relativePath) {
  return path.join(projectRoot, ...relativePath.split("/"));
}

const checks = [];

checks.push(async () => {
  const expectedPaths = [
    "backend-rs",
    "backend-rs/Cargo.toml",
    "frontend",
    "frontend/package.json",
    "frontend/src-tauri",
    "Taskfile.yml",
  ];

  const missing = [];

  for (const relativePath of expectedPaths) {
    const exists = await pathExists(makePath(relativePath));
    if (!exists) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    return {
      status: "fail",
      title: "Workspace layout",
      summary: `Missing required paths: ${missing.join(", ")}`,
      fix: "Run the command from Tepora-app or set TEPORA_DOCTOR_PROJECT_ROOT correctly.",
    };
  }

  return {
    status: "pass",
    title: "Workspace layout",
    summary: "backend-rs, frontend, src-tauri, and Taskfile.yml are present",
  };
});

checks.push(async () => {
  const major = parseMajorVersion(process.version);

  if (major === null || major < minimumNodeMajor) {
    return {
      status: "fail",
      title: "Node.js",
      summary: `Detected ${process.version}, but Node.js ${minimumNodeMajor}+ is required`,
      fix: "Install Node.js 18 or newer, then reopen the shell.",
    };
  }

  return {
    status: "pass",
    title: "Node.js",
    summary: `Detected ${process.version}`,
  };
});

checks.push(async () => {
  const npmVersion = await runTool("NPM", defaultNpmCommand, ["--version"]);

  if (!npmVersion.ok) {
    return {
      status: "fail",
      title: "npm",
      summary: "npm is not available",
      detail: formatToolError(npmVersion),
      fix: "Install Node.js with npm and ensure npm is on PATH.",
    };
  }

  return {
    status: "pass",
    title: "npm",
    summary: `Detected ${npmVersion.stdout}`,
  };
});

checks.push(async () => {
  const cargoVersion = await runTool("CARGO", "cargo", ["--version"]);

  if (!cargoVersion.ok) {
    return {
      status: "fail",
      title: "Cargo",
      summary: "Cargo is not available",
      detail: formatToolError(cargoVersion),
      fix: "Install Rust via rustup and ensure cargo is on PATH.",
    };
  }

  const metadata = await runTool("CARGO", "cargo", [
    "metadata",
    "--manifest-path",
    makePath("backend-rs/Cargo.toml"),
    "--no-deps",
    "--format-version",
    "1",
  ]);

  if (!metadata.ok) {
    return {
      status: "fail",
      title: "Cargo",
      summary: `Detected ${cargoVersion.stdout}, but backend manifest resolution failed`,
      detail: formatToolError(metadata),
      fix: "Check the Rust toolchain installation and verify backend-rs/Cargo.toml resolves cleanly.",
    };
  }

  return {
    status: "pass",
    title: "Cargo",
    summary: `Detected ${cargoVersion.stdout} and backend manifest resolves`,
  };
});

checks.push(async () => {
  const rustcVersion = await runTool("RUSTC", "rustc", ["--version"]);

  if (!rustcVersion.ok) {
    return {
      status: "fail",
      title: "rustc",
      summary: "rustc is not available",
      detail: formatToolError(rustcVersion),
      fix: "Install Rust via rustup and ensure rustc is on PATH.",
    };
  }

  return {
    status: "pass",
    title: "rustc",
    summary: `Detected ${rustcVersion.stdout}`,
  };
});

checks.push(async () => {
  const taskVersion = await runTool("TASK", "task", ["--version"]);

  if (!taskVersion.ok) {
    return {
      status: "fail",
      title: "Task",
      summary: "Task runner is not available",
      detail: formatToolError(taskVersion),
      fix: "Install go-task from https://taskfile.dev/ and ensure task is on PATH.",
    };
  }

  const taskList = await runTool("TASK", "task", ["--taskfile", makePath("Taskfile.yml"), "--list"]);

  if (!taskList.ok) {
    return {
      status: "fail",
      title: "Task",
      summary: `Detected ${taskVersion.stdout}, but Tepora Taskfile could not be listed`,
      detail: formatToolError(taskList),
      fix: "Inspect Tepora-app/Taskfile.yml for syntax issues and verify task can read the project directory.",
    };
  }

  return {
    status: "pass",
    title: "Task",
    summary: `Detected ${taskVersion.stdout} and Tepora Taskfile loads`,
  };
});

checks.push(async () => {
  const lockfilePath = makePath("frontend/package-lock.json");
  const hasLockfile = await pathExists(lockfilePath);

  if (!hasLockfile) {
    return {
      status: "warn",
      title: "Frontend lockfile",
      summary: "frontend/package-lock.json is missing",
      fix: "Regenerate the lockfile with npm install from Tepora-app/frontend if it was removed unintentionally.",
    };
  }

  return {
    status: "pass",
    title: "Frontend lockfile",
    summary: "frontend/package-lock.json is present",
  };
});

checks.push(async () => {
  const nodeModulesPath = makePath("frontend/node_modules");
  const hasNodeModules = await pathExists(nodeModulesPath);

  if (!hasNodeModules) {
    return {
      status: "warn",
      title: "Frontend dependencies",
      summary: "frontend/node_modules is missing",
      fix: "Run task install or task install-frontend.",
    };
  }

  return {
    status: "pass",
    title: "Frontend dependencies",
    summary: "frontend/node_modules is present",
  };
});

checks.push(async () => {
  const tauriBinary = platform === "win32"
    ? makePath("frontend/node_modules/.bin/tauri.cmd")
    : makePath("frontend/node_modules/.bin/tauri");
  const hasTauriBinary = await pathExists(tauriBinary);

  if (!hasTauriBinary) {
    return {
      status: "warn",
      title: "Tauri CLI",
      summary: "Local Tauri CLI binary is missing from frontend/node_modules/.bin",
      fix: "Run task install-frontend to install the frontend toolchain.",
    };
  }

  return {
    status: "pass",
    title: "Tauri CLI",
    summary: "Local Tauri CLI binary is present",
  };
});

checks.push(async () => {
  const npmConfig = await runTool("NPM", defaultNpmCommand, ["config", "get", "legacy-peer-deps"]);

  if (!npmConfig.ok) {
    return {
      status: "warn",
      title: "npm legacy-peer-deps",
      summary: "Could not read npm legacy-peer-deps setting",
      detail: formatToolError(npmConfig),
      fix: "Run npm config get legacy-peer-deps manually if installs behave unexpectedly.",
    };
  }

  const value = npmConfig.stdout.toLowerCase();

  if (value === "true") {
    return {
      status: "warn",
      title: "npm legacy-peer-deps",
      summary: "legacy-peer-deps is enabled",
      fix: "Run npm config delete legacy-peer-deps so Tepora uses the normal dependency resolver.",
    };
  }

  return {
    status: "pass",
    title: "npm legacy-peer-deps",
    summary: `Configured as ${npmConfig.stdout || "false"}`,
  };
});

console.log("Tepora doctor");
console.log(`Project root: ${projectRoot}`);
console.log("");

let passed = 0;
let warned = 0;
let failed = 0;

for (const runCheck of checks) {
  const result = await runCheck();
  printResult(result);

  if (result.status === "pass") {
    passed += 1;
  } else if (result.status === "warn") {
    warned += 1;
  } else {
    failed += 1;
  }
}

console.log("");
console.log(`Summary: ${passed} passed, ${warned} warnings, ${failed} failures`);

if (failed > 0) {
  console.log("Doctor status: FAIL");
  process.exitCode = 1;
} else if (warned > 0) {
  console.log("Doctor status: WARN");
} else {
  console.log("Doctor status: OK");
}