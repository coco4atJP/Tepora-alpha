/** Optional offline Chromium QA: node tests/browser-modality-models.mjs [evidence-dir].
 * Synthetic state/audio, no model, credentials, microphone or external requests.
 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=process.argv[2];if(out)await mkdir(out,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'tepora-modalities-'));
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true});
const checks=[],errors=[];
try{
 const page=await browser.page('modalities');
 browser.conn.on(m=>{if(m.sessionId===page.sessionId&&m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 const exposure=`window.uiTest={state,abilities,closeSheet,actions,render,review(p){const anchor=draftContext.anchor(draft,{start:0,end:0,id:'synthetic-audio',attachmentEpoch});anchor.transcriptionProfile=p;window.reviewOutcome='pending';transcribeRecording(new Blob(['synthetic WAV fixture']),anchor,voiceEpoch).then(()=>window.reviewOutcome='sent',e=>window.reviewOutcome=e.name);},async switchEmbedding(){const c=await bridge.request("/api/capabilities");return bridge.request("/api/capabilities","PUT",{expectedRevision:c.revision,config:{profiles:c.profiles.map(p=>({...p,model:"changed-synthetic-model"})),routes:c.routes}});},mockVoice(){const original=bridge.request;window.semanticCalls=[];window.voiceCalls=[];bridge.request=(p,...args)=>{if(p==='/api/voice/transcribe'){window.voiceCalls.push(args);return Promise.resolve({text:'合成音声テスト'});}if(p.startsWith('/api/semantic/')){window.semanticCalls.push({p,args});return Promise.resolve({indexed:0,remaining:0,total:0,hits:[],note:'synthetic'});}return original(p,...args);};}};`;
 const code=(await browserBundle(path.join(root,'web'),{preview:true})).replace('\n})().catch(fail)',`\n${exposure}\n})().catch(fail)`);
 const css=await readFile(path.join(root,'web/styles.css'),'utf8'),avatar=await readFile(path.join(root,'web/avatar.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><style>${css}\n${avatar}</style><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 const evaluate=s=>page.eval(s,{awaitPromise:true});
 const wait=async s=>{const end=Date.now()+8000;do{if(await evaluate(s))return;await new Promise(r=>setTimeout(r,25));}while(Date.now()<end);throw Error(`Timed out: ${s}`);};
 const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
 const viewport=async(width,height=900)=>{await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});};
 const shot=async name=>{if(out){await evaluate('new Promise(r=>setTimeout(r,220))');const {data}=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,name+'.png'),Buffer.from(data,'base64'));}};
 const preset=async id=>{await evaluate(`(()=>{const e=document.querySelector('#ability-preset');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
 const values=()=>evaluate(`Object.fromEntries(new FormData(document.querySelector('#ability-form')))`);
 await viewport(1440);
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 await wait('!!window.uiTest&&!!document.querySelector("#composer-input")');
 await evaluate('uiTest.mockVoice();uiTest.abilities().open()');await wait('!!document.querySelector("[data-action=ability-new][data-role=stt]")');
 await click('[data-action=ability-new][data-role=stt]');await wait('!!document.querySelector("#ability-form")');
 assert.equal((await values()).model,'ibm-granite/granite-speech-5.0-470m-turboctc');checks.push('fresh STT editor recommends multilingual Granite CTC without installing or routing');
 await evaluate('uiTest.closeSheet();uiTest.abilities().open()');await wait('!!document.querySelector("[data-action=ability-new][data-role=tts]")');await click('[data-action=ability-new][data-role=tts]');await wait('!!document.querySelector("#ability-form")');assert.equal((await values()).model,'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX');assert.equal((await values()).voice,'SELECT_INSTALLED_BUILTIN');checks.push('fresh TTS recommends MOSS while requiring an actual installed voice');
 for(const [id,model,protocol,voice]of [['stt-granite','ibm-granite/granite-speech-5.0-470m-turboctc','openai-transcriptions'],['stt-nemotron','nvidia/nemotron-3.5-asr-streaming-0.6b','openai-transcriptions'],['tts-moss','OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX','openai-speech','SELECT_INSTALLED_BUILTIN'],['tts-supertonic','supertonic-3','openai-speech','M1'],['stt-openai','gpt-transcribe','openai-transcribe'],['stt-groq','whisper-large-v3-turbo','openai-transcriptions'],['tts-qwen','Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice','openai-speech','Ono_Anna'],['tts-kokoro','kokoro','openai-speech','jf_alpha'],['tts-inworld','inworld-tts-2-flash','openai-speech','Dennis'],['embedding-qwen','qwen3-embedding:0.6b','ollama-embed'],['embedding-openai','text-embedding-3-small','openai-embeddings']]){
  await preset(id);const v=await values();assert.equal(v.model,model);assert.equal(v.protocol,protocol);if(voice)assert.equal(v.voice,voice);
  assert.equal(v.audioFormat,['tts-moss','tts-supertonic','tts-qwen','tts-kokoro'].includes(id)?'wav':'');
  assert.equal(v.embeddingFormat,id==='embedding-qwen'?'qwen3-retrieval-v1':id==='embedding-openai'?'plain-v1':'legacy');
  assert.equal(v.contextTokens,id==='embedding-qwen'?'2048':'');checks.push(`preset ${id} has compatible model/voice/format and clears old optional fields`);
 }
 assert.equal(await evaluate('Object.keys(uiTest.state.capabilities.routes).length'),0);checks.push('preset browsing never enables a route or sends audio');
 await preset('embedding-openai');
 for(const width of [1440,390,320]){await viewport(width);const overflow=await evaluate(`(()=>{const e=document.querySelector('#ability-form');return {width:e.clientWidth,scroll:e.scrollWidth};})()`);assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify({width,...overflow}));}
 await shot('model-editor-mobile');checks.push('model editor fits 320/390/1440px');
 await viewport(1440);await evaluate('document.querySelector("#ability-form").requestSubmit()');await wait('!!document.querySelector("#ability-routes")');
 assert.equal(await evaluate('uiTest.state.capabilities.profiles[0].embeddingFormat'),'plain-v1');
 await evaluate('uiTest.closeSheet();uiTest.abilities().semantic()');await wait('!!document.querySelector("[name=indexConsent]")');
 assert.equal(await evaluate('document.querySelector("[name=indexConsent]").checked'),false);assert.equal(await evaluate('document.querySelector("[name=consent]").checked'),false);checks.push('cloud query and memory indexing have separate unchecked consent');
 await evaluate('document.querySelector("#semantic-form").parentElement.querySelector("details").open=true');await shot('external-memory-consent');
 const reviewedIdentity=await evaluate('uiTest.state.capabilities.profiles[0].identity');await evaluate('uiTest.switchEmbedding()');await evaluate('document.querySelector("[name=indexConsent]").checked=true');await click('[data-action=semantic-index]');await wait('semanticCalls.length===1');assert.equal(await evaluate('semanticCalls[0].args[1].profileIdentity'),reviewedIdentity);await evaluate('document.querySelector("#semantic-form [name=query]").value="合成";document.querySelector("#semantic-form").requestSubmit()');await wait('semanticCalls.length===2');assert.equal(await evaluate('semanticCalls[1].args[1].profileIdentity'),reviewedIdentity);checks.push('query/index preserve the displayed recipient after capability settings change');await evaluate('uiTest.closeSheet()');
 const recipient={name:'合成クラウド接続',model:'gpt-transcribe',baseUrl:'https://example.invalid/v1',domain:'cloud',identity:'synthetic-recipient'};
 await evaluate('document.querySelector("#mic-button").focus()');await evaluate(`uiTest.review(${JSON.stringify(recipient)})`);await wait('!!document.querySelector("[data-action=transcription-send]")');assert.equal(await evaluate('voiceCalls.length'),0);
 await shot('recording-consent');
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await wait('reviewOutcome==="AbortError"');assert.equal(await evaluate('voiceCalls.length'),0);assert.equal(await evaluate('document.activeElement.id'),'mic-button');checks.push('Escape cancels external audio review without dispatch and restores microphone focus');
 for(let i=0;i<2;i++){await evaluate(`uiTest.review(${JSON.stringify(recipient)})`);await wait('!!document.querySelector("[data-action=transcription-cancel]")');await click('[data-action=transcription-cancel]');await wait('reviewOutcome==="AbortError"');}
 assert.equal(await evaluate('voiceCalls.length'),0);checks.push('repeated open/cancel leaves no pending audio');
 await evaluate(`uiTest.review(${JSON.stringify(recipient)})`);await wait('!!document.querySelector("[data-action=transcription-send]")');await click('[data-action=transcription-send]');await wait('reviewOutcome==="sent"');assert.equal(await evaluate('voiceCalls.length'),1);assert.equal(await evaluate('voiceCalls[0][2]["X-Tepora-Audio-Consent"]'),'true');checks.push('explicit confirmation dispatches only the reviewed recipient once');
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await evaluate('uiTest.actions["theme-set"]({dataset:{value:"dark"}})');await wait('document.body.dataset.theme==="dark"');await evaluate('uiTest.abilities().open()');await wait('!!document.querySelector("[data-action=ability-new]")');await wait('getComputedStyle(document.querySelector(".ability-list strong")).color==="rgb(236, 231, 222)"');await shot('abilities-dark');
 assert.deepEqual(errors,[]);checks.push('dark/reduced-motion preview has no runtime exceptions');
 const report={checks,errors,realModels:false,actualNetwork:false,method:'Page.setDocumentContent at about:blank; isolated Chromium profile; HTTP/HTTPS blocked; synthetic preview bridge and audio'};
 console.log(JSON.stringify(report,null,2));if(out)await writeFile(path.join(out,'browser-models.json'),JSON.stringify(report,null,2));
}finally{await browser.close();await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
