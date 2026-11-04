import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const normalize = source => source.replace(/\r\n/g, '\n');
const workflow = async file => normalize(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
function assertMainWorkflow(source, job) {
  source = normalize(source);
  assert.match(source, /push:\n\s+branches: \['main'\]/);
  assert.match(source, /permissions:\n  contents: read\n/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /pull_request:/);
  assert.doesNotMatch(source, /rust\/v3-core-migration/);
  const block = source.split(`  ${job}:\n`)[1];
  assert.ok(block, `missing ${job} job`);
  assert.doesNotMatch(block, /^    if:/m, 'main and every PR must run the job');
}

const workflows = [['ci.yml', 'regression'], ['tepora-v3-beta.yml', 'native']];
for (const [, job] of workflows) {
  for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${job} workflow assertions accept ${name} line endings and reject legacy skips`, () => {
      const source = [
        'on:', '  workflow_dispatch:', '  push:', "    branches: ['main']", '  pull_request:',
        'permissions:', '  contents: read', 'jobs:', `  ${job}:`, '    runs-on: ubuntu-latest', '',
      ].join(newline);
      assertMainWorkflow(source, job);
      assert.throws(() => assertMainWorkflow(source.replace("['main']", "['rust/v3-core-migration']"), job));
      assert.throws(() => assertMainWorkflow(source.replace('    runs-on:', `    if: false${newline}    runs-on:`), job));
    });
  }
}
for (const [file, job] of workflows) {
  test(`${file} runs for main pushes and all pull requests`, async () => {
    assertMainWorkflow(await workflow(file), job);
  });
}

test('source regression owns quality while packaging keeps standalone and ARM64 coverage', async () => {
  const regression = await workflow('ci.yml'), native = await workflow('tepora-v3-beta.yml');
  assert.match(regression, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(regression, /run: npm run quality/);
  assert.doesNotMatch(regression, /run: npm run test:rust/);
  const standalone = /name: Standalone source regressions\n\s+if: (.+)\n\s+run: \|\n([\s\S]*?)(?=      -)/.exec(native);
  assert.ok(standalone);
  const condition = /^matrix.os == '([^']+)' \|\| github.ref_type == '([^']+)' \|\| github.event_name == '([^']+)'$/.exec(standalone[1]);
  assert.ok(condition, 'keep the standalone source condition explicit');
  for (const os of ['windows-latest', 'macos-latest', 'ubuntu-22.04', 'ubuntu-24.04-arm']) {
    for (const [event, ref] of [['pull_request', 'branch'], ['push', 'branch'], ['push', 'tag'], ['workflow_dispatch', 'branch']]) {
      const enabled = os === condition[1] || ref === condition[2] || event === condition[3];
      assert.equal(enabled, os === 'ubuntu-24.04-arm' || ref === 'tag' || event === 'workflow_dispatch', `${os}/${event}/${ref}`);
    }
  }
  for (const command of ['npm run build:core', 'npm run test:rust', 'npm run build:native', 'npm run test:native', 'node scripts/check.mjs', 'node --test']) {
    assert.ok(standalone[2].includes(command), `missing standalone command: ${command}`);
  }
  assert.match(native, /cargo test --release --locked --bin tepora-v3/);
  for (const script of ['native-smoke.ps1', 'native-smoke.sh', 'native-smoke-linux.sh']) assert.ok(native.includes(script));
});

test('Windows source gates cap fixture concurrency without weakening timeouts', async () => {
  const native = await workflow('tepora-v3-beta.yml');
  const loop = await readFile(new URL('../Tepora-v3/scripts/improve-loop.mjs', import.meta.url), 'utf8');
  assert.match(native, /if \[ "\$RUNNER_OS" = Windows \]; then\n\s+node --import \.\/scripts\/ci-diagnostics\.mjs --test --test-concurrency=1 --test-timeout=120000/);
  assert.match(loop, /process\.platform==='win32'\?\['--import','\.\/scripts\/ci-diagnostics\.mjs','--test','--test-concurrency=1','--test-timeout=120000'\]:\['--test'\]/);
  assert.match(await workflow('ci.yml'), /name: Bound Windows Rust test parallelism\n\s+if: runner\.os == 'Windows'\n\s+run: echo "RUST_TEST_THREADS=2" >> "\$GITHUB_ENV"/);
  assert.match(native, /if \[ "\$RUNNER_OS" = Windows \]; then export RUST_TEST_THREADS=2; fi/);
});
