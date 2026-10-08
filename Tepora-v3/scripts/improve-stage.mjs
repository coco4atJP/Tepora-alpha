import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import path from 'node:path';

export const DEFAULT_STAGE_TIMEOUT_MS = 180_000;
// The whole Windows Node suite has measured 212,318 ms in native CI. Allow
// bounded headroom here without changing any individual test's deadline.
export const NODE_SUITE_TIMEOUT_MS = 360_000;

export function stageTimeoutMs(name) {
  return name === 'node-tests' ? NODE_SUITE_TIMEOUT_MS : DEFAULT_STAGE_TIMEOUT_MS;
}

// Injectable effects let unit tests check the real orchestration and reporting
// with a fake clock/process, without starting a long-running child process.
export async function runStage({name, executable, argv, cwd, folder, onChild = () => {}}, {
  spawnProcess = spawn,
  openLog = createWriteStream,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const timeoutMs = stageTimeoutMs(name);
  const log = openLog(path.join(folder, name + '.log')), start = now();
  const result = await new Promise(resolve => {
    const processChild = spawnProcess(executable, argv, {
      cwd, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    onChild(processChild);
    let killTimer = null, finished = false;
    const done = (code, error = null) => {
      if (finished) return;
      finished = true;
      cancel(timer);
      cancel(killTimer);
      resolve({name, code, error, ms: now() - start, timeoutMs});
    };
    const timer = schedule(() => {
      processChild.kill('SIGTERM');
      killTimer = schedule(() => processChild.kill('SIGKILL'), 1500);
      killTimer.unref();
    }, timeoutMs);
    processChild.stdout.pipe(log, {end: false});
    processChild.stderr.pipe(log, {end: false});
    processChild.once('error', error => done(1, error.message));
    processChild.once('close', code => done(code ?? 1));
  });
  await new Promise(resolve => log.end(resolve));
  onChild(null);
  return result;
}
