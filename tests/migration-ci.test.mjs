import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function assertMigrationWorkflow(source, job) {
  // Git may check out the same workflow with Windows line endings.
  source = source.replace(/\r\n/g, '\n');
  assert.match(source, /push:\n\s+branches: \['rust\/v3-core-migration'\]/);
  assert.match(source, new RegExp(`  ${job}:\\n(?:    #.*\\n)*    if: github.event_name != 'pull_request' \\|\\| github.head_ref != 'rust/v3-core-migration'`));
  assert.match(source, /permissions:\n  contents: read\n/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /pull_request:/);
}

const workflows = [['ci.yml', 'regression'], ['tepora-v3-beta.yml', 'native']];
for (const [, job] of workflows) {
  for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${job} workflow assertions accept ${name} line-ending fixtures`, () => {
      const source = [
        'on:',
        '  workflow_dispatch:',
        '  push:',
        "    branches: ['rust/v3-core-migration']",
        '  pull_request:',
        'permissions:',
        '  contents: read',
        'jobs:',
        `  ${job}:`,
        '    # Check the exact migration push.',
        '    # Avoid duplicate pull request matrices.',
        "    if: github.event_name != 'pull_request' || github.head_ref != 'rust/v3-core-migration'",
        '    runs-on: ubuntu-latest',
        '',
      ].join(newline);
      assertMigrationWorkflow(source, job);
    });
  }
}

for (const [file, job] of workflows) {
  test(`${file} checks the exact migration push without duplicate PR matrices`, async () => {
    const source = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assertMigrationWorkflow(source, job);
    // Evaluate the exact, deliberately simple guard's truth table.
    const enabled = (event, head = '') => event !== 'pull_request' || head !== 'rust/v3-core-migration';
    assert.equal(enabled('push'), true);
    assert.equal(enabled('workflow_dispatch'), true);
    assert.equal(enabled('pull_request', 'rust/v3-core-migration'), false);
    assert.equal(enabled('pull_request', 'another-feature'), true);
  });
}


test('both Windows Node gates cap heavy fixture concurrency without weakening timeouts', async () => {
  const native = await readFile(new URL('../.github/workflows/tepora-v3-beta.yml', import.meta.url), 'utf8');
  const loop = await readFile(new URL('../Tepora-v3/scripts/improve-loop.mjs', import.meta.url), 'utf8');
  assert.match(native, /node --import \.\/scripts\/ci-diagnostics\.mjs --test --test-concurrency=1 --test-timeout=120000/);
  assert.match(loop, /process\.platform==='win32'\?\['--import','\.\/scripts\/ci-diagnostics\.mjs','--test','--test-concurrency=1','--test-timeout=120000'\]:\['--test'\]/);
});


test('both Windows gates bound Rust fixture threads without changing Rust assertions', async () => {
  for (const [file] of workflows) {
    const source = (await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(source, /name: Bound Windows Rust test parallelism\n\s+if: runner\.os == 'Windows'\n\s+run: echo "RUST_TEST_THREADS=2" >> "\$GITHUB_ENV"/);
  }
});
