const CONVENTIONAL_COMMIT_PATTERN = /^(?<type>feat|fix|docs|refactor|perf|test|build|ci|chore|style|revert)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<description>.+)$/u;

const RELEASE_SECTION_BY_TYPE = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  build: "Changed",
  ci: "Changed",
  chore: "Changed",
  style: "Changed",
  docs: "Docs",
  test: "Internal",
  revert: "Changed",
};

const SECTION_ORDER = ["Breaking", "Added", "Fixed", "Changed", "Docs", "Internal", "Other"];

export function isSkippableCommitMessage(subject) {
  return /^Merge /u.test(subject) || /^Initial commit$/u.test(subject);
}

export function parseConventionalCommit(subject) {
  const trimmed = subject.trim();

  if (!trimmed || isSkippableCommitMessage(trimmed)) {
    return null;
  }

  const match = trimmed.match(CONVENTIONAL_COMMIT_PATTERN);
  if (!match?.groups) {
    return {
      raw: trimmed,
      valid: false,
      type: null,
      scope: null,
      description: trimmed,
      breaking: false,
      section: "Other",
    };
  }

  const { type, scope, description, breaking } = match.groups;
  return {
    raw: trimmed,
    valid: true,
    type,
    scope: scope ?? null,
    description,
    breaking: Boolean(breaking),
    section: RELEASE_SECTION_BY_TYPE[type] ?? "Other",
  };
}

export function formatCommitForRelease(commit) {
  const scopePrefix = commit.scope ? `**${commit.scope}:** ` : "";
  return `- ${scopePrefix}${commit.description}`;
}

export function buildReleaseNotes(commits, options = {}) {
  const version = options.version ?? null;
  const title = version ? `## ${version}` : "## Release Notes";
  const grouped = new Map(SECTION_ORDER.map((section) => [section, []]));

  for (const commit of commits) {
    const parsed = typeof commit === "string" ? parseConventionalCommit(commit) : commit;
    if (!parsed || isSkippableCommitMessage(parsed.raw ?? "")) {
      continue;
    }

    if (parsed.breaking) {
      grouped.get("Breaking").push(formatCommitForRelease(parsed));
    }

    grouped.get(parsed.section ?? "Other").push(formatCommitForRelease(parsed));
  }

  const lines = [title, ""];

  for (const section of SECTION_ORDER) {
    const entries = grouped.get(section);
    if (!entries || entries.length === 0) {
      continue;
    }

    lines.push(`### ${section}`);
    lines.push(...entries);
    lines.push("");
  }

  if (lines.length === 2) {
    lines.push("No conventional commits found for this range.", "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function collectInvalidCommitMessages(commits) {
  const invalid = [];

  for (const commit of commits) {
    const parsed = typeof commit === "string" ? parseConventionalCommit(commit) : commit;
    if (!parsed) {
      continue;
    }

    if (!parsed.valid) {
      invalid.push(parsed.raw);
    }
  }

  return invalid;
}