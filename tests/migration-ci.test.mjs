import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const [file, job] of [['ci.yml', 'regression'], ['tepora-v3-beta.yml', 'native']]) {
  test(`${file} checks the exact migration push without duplicate PR matrices`, async () => {
    const source = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(source, /push:\n\s+branches: \[main, 'v3\.0-beta\/\*\*', 'rust\/v3-core-migration'\]/);
    assert.match(source, new RegExp(`  ${job}:\\n(?:    #.*\\n)*    if: github.event_name != 'pull_request' \\|\\| github.head_ref != 'rust/v3-core-migration'`));
    assert.match(source, /permissions:\n  contents: read\n/);
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /pull_request:/);
    // Evaluate the exact, deliberately simple guard's truth table.
    const enabled = (event, head = '') => event !== 'pull_request' || head !== 'rust/v3-core-migration';
    assert.equal(enabled('push'), true);
    assert.equal(enabled('workflow_dispatch'), true);
    assert.equal(enabled('pull_request', 'rust/v3-core-migration'), false);
    assert.equal(enabled('pull_request', 'another-feature'), true);
  });
}
