import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReleaseNotes, collectInvalidCommitMessages, parseConventionalCommit } from "../scripts/conventional_commits.mjs";

test("parseConventionalCommit parses scope and breaking marker", () => {
  const parsed = parseConventionalCommit("feat(ui)!: add release timeline");

  assert.ok(parsed);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.type, "feat");
  assert.equal(parsed.scope, "ui");
  assert.equal(parsed.breaking, true);
  assert.equal(parsed.section, "Added");
});

test("collectInvalidCommitMessages returns only non-conventional subjects", () => {
  const invalid = collectInvalidCommitMessages([
    "feat(ui): add release timeline",
    "bad commit message",
    "Merge branch 'main'",
  ]);

  assert.deepEqual(invalid, ["bad commit message"]);
});

test("buildReleaseNotes groups conventional commits by section", () => {
  const notes = buildReleaseNotes([
    parseConventionalCommit("feat(ui): add model tags"),
    parseConventionalCommit("fix(backend): resolve token refresh"),
    parseConventionalCommit("docs: update dev guide"),
    parseConventionalCommit("refactor(core)!: simplify release pipeline"),
  ], { version: "v0.5.0" });

  assert.match(notes, /## v0\.5\.0/);
  assert.match(notes, /### Breaking/);
  assert.match(notes, /### Added/);
  assert.match(notes, /### Fixed/);
  assert.match(notes, /### Docs/);
  assert.match(notes, /\*\*core:\*\* simplify release pipeline/);
});