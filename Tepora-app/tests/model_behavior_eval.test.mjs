import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVariants,
  evaluateCase,
  evaluateVariant,
  parseArgs,
  renderMarkdownReport,
  scoreCheck,
} from "../scripts/model_behavior_eval.mjs";

const dataset = {
  name: "behavior-smoke",
  description: "Fixture dataset for model behavior A/B evaluation.",
  cases: [
    {
      id: "capital_answer",
      prompt: "What is the capital of France?",
      checks: [
        { type: "includes_all", terms: ["Paris"], points: 2 },
        { type: "excludes_all", terms: ["London"], points: 1 },
        { type: "max_length", value: 45, points: 1 },
      ],
    },
    {
      id: "json_answer",
      prompt: "Return JSON with the answer.",
      checks: [
        { type: "json_equals", expected: { answer: "Paris", confidence: "high" }, points: 2 },
        { type: "json_path_equals", path: "answer", expected: "Paris", points: 1 },
      ],
    },
  ],
};

test("parseArgs accepts repeated variants and regression flag", () => {
  const parsed = parseArgs([
    "--dataset",
    "tests/evals/model_behavior.dataset.json",
    "--variant",
    "baseline=tests/evals/model_behavior.baseline.responses.json",
    "--variant",
    "candidate=tests/evals/model_behavior.candidate.responses.json",
    "--baseline",
    "baseline",
    "--candidate",
    "candidate",
    "--fail-on-regression",
  ]);

  assert.equal(parsed.dataset, "tests/evals/model_behavior.dataset.json");
  assert.deepEqual(parsed.variants, [
    { id: "baseline", path: "tests/evals/model_behavior.baseline.responses.json" },
    { id: "candidate", path: "tests/evals/model_behavior.candidate.responses.json" },
  ]);
  assert.equal(parsed.failOnRegression, true);
});

test("scoreCheck supports json_path_equals checks", () => {
  const result = scoreCheck('{"answer":"Paris","confidence":"high"}', {
    type: "json_path_equals",
    path: "answer",
    expected: "Paris",
    points: 3,
  });

  assert.equal(result.passed, true);
  assert.equal(result.pointsEarned, 3);
});

test("evaluateVariant aggregates rubric scores per case", () => {
  const variant = {
    id: "candidate",
    label: "candidate",
    responses: {
      capital_answer: "Paris is the capital of France.",
      json_answer: '{"answer":"Paris","confidence":"high"}',
    },
  };

  const result = evaluateVariant(dataset, variant);

  assert.equal(result.totalScore, 7);
  assert.equal(result.maxScore, 7);
  assert.equal(result.cases[0].score, 4);
  assert.equal(result.cases[1].score, 3);
});

test("compareVariants reports wins and deltas for candidate", () => {
  const baseline = evaluateVariant(dataset, {
    id: "baseline",
    label: "baseline",
    responses: {
      capital_answer: "Paris is the capital of France and a major European city.",
      json_answer: '{"answer":"Paris","confidence":"medium"}',
    },
  });
  const candidate = evaluateVariant(dataset, {
    id: "candidate",
    label: "candidate",
    responses: {
      capital_answer: "Paris is the capital of France.",
      json_answer: '{"answer":"Paris","confidence":"high"}',
    },
  });

  const comparison = compareVariants([baseline, candidate], {
    baseline: "baseline",
    candidate: "candidate",
  });

  assert.equal(comparison.totalDelta, 3);
  assert.equal(comparison.wins, 2);
  assert.equal(comparison.losses, 0);
  assert.equal(comparison.regression, false);
});

test("renderMarkdownReport includes variant and comparison summary", () => {
  const baseline = evaluateVariant(dataset, {
    id: "baseline",
    label: "baseline",
    responses: {
      capital_answer: "Paris is the capital of France and a major European city.",
      json_answer: '{"answer":"Paris","confidence":"medium"}',
    },
  });
  const candidate = evaluateVariant(dataset, {
    id: "candidate",
    label: "candidate",
    responses: {
      capital_answer: "Paris is the capital of France.",
      json_answer: '{"answer":"Paris","confidence":"high"}',
    },
  });

  const markdown = renderMarkdownReport(dataset, {
    variants: [baseline, candidate],
    comparison: compareVariants([baseline, candidate], {
      baseline: "baseline",
      candidate: "candidate",
    }),
  });

  assert.match(markdown, /### Variant Summary/);
  assert.match(markdown, /A\/B Comparison \(candidate vs baseline\)/);
  assert.match(markdown, /\| candidate \| 7\/7 \| 100\.0% \|/);
});

test("evaluateCase marks missing responses", () => {
  const result = evaluateCase(dataset.cases[0], undefined);

  assert.equal(result.missingResponse, true);
  assert.equal(result.score, 2);
  assert.equal(result.maxScore, 4);
});

