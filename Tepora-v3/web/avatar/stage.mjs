/** createAvatar: draw the avatar a spec describes into a host and hand back one small handle, whatever the body is.
 *   {kind, body, setMood(mood), setLook(x,y), setLevel(v), setTheme(theme), setReduced(on), destroy()}
 * Drawn bodies and pictures live in the page; 3D models, mesh avatars and solid bodies are loaded only when chosen.
 * Anything that fails to load falls back to the default body, keeping what is personal, and says why once.
 */
import {avatarBody,resolveAvatarColors,validateAvatar} from './model.mjs';
import {avatarLamp,avatarLampDefs,avatarSeasonProp,avatarUid} from './kit.mjs';
import {moodPose} from './pose.mjs';
import {avatarGeometry} from './geometry.mjs';
import {avatarApplyLook,createSvgAvatar} from './svg.mjs';

/** Where the service serves one file of an asset. */
export function avatarAssetUrl(id,path='file'){return `/api/avatar/assets/${encodeURIComponent(id)}/files/${String(path).split('/').map(encodeURIComponent).join('/')}`;}
const avatarPreload=url=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('画像を読み込めませんでした。'));img.src=url;});
const avatarAborted=signal=>{if(signal?.aborted)throw Object.assign(new Error('aborted'),{aborted:true});};
const AVATAR_MODULES={vrm:'vrm-stage.mjs',mesh:'mesh-avatar.mjs',solid:'three-body.mjs'};

/** The lamp beside a body drawn on a canvas: the same lamp, as a small overlay on the host. */
function avatarLampOverlay(host,spec,theme,mood){
 const geometry=avatarGeometry(spec);
 if(spec.lamp?.shape==='none'||!geometry.fill)return null;
 const el=document.createElement('div');el.className='avatar-lamp';el.style.left=`${geometry.lamp[0]}%`;el.style.top=`${geometry.lamp[1]}%`;
 const u=avatarUid();el.innerHTML=`<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false"><defs>${avatarLampDefs(u)}</defs>${avatarLamp(u,spec.lamp.shape,22,22,1.25)}</svg>`;
 const svg=el.firstElementChild;svg.classList.add('cx');svg.dataset.mood=mood;avatarApplyLook(svg,spec,theme);host.append(el);
 return {setMood(m){svg.dataset.mood=m;},setTheme(t){avatarApplyLook(svg,spec,t);},destroy(){el.remove();}};
}

