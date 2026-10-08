import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {DEFAULT_STAGE_TIMEOUT_MS, NODE_SUITE_TIMEOUT_MS, runStage, stageTimeoutMs} from '../scripts/improve-stage.mjs';

function fixture(name = 'node-tests') {
  let clock = 1000;
  const timers = [], signals = [], children = [], pipes = [], spawns = [];
  const log = {ended: false, end(done) { this.ended = true; done(); }};
  const child = new EventEmitter();
  for (const stream of ['stdout', 'stderr']) {
    child[stream] = {pipe(target, options) { pipes.push({stream, target, options}); }};
  }
  child.kill = signal => { signals.push(signal); return true; };
  const argv = ['--import', './scripts/ci-diagnostics.mjs', '--test', '--test-timeout=120000'];
  const cwd = path.resolve('fixture-source'), folder = path.resolve('fixture-evidence');
  const result = runStage({name, executable: 'fixture-node', argv, cwd, folder, onChild: value => children.push(value)}, {
    spawnProcess(executable, args, options) { spawns.push({executable, args, options}); return child; },
    openLog(file) { assert.equal(file, path.join(folder, name + '.log')); return log; },
    now: () => clock,
    schedule(callback, delay) {
      const timer = {callback, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; }};
      timers.push(timer);
      return timer;
    },
    cancel(timer) { if (timer) timer.cleared = true; },
  });
  return {result, child, argv, cwd, log, timers, signals, children, pipes, spawns,
    elapsed(ms) { clock = 1000 + ms; },
  };
}

test('only the whole Node suite receives the explicit six-minute budget', () => {
  assert.equal(NODE_SUITE_TIMEOUT_MS, 360_000);
  assert.equal(DEFAULT_STAGE_TIMEOUT_MS, 180_000);
  assert.equal(stageTimeoutMs('node-tests'), 360_000);
  for (const name of [
    'rust-build', 'rust-tests', 'native-service-build', 'native-service-tests', 'syntax',
    'worker-contracts', 'scenario-traceability', 'preview-build', 'browser-first-use',
    'browser-routing', 'browser-lamp', 'browser-avatar', 'browser-abilities',
    'browser-ability-components', 'capability-live', 'computer-live', 'future-stage',
  ]) assert.equal(stageTimeoutMs(name), 180_000, name);
});

test('Node stage keeps its command settings and reports measured elapsed time, not the budget', async () => {
  const f = fixture();
  assert.equal(f.timers[0].delay, 360_000);
  assert.deepEqual(f.spawns, [{executable: 'fixture-node', args: f.argv, options: {
    cwd: f.cwd, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  }}]);
  assert.deepEqual(f.children, [f.child]);
  assert.deepEqual(f.pipes, ['stdout', 'stderr'].map(stream => ({stream, target: f.log, options: {end: false}})));
  f.elapsed(212_318);
  f.child.emit('close', 0);
  const result = await f.result;
  assert.deepEqual(result, {name: 'node-tests', code: 0, error: null, ms: 212_318, timeoutMs: 360_000});
  assert.deepEqual(JSON.parse(JSON.stringify({results: [result]})).results, [result]);
  assert.equal(f.log.ended, true);
  assert.equal(f.timers[0].cleared, true);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.children, [f.child, null]);
});

for (const [name, budget] of [['node-tests', 360_000], ['syntax', 180_000]]) {
  test(`${name} still terminates at its bounded budget and keeps the 1.5-second kill grace`, async () => {
    const f = fixture(name);
    assert.equal(f.timers[0].delay, budget);
    f.elapsed(budget);
    f.timers[0].callback();
    assert.deepEqual(f.signals, ['SIGTERM']);
    assert.equal(f.timers[1].delay, 1500);
    assert.equal(f.timers[1].unrefed, true);
    f.elapsed(budget + 1500);
    f.timers[1].callback();
    assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
    f.child.emit('close', null);
    assert.deepEqual(await f.result, {name, code: 1, error: null, ms: budget + 1500, timeoutMs: budget});
    assert.equal(f.timers.every(timer => timer.cleared), true);
  });
}

test('a stage closing after SIGTERM clears the pending SIGKILL timer', async () => {
  const f = fixture();
  f.elapsed(360_000);
  f.timers[0].callback();
  f.elapsed(360_007);
  f.child.emit('close', null);
  assert.equal((await f.result).ms, 360_007);
  assert.equal(f.timers[1].cleared, true);
  assert.deepEqual(f.signals, ['SIGTERM']);
});

test('nonzero exit codes remain failures and keep their actual elapsed time', async () => {
  const f = fixture('worker-contracts');
  f.elapsed(37);
  f.child.emit('close', 9);
  assert.deepEqual(await f.result, {name: 'worker-contracts', code: 9, error: null, ms: 37, timeoutMs: 180_000});
  assert.equal(f.timers[0].cleared, true);
});

test('spawn errors are reported once, with timer cleanup and their measured duration', async () => {
  const f = fixture();
  f.elapsed(12);
  f.child.emit('error', new Error('fixture could not start'));
  f.elapsed(17);
  f.child.emit('close', 0);
  assert.deepEqual(await f.result, {name: 'node-tests', code: 1, error: 'fixture could not start', ms: 12, timeoutMs: 360_000});
  assert.equal(f.timers[0].cleared, true);
  assert.deepEqual(f.children, [f.child, null]);
});
