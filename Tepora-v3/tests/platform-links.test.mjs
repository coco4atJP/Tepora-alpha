import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openAuthenticationPage} from '../core/platform-links.mjs';

const url='https://login.example.test/authorize?state=fixture&next=%2Faccount&literal=$(noop)';
function launcher(calls,{code=0,error=false,attached=false}={}){
 return (...args)=>{
  calls.push(args);const child=new EventEmitter();child.unref=()=>{child.unreferenced=true;};
  queueMicrotask(()=>{if(error)child.emit('error',Error('private launch details '+url));else{child.emit('spawn');if(!attached)queueMicrotask(()=>child.emit('exit',code));}});
  return child;
 };
}
test('authentication opens the exact HTTPS URL as one argument without a shell on each OS',async()=>{
 for(const [platform,exe,args] of [['darwin','open',[url]],['win32','rundll32',['url.dll,FileProtocolHandler',url]],['linux','xdg-open',[url]]]){
  const calls=[];assert.deepEqual(await openAuthenticationPage(url,{platform,spawnImpl:launcher(calls)}),{opened:true});
  assert.deepEqual(calls,[[exe,args,{shell:false,stdio:'ignore',windowsHide:true}]]);
 }
});
test('unsafe URL schemes, local addresses, credentials and control characters never launch a process',async()=>{
 const calls=[];
 for(const value of [null,'','file:///tmp/auth','javascript:alert(1)','http://login.example.test','https://user:secret@login.example.test','https://login.example.test/#token','https://localhost/auth','https://localhost./auth','https://host.local/auth','https://host.local./auth','https://127.1/auth','https://10.1.2.3/auth','https://[::1]/auth','https://[::ffff:8.8.8.8]/auth','https://login.example.test/\nauth','https://login.example.test/ auth','https://login.example.test/?'+ 'a'.repeat(16384)]){
  await assert.rejects(openAuthenticationPage(value,{spawnImpl:launcher(calls)}));
 }
 assert.equal(calls.length,0);
});
test('launcher failures return a retryable error without exposing the authentication URL',async()=>{
 for(const options of [{error:true},{code:1},{code:null}])await assert.rejects(openAuthenticationPage(url,{spawnImpl:launcher([],options)}),error=>error.status===503&&!error.message.includes('fixture')&&!error.message.includes(url));
 await assert.rejects(openAuthenticationPage(url,{spawnImpl:()=>{throw Error(url);}}),error=>error.status===503&&!error.message.includes(url));
});
test('an attached desktop launcher is accepted within a bounded wait without killing the browser',async()=>{
 const calls=[];assert.deepEqual(await openAuthenticationPage(url,{spawnImpl:launcher(calls,{attached:true}),timeoutMs:10}),{opened:true});assert.equal(calls.length,1);
});
