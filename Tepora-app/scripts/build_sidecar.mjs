import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend-rs");
const FRONTEND_TAURI_DIR = path.join(PROJECT_ROOT, "frontend", "src-tauri");
const BINARIES_DIR = path.join(FRONTEND_TAURI_DIR, "binaries");
const RESOURCES_DIR = path.join(FRONTEND_TAURI_DIR, "resources");
const FALLBACK_DIR = path.join(RESOURCES_DIR, "llama-cpu-fallback");

const REPO_ROOT = path.resolve(PROJECT_ROOT, "..");
const STORAGE_DIR = path.join(REPO_ROOT, "格納");

const EXECUTABLE_NAME = "tepora-backend";

function getTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "arm64") {
      return "aarch64-pc-windows-msvc";
    }
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "darwin") {
    if (arch === "arm64") {
      return "aarch64-apple-darwin";
    }
    return "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    if (arch === "arm64") {
      return "aarch64-unknown-linux-gnu";
    }
    return "x86_64-unknown-linux-gnu";
  }

  throw new Error(`Unsupported platform ${platform} ${arch}`);
}

const TARGET_TRIPLE = getTargetTriple();
const FULL_EXECUTABLE_NAME =
  process.platform === "win32"
    ? `${EXECUTABLE_NAME}-${TARGET_TRIPLE}.exe`
    : `${EXECUTABLE_NAME}-${TARGET_TRIPLE}`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanFallbackDir() {
  if (fs.existsSync(FALLBACK_DIR)) {
    fs.rmSync(FALLBACK_DIR, { recursive: true, force: true });
  }
}

function getFallbackRegex() {
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? /win-cpu-arm64\.zip$/i
      : /win-cpu-x64\.zip$/i;
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? /macos-arm64\.tar\.gz$/i
      : /macos-x64\.tar\.gz$/i;
  }
  return /ubuntu-x64\.tar\.gz$/i;
}

function extractArchive(archivePath) {
  ensureDir(FALLBACK_DIR);

  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path \"${archivePath}\" -DestinationPath \"${FALLBACK_DIR}\" -Force`,
        ],
        { stdio: "inherit" }
      );
    } else {
      execFileSync("unzip", ["-o", archivePath, "-d", FALLBACK_DIR], {
        stdio: "inherit",
      });
    }
    return;
  }

  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", FALLBACK_DIR], {
      stdio: "inherit",
    });
    return;
  }

  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function setupFallbackBinaries() {
  console.log("Setting up fallback binaries...");

  if (!fs.existsSync(STORAGE_DIR)) {
    console.warn(
      `Warning: Storage directory not found at ${STORAGE_DIR}. Skipping fallback setup.`
    );
    return;
  }

  const regex = getFallbackRegex();
  const entries = fs.readdirSync(STORAGE_DIR);
  const archive = entries.find((name) => regex.test(name));

  if (!archive) {
    console.warn(
      `Warning: No matching fallback binary found in ${STORAGE_DIR} for pattern ${regex}`
    );
    return;
  }

  const archivePath = path.join(STORAGE_DIR, archive);
  console.log(`Found fallback archive: ${archivePath}`);

  cleanFallbackDir();
  extractArchive(archivePath);
  console.log(`Extracted fallback binaries to ${FALLBACK_DIR}`);
}

function buildSidecar() {
  setupFallbackBinaries();

  console.log(`Building Rust sidecar for ${TARGET_TRIPLE}...`);
  ensureDir(BINARIES_DIR);

  const buildResult = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", path.join(BACKEND_DIR, "Cargo.toml")],
    { stdio: "inherit" }
  );

  if (buildResult.status !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  const backendBinary = path.join(
    BACKEND_DIR,
    "target",
    "release",
    process.platform === "win32" ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME
  );

  if (!fs.existsSync(backendBinary)) {
    console.error(`Error: backend binary not found at ${backendBinary}`);
    process.exit(1);
  }

  const dstBinary = path.join(BINARIES_DIR, FULL_EXECUTABLE_NAME);
  fs.copyFileSync(backendBinary, dstBinary);
  console.log(`Copied ${backendBinary} to ${dstBinary}`);
  console.log("Build success!");
}

buildSidecar();
