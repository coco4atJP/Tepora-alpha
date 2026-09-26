import { realpath, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
export const LIMITS = Object.freeze({body: 12 * 1024 * 1024, text: 32000, output: 100000, steps: 12, events: 5000});
export function invariant(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), {status});
}
export function text(value, name = 'text', max = LIMITS.text) {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name}: 1–${max} characters required`);
  return value.trim();
}
export function endpoint(value, allowCloud = false) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Invalid endpoint URL'), {status:400}); }
  invariant(!url.username && !url.password && !url.hash && !url.search, 'Credentials, query strings and fragments are not allowed in an endpoint');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  invariant(local || allowCloud, 'External connections are disabled. Enable network consent first.', 403);
  invariant(url.protocol === 'https:' || (local && url.protocol === 'http:'), 'Use HTTPS, or HTTP on loopback only');
  return url;
}
export function webURL(value) {
  const url = new URL(value);
  invariant(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'Only ordinary HTTP(S) URLs are supported');
  return url;
}
export async function workspacePath(root, relative, write = false) {
  text(relative, 'path', 500);
  invariant(!path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0') && !relative.includes(':') && !relative.split('/').includes('..'), 'Path must stay inside the workspace');
  await mkdir(root, {recursive: true});
  const base = await realpath(root);
  const target = path.resolve(base, relative);
  invariant(target.startsWith(base + path.sep), 'Workspace root is not a file');
  // Refuse every symbolic-link component, including the final file. No model-controlled mount traversal.
  let cursor = base;
  for (const segment of relative.split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { invariant(!(await lstat(cursor)).isSymbolicLink(), 'Symbolic links are not permitted'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (write) await mkdir(path.dirname(target), {recursive:true});
  return target;
}
export function safeError(error) {
  return String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 600);
}
export function validateSettings(input, previous) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'Settings must be an object');
  const s = structuredClone(previous);
  for (const key of ['companion', 'model', 'provider', 'baseUrl', 'asrUrl', 'asrModel', 'decisionUrl', 'decisionModel', 'apiKeyEnv', 'weatherCity', 'newsUrl', 'runtimeBinary', 'modelPath', 'bravePath']) {
    if (key in input) { invariant(typeof input[key] === 'string' && input[key].length < 2000, `Invalid ${key}`); s[key] = input[key].trim(); }
  }
  for (const key of ['allowCloud', 'allowNetwork', 'shareMemory', 'voiceEnabled', 'autoAmbient']) if (key in input) { invariant(typeof input[key] === 'boolean', `Invalid ${key}`); s[key] = input[key]; }
  for (const [key, min, max] of [['maxSteps',1,12], ['maxTokens',128,8192], ['concurrency',1,4]]) if (key in input) { invariant(Number.isInteger(input[key]) && input[key] >= min && input[key] <= max, `Invalid ${key}`); s[key] = input[key]; }
  if (s.baseUrl) endpoint(s.baseUrl, s.allowCloud);
  if (s.asrUrl) endpoint(s.asrUrl, s.allowCloud);
  if (s.decisionUrl) endpoint(s.decisionUrl, s.allowCloud);
  if (s.newsUrl) endpoint(s.newsUrl, s.allowNetwork);
  invariant(!s.apiKeyEnv || /^[A-Z_][A-Z0-9_]{0,100}$/.test(s.apiKeyEnv), 'Invalid environment variable name');
  invariant(['llama.cpp','vllm','ollama','lmstudio','compatible'].includes(s.provider), 'Unknown provider');
  return s;
}
export const DEFAULT_SETTINGS = Object.freeze({companion:'Tepora', provider:'llama.cpp', baseUrl:'http://127.0.0.1:8080/v1', model:'', apiKeyEnv:'', allowCloud:false, allowNetwork:false, shareMemory:false, maxSteps:8, maxTokens:2048, concurrency:2, asrUrl:'', asrModel:'Qwen/Qwen3-ASR-1.7B', decisionUrl:'', decisionModel:'diffusiongemma', voiceEnabled:true, autoAmbient:false, weatherCity:'', newsUrl:'', runtimeBinary:'', modelPath:'', bravePath:''});