async function avatarMount(host,spec,o){
 const def=avatarBody(spec.body),{mood,theme,reduced,label,compact,signal,assets,assetUrl,readJSON,modulePath}=o;
 const asset=def.needs?assets.find(a=>a.id===spec.asset&&a.kind===def.needs):null;
 if(def.needs&&!asset)throw new Error('選んだ素材が見つかりません。');
 const common={mood,follow:o.follow,director:o.director,reduced,theme,label,compact};
 if(def.kind==='svg'&&spec.render!=='solid')return createSvgAvatar(host,spec,common);
 if(def.kind==='image'){
  let pictures;
  if(def.needs==='image')pictures={idle:assetUrl(asset.id,'file')};
  else{
   const sheet=await readJSON(asset.id,'imageset.json');avatarAborted(signal);
   pictures={};for(const [key,path] of Object.entries(sheet.moods||{}))pictures[key]=assetUrl(asset.id,path);
   if(sheet.talkOpen)pictures.talkOpen=assetUrl(asset.id,sheet.talkOpen);
  }
  await avatarPreload(pictures.idle);avatarAborted(signal);
  return createSvgAvatar(host,{...spec,pictures},common);
 }
 if(compact)return null;   // a 3D body is not drawn at icon size
 const kind=spec.render==='solid'?'solid':def.kind;
 host.classList.add('avatar-fill');
 host.innerHTML='<p class="avatar-loading">読み込んでいます…</p>';
 const mod=await import(modulePath(AVATAR_MODULES[kind]));avatarAborted(signal);
 const box=document.createElement('div');box.className='avatar-canvas';host.replaceChildren(box);
 // what a lazily loaded renderer cannot import from the page: the pose contract, the colours of the spec, this month's season
 let now={mood,theme,reduced},inner=null,overlay=null,fallen=false;
 // if the GPU drops what this body is drawn on, the default body takes over, keeping the same mood and theme
 const fall=()=>{
  if(fallen||signal?.aborted)return;fallen=true;inner?.destroy?.();overlay?.destroy();overlay=null;host.classList.remove('avatar-fill');host.replaceChildren();
  o.onProblem?.('この姿の描画が止まったため、しろ・改で表示しています。');
  inner=createSvgAvatar(host,validateAvatar({body:'shiro',render:'flat'},spec),{mood:now.mood,follow:o.follow,director:o.director,reduced:now.reduced,theme:now.theme,label,compact});
 };
 const options={spec,asset,assetUrl,readJSON,reducedMotion:reduced,theme,signal,framing:spec.slots?.framing||'bust',size:spec.size,follow:o.follow,onLost:fall,moodPose,colors:name=>resolveAvatarColors(spec,name),season:avatarSeasonProp(new Date().getMonth()+1)};
 inner=kind==='vrm'?await mod.createVRMAvatar(box,{...options,url:assetUrl(asset.id,'file')}):kind==='mesh'?await mod.createMeshAvatar(box,options):await mod.createSolidAvatar(box,options);
 if(signal?.aborted){inner.destroy?.();avatarAborted(signal);}
 overlay=kind==='solid'?null:avatarLampOverlay(host,spec,theme,mood);   // the solid body carries its own lamp
 const handle={kind,body:spec.body,get inner(){return inner;},
  setMood(m){now.mood=m;inner?.setMood?.(m);overlay?.setMood(m);},setLook(x,y){inner?.setLook?.(x,y);},setLevel(v){inner?.setLevel?.(v);},
  setTheme(t){now.theme=t;inner?.setTheme?.(t);overlay?.setTheme(t);},setReduced(r){now.reduced=r;inner?.setReduced?.(r);},
  destroy(){fallen=true;inner?.destroy?.();overlay?.destroy();host.classList.remove('avatar-fill');host.replaceChildren();}};
 handle.setMood(mood);
 return handle;
}

/** Draw the avatar a spec describes. Resolves to a handle, or null when it was aborted or cannot be shown at this size. */
export async function createAvatar(host,spec,{assets=[],assetUrl=avatarAssetUrl,readJSON,mood='idle',follow=false,director=false,reduced=false,theme='light',label='',compact=false,signal,previewMode=false,onProblem=()=>{}}={}){
 const o={assets,assetUrl,readJSON:readJSON||(async(id,path)=>{const r=await fetch(assetUrl(id,path),{credentials:'same-origin'});if(!r.ok)throw new Error('素材を読み込めませんでした。');return r.json();}),
  mood,follow,director,reduced,theme,label,compact,signal,onProblem,modulePath:name=>previewMode?`./web/${name}`:`/${name}`};
 try{return await avatarMount(host,spec,o);}
 catch(e){
  if(e?.aborted||e?.name==='AbortError'||signal?.aborted)return null;   // a newer choice replaced this one: say nothing, draw nothing
  host.classList.remove('avatar-fill');host.replaceChildren();
  const why=previewMode&&/dynamically imported|module/i.test(e?.message||'')?'オフラインのプレビューでは3Dの部品を読み込めません。ソース版では使えます':e?.message;
  onProblem(`この姿を表示できなかったため、しろ・改で表示しています。${why?`（${why}）`:''}`);
  return createSvgAvatar(host,validateAvatar({body:'shiro',render:'flat'},spec),{mood,follow,director,reduced,theme,label,compact});
 }
}
