import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAttempts,
  parseCliArgs,
  projectRoot,
  runSuite,
} from "../scripts/flaky_check.mjs";
import {
  renderMarkdownReport,
  summarizeLane,
} from "../scripts/flaky_quarantine.mjs";

async function withTempDir(callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tepora-flaky-"));
  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("classifyAttempts detects stable pass, flaky, and stable fail", () => {
  assert.deepEqual(classifyAttempts([{ exitCode: 0 }, { exitCode: 0 }]), {
    status: "stable_pass",
    passedRuns: 2,
    failedRuns: 0,
  });
  assert.deepEqual(classifyAttempts([{ exitCode: 0 }, { exitCode: 1 }]), {
    status: "flaky",
    passedRuns: 1,
    failedRuns: 1,
  });
  assert.deepEqual(classifyAttempts([{ exitCode: 1 }, { exitCode: 2 }]), {
    status: "stable_fail",
    passedRuns: 0,
    failedRuns: 2,
  });
});

test("runSuite reports a flaky command across repeated runs", async () => {
  await withTempDir(async (tempDir) => {
    const stateFile = path.join(tempDir, "state.txt");
    const fixturePath = path.join(tempDir, "flaky-fixture.mjs");
    await writeFile(
      fixturePath,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const statePath = process.argv[2];',
        'let count = 0;',
        'try { count = Number(readFileSync(statePath, "utf8")); } catch {}',
        'count += 1;',
        'writeFileSync(statePath, String(count));',
        'process.exit(count % 2 === 0 ? 0 : 1);',
      ].join("\n"),
      "utf8",
    );

    const report = await runSuite({
      label: "fixture-flaky",
      runs: 3,
      cwd: tempDir,
      command: [process.execPath, fixturePath, stateFile],
    });

    assert.equal(report.status, "flaky");
    assert.equal(report.passedRuns, 1);
    assert.equal(report.failedRuns, 2);
  });
});

test("parseCliArgs requires a command and supports optional outputs", () => {
  assert.throws(() => parseCliArgs(["--runs", "3"]), /command is required/i);
  const parsed = parseCliArgs([
    "--label",
    "sample",
    "--runs",
    "4",
    "--cwd",
    "frontend",
    "--json-out",
    "reports/out.json",
    "--",
    "node",
    "--test",
    "tests/dev_sync.e2e.test.mjs",
  ]);

  assert.deepEqual(parsed, {
    label: "sample",
    runs: 4,
    cwd: "frontend",
    jsonOut: "reports/out.json",
    command: ["node", "--test", "tests/dev_sync.e2e.test.mjs"],
  });
});

test("quarantine summary and markdown report reflect flaky suites", () => {
  const reports = [
    { label: "stable", status: "stable_pass", passedRuns: 3, runsRequested: 3 },
    { label: "flaky", status: "flaky", passedRuns: 2, runsRequested: 3 },
  ];

  const summary = summarizeLane(reports);
  assert.deepEqual(summary, {
    overallStatus: "flaky",
    suiteCount: 2,
    counts: {
      stable_pass: 1,
      flaky: 1,
      stable_fail: 0,
    },
  });

  const markdown = renderMarkdownReport(summary, reports);
  assert.match(markdown, /Overall status: flaky/);
  assert.match(markdown, /PASS stable: 3\/3 passing runs/);
  assert.match(markdown, /FLAKY flaky: 2\/3 passing runs/);
});

test("quarantine config is committed with a dev-sync suite", async () => {
  const configPath = path.join(projectRoot, "tests", "flaky", "quarantine-suites.json");
  const payload = JSON.parse(await readFile(configPath, "utf8"));

  assert.equal(payload.suites.length, 1);
  assert.equal(payload.suites[0].label, "dev-sync-e2e");
  assert.deepEqual(payload.suites[0].command, ["node", "--test", "tests/dev_sync.e2e.test.mjs"]);
});
