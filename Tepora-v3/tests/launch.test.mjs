import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeLaunch} from '../core/connectors.mjs';
import {DEFAULT_SETTINGS} from '../core/policy.mjs';

test('llama.cpp launcher enables Jinja tool support without introducing an implicit shell',()=>{
 const result=runtimeLaunch({...DEFAULT_SETTINGS,modelPath:'C:/models/model.gguf'},'win32');
 assert.equal(result.executable,'llama-server');
 assert.ok(result.args.includes('--jinja'));
 assert.equal(result.args[result.args.indexOf('-m')+1],'C:/models/model.gguf');
});
test('vLLM launcher requires an explicit parser and enables automatic tool selection',()=>{
 const s={...DEFAULT_SETTINGS,provider:'vllm',modelPath:'Qwen/Qwen3-0.6B',baseUrl:'http://127.0.0.1:8000/v1'};
 assert.throws(()=>runtimeLaunch(s,'win32',''),/tool parser/);
 assert.throws(()=>runtimeLaunch(s,'win32','hermes;unwanted'),/tool parser/);
 const windows=runtimeLaunch(s,'win32','hermes');
 assert.equal(windows.executable,'wsl.exe');
 assert.deepEqual(windows.args.slice(0,2),['--exec','vllm']);
 assert.ok(windows.args.includes('--enable-auto-tool-choice'));
 assert.equal(windows.args[windows.args.indexOf('--tool-call-parser')+1],'hermes');
 assert.equal(runtimeLaunch(s,'linux','hermes').executable,'vllm');
 assert.throws(()=>runtimeLaunch({...s,baseUrl:'https://example.org/v1'},'win32','hermes'),/External connections/);
});
