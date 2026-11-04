import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNodeTarget,assertPackagingTarget} from '../scripts/native-target.mjs';

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

test('desktop packaging accepts Windows, macOS and glibc Linux on x64/arm64',()=>{
 for(const target of ['x86_64-pc-windows-msvc','aarch64-pc-windows-msvc','x86_64-apple-darwin','aarch64-apple-darwin','x86_64-unknown-linux-gnu','aarch64-unknown-linux-gnu'])
  assert.equal(assertPackagingTarget(target),target);
});

test('desktop packaging rejects targets without a matching sidecar build',()=>{
 for(const target of ['x86_64-unknown-linux-musl','armv7-unknown-linux-gnueabihf','i686-pc-windows-msvc','wasm32-unknown-unknown','x86_64-unknown-freebsd'])
  assert.throws(()=>assertPackagingTarget(target),/Native packaging supports/);
});
