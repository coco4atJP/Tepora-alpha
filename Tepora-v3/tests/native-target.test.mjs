import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNodeTarget} from '../scripts/native-target.mjs';

test('Rust core targets match the actual Node process, not merely the Cargo host',()=>{
 for(const [target,platform,arch] of [
  ['aarch64-apple-darwin','darwin','arm64'],['x86_64-apple-darwin','darwin','x64'],
  ['x86_64-pc-windows-msvc','win32','x64'],['aarch64-pc-windows-msvc','win32','arm64'],
  ['x86_64-unknown-linux-gnu','linux','x64'],['aarch64-unknown-linux-gnu','linux','arm64']
 ])assert.equal(assertNodeTarget(target,{platform,arch}),target);
});

test('cross-architecture/cross-OS sidecars fail before packaging a mislabeled Node executable',()=>{
 for(const [target,platform,arch] of [
  ['aarch64-apple-darwin','darwin','x64'],['x86_64-apple-darwin','darwin','arm64'],
  ['x86_64-pc-windows-msvc','linux','x64'],['x86_64-unknown-linux-gnu','win32','x64'],
  ['wasm32-unknown-unknown','linux','x64']
 ])assert.throws(()=>assertNodeTarget(target,{platform,arch}),/does not match Node/);
});
