import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';

// Real session/CSRF host; browser/issuer I/O stays inert.
test('browser handoff accepts only a current service-owned login, behind session and CSRF checks',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-browser-auth-')),opened=[];let fail=false;
 const app=await startServer({dir,registryOptions:{detectLimits:false},openAuthBrowser:async url=>{if(fail)throw Object.assign(Error('ブラウザーを開けませんでした。'),{status:503});opened.push(url);},networkOptions:{transport:()=>{throw Error('No upstream request expected');}}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();const cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,data,headers={})=>fetch(app.origin+route,{method:'POST',headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 const expect=async(route,data,status,headers)=>{const r=await request(route,data,headers);assert.equal(r.status,status);return r.json();};
 const pi=app.pi;pi.pending={id:'pi-fixture',provider:'openai',status:'pending',cancel:new AbortController(),event:{type:'auth_url',url:'https://login.example.test/authorize?state=synthetic'}};
 for(const headers of [{Cookie:''},{'X-Tepora-CSRF':''},{Origin:'https://attacker.invalid'}])await expect('/api/pi/auth/open',{id:'pi-fixture'},headers.Cookie===''?401:403,headers);
 await expect('/api/pi/auth/open',{id:'pi-fixture',url:'https://attacker.invalid'},400);
 await expect('/api/pi/auth/open',{url:'https://attacker.invalid'},400);
 await expect('/api/pi/auth/open',{id:'old-attempt'},409);assert.deepEqual(opened,[]);
 assert.deepEqual(await expect('/api/pi/auth/open',{id:'pi-fixture'},200),{opened:true});assert.equal(opened.at(-1),pi.pending.event.url);
 pi.pending.event={type:'device_code',verificationUri:'https://login.example.test/activate?code=fixture',userCode:'fixture'};
 await expect('/api/pi/auth/open',{id:'pi-fixture'},200);assert.equal(opened.at(-1),pi.pending.event.verificationUri);
 pi.pending.event={type:'secret'};await expect('/api/pi/auth/open',{id:'pi-fixture'},409);
 pi.pending.event={type:'auth_url',url:'javascript:alert(1)'};await expect('/api/pi/auth/open',{id:'pi-fixture'},409);
 pi.pending.event={type:'auth_url',url:'https://login.example.test/authorize'};
 fail=true;await expect('/api/pi/auth/open',{id:'pi-fixture'},503);fail=false;
 app.network.change({mode:'offline'},app.network.get().revision);await expect('/api/pi/auth/open',{id:'pi-fixture'},403);
 app.network.change({mode:'online'},app.network.get().revision);pi.cancel();await expect('/api/pi/auth/open',{id:'pi-fixture'},409);
 assert.equal(opened.length,2);
});
