/** A mesh avatar: one illustration split into layers by mesh-avatar-studio, moved on a WebGL2 canvas. Loaded only when chosen.
 * The engine (./vendor/mesh-avatar, MIT, pinned to one commit) owns the face, the hair and the sway. This file only maps
 * Tepora's mood, loudness and gaze onto its small API, and draws at 30 frames a second, not at all while hidden or off screen.
 * Every layer picture comes from this PC (the service's asset route); nothing is fetched from elsewhere.
 */
import {createMeshAvatarImpl} from './vendor/mesh-avatar/createMeshAvatar.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const ease=(from,to,rate,dt)=>from+(to-from)*(1-Math.exp(-rate*dt));
const aborted=()=>Object.assign(new Error('aborted'),{aborted:true});
/** Tepora's mood → the engine's emotion tag, and whether its small gesture (a nod, a sigh) plays once as the mood begins. */
const FACE={idle:['neutral',false],listening:['relaxed',false],thinking:['neutral',false],talking:['neutral',false],happy:['happy',true],attention:['surprised',false],concerned:['sad',true],sleepy:['relaxed',false]};
/** With reduced motion the head, body and hands stay put; the face, blinks and lips still work. */
const STILL={angleX:0,angleY:0,angleZ:0,bodyAngleX:0,bodyAngleZ:0,armAngle:0,handAngle:0,fingerTap:0};
const GAIN={calm:.55,normal:1,lively:1.35};

/** The pictures the engine asks for by name ("base.png", "sprites/sprites.json"), as the service's URLs. */
function layerUrls(asset,assetUrl){
 const urls={};
 for(const file of asset.files||[])if(file.path.startsWith('built/'))urls[file.path.slice(6)]=assetUrl(asset.id,file.path);
 return urls;
}

export async function createMeshAvatar(host,{spec,asset,assetUrl,readJSON,reducedMotion=false,theme='light',signal,follow=true,onLost}={}){
 const rig=await readJSON(asset.id,'rig.json');
 if(signal?.aborted)throw aborted();
 const canvas=document.createElement('canvas');canvas.className='mesh-canvas';canvas.setAttribute('aria-hidden','true');canvas.dataset.theme=theme;host.append(canvas);
 let engine;
 try{engine=await createMeshAvatarImpl(canvas,{rig,assets:layerUrls(asset,assetUrl),manual:true});}
 catch(error){
  canvas.remove();
  throw new Error(/WebGL/i.test(error?.message||'')?'この端末ではWebGL2を使えないため、メッシュアバターを表示できません。':'メッシュアバターを読み込めませんでした。');
 }
 const release=()=>{engine.destroy();canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();};
 if(signal?.aborted){release();throw aborted();}
 const gain=GAIN[spec?.motion]||1;
 let mood=null,level=0,t=0,frame=0,last=0,disposed=false,visible=true,reduced=reducedMotion,sleep=0;
 // the engine does not rebuild its textures after the GPU drops the context, so the page is told and shows the default body
 canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(!disposed)onLost?.();});
 let pointer=null,pointerTimer=0,lookX=0,lookY=0,lookW=0;
 const setMood=next=>{
  next=FACE[next]?next:'idle';if(next===mood)return;mood=next;
  const [tag,gesture]=FACE[mood];
  engine.setSpeaking(mood==='talking');   // before the emotion: ending speech would otherwise reset the face a moment later
  engine.setEmotion(tag,{playMotion:gesture&&!reduced});
  applyLife();
 };
 const applyLife=()=>{
  engine.setSwayGain(reduced?0:gain);engine.setTalkGain(reduced?0:gain);
  engine.setAutoIdle(!reduced&&mood!=='sleepy');engine.setAutoMotion(!reduced&&mood!=='sleepy'&&spec?.motion!=='calm');
 };
 const seen=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);});seen.observe(host);
 const onPointer=e=>{
  if(reduced)return;const r=host.getBoundingClientRect();if(!r.width)return;
  pointer={x:clamp((e.clientX-(r.left+r.width/2))/Math.max(260,innerWidth/2),-1,1),y:clamp((e.clientY-(r.top+r.height*.3))/Math.max(220,innerHeight/2),-1,1)};
  clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointer=null;},4000);
 };
 if(follow)window.addEventListener('pointermove',onPointer,{passive:true});
 setMood('idle');engine.advance(0);   // the first picture, before the loop starts
 function tick(now){
  if(disposed)return;frame=requestAnimationFrame(tick);
  if(!visible||document.hidden){last=now;return;}
  if(now-last<32)return;
  const dt=clamp((now-last)/1000,.001,.1);last=now;t+=dt;
  // Gaze and lids are the only things set from outside, and each eases in and out so nothing jumps.
  const thinking=mood==='thinking',wants=pointer&&!reduced?[pointer.x*.9,-pointer.y*.6,1]:thinking&&!reduced?[-.5,.4,1]:[0,0,0];
  lookX=ease(lookX,wants[0],6,dt);lookY=ease(lookY,wants[1],6,dt);lookW=ease(lookW,wants[2],5,dt);sleep=ease(sleep,mood==='sleepy'?1:0,3,dt);
  const params=reduced?{...STILL,gazeX:0,gazeY:0}:{};
  if(lookW>.02){params.gazeX=lookX*lookW;params.gazeY=lookY*lookW;}
  if(sleep>.02){params.eyeROpen=params.eyeLOpen=1-.92*sleep;}
  engine.setParameters(params);
  engine.setVoiceLevel(mood==='talking'?Math.max(level,.22+.5*Math.abs(Math.sin(t*7.3))*(.65+.35*Math.sin(t*2.1))):0);
  engine.advance(1/30,30);
 }
 frame=requestAnimationFrame(tick);
 return {
  kind:'mesh',
  setMood,
  setLook(x,y){pointer={x:clamp(Number(x)||0,-1,1),y:clamp(Number(y)||0,-1,1)};clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointer=null;},4000);},
  setLevel(value){level=clamp(Number(value)||0,0,1);},
  setTheme(name){canvas.dataset.theme=name;},
  setReduced(on){reduced=!!on;if(reduced)pointer=null;applyLife();},
  destroy(){disposed=true;cancelAnimationFrame(frame);clearTimeout(pointerTimer);window.removeEventListener('pointermove',onPointer);seen.disconnect();release();}
 };
}
