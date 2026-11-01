/** Real authenticated downloads with inert files and links. Windows directory
 * junctions exercise link containment without requiring symlink privileges. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const directoryLink=(target,link)=>symlink(target,link,process.platform==='win32'?'junction':'dir');
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-session-files-'))),root=path.join(dir,'work');
 await mkdir(root);const denyNetwork=()=>{throw new Error('No network in session file fixtures');};
 const app=cleanup.service(await startServer({dir:path.join(dir,'data'),agentOptions:{autoStart:false},networkOptions:{lookup:denyNetwork,transport:denyNetwork}}));
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const session=app.agent.sessions.create({id:'file-fixture',kind:'worker',title:'Download fixture',cwd:root});
 const download=selected=>fetch(app.origin+'/api/agent/sessions/'+session.id+'/download?path='+encodeURIComponent(selected),{headers:{Cookie:cookie}});
 return {...app,dir,root,session,download};
}

test('session downloads reject links outside the work folder while retaining internal links',async t=>{
 const a=await fixture(t),outside=path.join(a.dir,'outside'),inside=path.join(a.root,'inside');
 await mkdir(outside);await mkdir(inside);
 await writeFile(path.join(outside,'private.txt'),'Outside the session.');await writeFile(path.join(inside,'résumé.txt'),'Inside the session.');
 await directoryLink(outside,path.join(a.root,'escape'));await directoryLink(inside,path.join(a.root,'internal'));
 for(const selected of ['escape/private.txt','../outside/private.txt',path.join(outside,'private.txt')]){
  const response=await a.download(selected);assert.equal(response.status,403,selected);assert.doesNotMatch(await response.text(),/Outside the session\./);
 }
 for(const selected of ['inside/résumé.txt','internal/résumé.txt']){
  const response=await a.download(selected);assert.equal(response.status,200,selected);assert.equal(await response.text(),'Inside the session.');
  assert.match(response.headers.get('content-disposition'),/r%C3%A9sum%C3%A9\.txt/);
 }
 if(process.platform!=='win32'){
  await symlink(path.join(outside,'private.txt'),path.join(a.root,'external-file.txt'));
  await symlink(path.join(inside,'résumé.txt'),path.join(a.root,'internal-file.txt'));
  assert.equal((await a.download('external-file.txt')).status,403);
  const response=await a.download('internal-file.txt');assert.equal(response.status,200);assert.equal(await response.text(),'Inside the session.');
 }
});

test('a linked session root still serves files and retains directory and size limits',async t=>{
 const a=await fixture(t),alias=path.join(a.dir,'work-alias');
 await directoryLink(a.root,alias);a.agent.sessions.update(a.session.id,{cwd:alias});
 await writeFile(path.join(a.root,'empty.txt'),'');
 const empty=await a.download('empty.txt');assert.equal(empty.status,200);assert.equal(await empty.text(),'');
 assert.equal((await a.download('.')).status,403);
 await mkdir(path.join(a.root,'directory'));assert.equal((await a.download('directory')).status,413);
 const large=await open(path.join(a.root,'large.txt'),'wx');try{await large.truncate(50_000_001);}finally{await large.close();}
 assert.equal((await a.download('large.txt')).status,413);
});

test('a file not created yet is a missing download rather than a service error',async t=>{
 const a=await fixture(t),response=await a.download('not-created.txt');assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'File not found'});
});
