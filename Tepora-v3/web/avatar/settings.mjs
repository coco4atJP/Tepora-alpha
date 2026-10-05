/** The avatar studio: choose a body and every part of how it looks, try it in a live preview, and bring a character
 * you already have (a VRM, a picture, a set of pictures, a mesh-avatar-studio project). Every choice is saved the
 * moment it is made, can be undone, and is only ever one of the enumerated values the service accepts.
 * Files stay on this PC; in the offline preview they stay in this window only.
 */
import {escape,btn} from '../ui.mjs';
import {AVATAR_BODIES,AVATAR_EARS,AVATAR_EYES,AVATAR_HOBBIES,AVATAR_LAMPS,AVATAR_LAMP_SHAPES,AVATAR_MOTIONS,AVATAR_PALETTES,AVATAR_SEASONS,AVATAR_SIZE,avatarBody,avatarContrast,resolveAvatarColors} from './model.mjs';
import {AVATAR_MOODS} from './pose.mjs';
import {createAvatar,avatarAssetUrl} from './stage.mjs';

const AVATAR_MOOD_LABEL={idle:'いつも',listening:'聞いている',thinking:'考え中',talking:'話している',happy:'うれしい',attention:'気づいて',concerned:'心配',sleepy:'ねむい'};
const AVATAR_LABELS={
 eyes:{capsule:'たて長',dot:'点',big:'大きい',sleepy:'ねむたげ'},ears:{none:'なし',cat:'ねこ',bear:'くま',rabbit:'うさぎ'},
 season:{auto:'季節にまかせる',off:'なし',petal:'春：花びら',uchiwa:'夏：うちわ',leaf:'秋：落ち葉',scarf:'冬：マフラー'},
 hobby:{none:'なし',headphones:'ヘッドホン',glasses:'めがね',cup:'お茶'},motion:{calm:'静か',normal:'ふつう',lively:'にぎやか'},
 shape:{bead:'ぽち',flame:'ほのお',bud:'つぼみ',bulb:'電球',none:'なし'},render:{flat:'平面',solid:'立体'}
};
const AVATAR_KIND_LABEL={vrm:'3Dモデル',image:'画像',imageset:'画像セット',mesh:'メッシュアバター'};
const AVATAR_KIND_BODY={vrm:'vrm',image:'image',imageset:'imageset',mesh:'mesh'};
const AVATAR_MOOD_GUESS=[['talkOpen',/open|aa|あ|開/i],['idle',/idle|normal|default|base|neutral|通常|いつも|基本/i],['listening',/listen|聞/i],['thinking',/think|考/i],['talking',/talk|speak|話/i],['happy',/happy|smile|joy|うれ|嬉|笑/i],['attention',/attention|notice|surprise|気づ|驚/i],['concerned',/concern|worr|sad|心配|悲/i],['sleepy',/sleep|ねむ|眠/i]];
export const avatarGuessMood=name=>(AVATAR_MOOD_GUESS.find(([,re])=>re.test(String(name)))||['skip'])[0];

/** The small container the service reads: TPAK1, a length, a JSON manifest, then the file bytes in order. */
export function avatarBuildPack(kind,name,files){
 const manifest=new TextEncoder().encode(JSON.stringify({kind,name:String(name).slice(0,80),files:files.map(f=>({path:f.path,size:f.blob.size}))})),length=new Uint8Array(4);
 new DataView(length.buffer).setUint32(0,manifest.length,true);
 return new Blob([new TextEncoder().encode('TPAK1\n'),length,manifest,...files.map(f=>f.blob)],{type:'application/octet-stream'});
}
/** The files of a mesh-avatar-studio project from a chosen folder, with their paths relative to the project. */
export function avatarMeshFiles(list){
 const allowed=path=>path==='rig.json'||path==='built/layers.json'||path==='built/sprites/sprites.json'||/^built\/[A-Za-z0-9_-]{1,48}\.png$/.test(path)||/^built\/sprites\/[A-Za-z0-9_-]{1,48}\.png$/.test(path);
 const rels=file=>String(file.webkitRelativePath||file.name).split('/');
 for(const strip of [1,2]){
  const files=list.map(f=>({path:rels(f).slice(strip).join('/'),blob:f})).filter(f=>allowed(f.path));
  if(files.some(f=>f.path==='rig.json'))return files;
 }
 return [];
}
const avatarNestedPatch=(key,value)=>{
 if(key.startsWith('slot.'))return {slots:{[key.slice(5)]:value}};
 const dot=key.indexOf('.');return dot<0?{[key]:value}:{[key.slice(0,dot)]:{[key.slice(dot+1)]:value}};
};
const avatarPick=({accept='',multiple=false,directory=false}={})=>new Promise(resolve=>{
 const input=document.createElement('input');input.type='file';input.accept=accept;input.multiple=multiple||directory;if(directory)input.setAttribute('webkitdirectory','');
 input.onchange=()=>resolve([...input.files]);input.addEventListener('cancel',()=>resolve([]),{once:true});input.click();
});
const avatarMb=n=>`${(n/1048576).toFixed(n<10485760?1:0)}MB`;

export function createAvatarStudio({bridge,openSheet,notice,previewMode,state,isOpen,previewAvatar,saveFile,chooseJSON,themeNow=()=>'light'}){
 let preview=null,previewMood='idle',abort=null,draft=null;
 const spec=()=>state().avatar,assets=()=>state().avatarAssets?.assets||[],root=()=>document.querySelector('#avatar-sheet');
 const send=(patch)=>bridge.request('/api/avatar','PATCH',{patch,expectedRevision:spec().revision});
 const swatch=(key,value,label,pressed,css,locked=false)=>`<button type="button" class="av-sw${locked?' is-locked':''}" ${locked?'disabled aria-disabled="true"':`data-action="av-set" data-key="${key}" data-value="${value}"`} aria-pressed="${pressed}" title="${escape(label)}" style="--sw:${css}"><i></i><span>${escape(label)}</span></button>`;
 const chips=(key,options,current,label)=>`<div class="segmented av-chips" role="group" aria-label="${escape(label)}">${options.map(([v,t])=>`<button type="button" data-action="av-set" data-key="${key}" data-value="${escape(v)}" aria-pressed="${String(current)===String(v)}">${escape(t)}</button>`).join('')}</div>`;
 const group=(title,html,note='')=>`<fieldset class="av-group"><legend>${escape(title)}</legend>${note?`<p class="small-text">${escape(note)}</p>`:''}${html}</fieldset>`;

 function controlsHTML(){
  const s=spec(),def=avatarBody(s.body),drawn=def.kind==='svg';
  let h='';
  h+=group('姿（体）',`<div class="segmented av-chips" role="group" aria-label="姿">${AVATAR_BODIES.filter(b=>b.kind==='svg').map(b=>`<button type="button" data-action="av-set" data-key="body" data-value="${b.id}" aria-pressed="${s.body===b.id}" title="${escape(b.note)}">${escape(b.name)}</button>`).join('')}</div>`,drawn?def.note:'下の「持ち込んだもの」から選んだ姿を使っています。色や灯りの好みは、体を替えても引き継がれます。');
  if(drawn){
   const colors=resolveAvatarColors(s,'light'),eye=avatarContrast(colors.ink,colors.body);
   h+=group('素材（色）',`<div class="av-swatches" role="group" aria-label="素材">${Object.entries(AVATAR_PALETTES).map(([id,p])=>swatch('palette',id,p.name,s.palette===id,`linear-gradient(135deg,${p.light},${p.body} 55%,${p.shade})`)).join('')}${swatch('palette','custom','好きな色',s.palette==='custom','conic-gradient(from 90deg,hsl(0 60% 80%),hsl(60 60% 80%),hsl(120 60% 80%),hsl(180 60% 80%),hsl(240 60% 80%),hsl(300 60% 80%),hsl(360 60% 80%))')}</div>${s.palette==='custom'?`<label class="av-range"><span>色相 <b>${Math.round(s.hue)}°</b></span><input type="range" min="0" max="360" step="1" value="${s.hue}" data-action="av-range" data-key="hue" aria-label="色相"></label><p class="small-text">明るさと濃さは固定なので、どの色相でも目が読めます（目の見やすさ ${eye.toFixed(1)} : 1）。</p>`:''}`);
  }
  h+=group('灯り（このキャラクターの目印）',`<div class="av-swatches" role="group" aria-label="灯りの色">${Object.entries(AVATAR_LAMPS).map(([id,l])=>swatch('lamp.hue',id,l.name,s.lamp.hue===id,l.day)).join('')}${swatch('','','琥珀 🔒',false,'repeating-linear-gradient(135deg,#e2a12a 0 5px,#f4e7cd 5px 10px)',true)}</div>${chips('lamp.shape',AVATAR_LAMP_SHAPES.filter(v=>v!=='none'||!drawn).map(v=>[v,AVATAR_LABELS.shape[v]]),s.lamp.shape,'灯りの形')}`,'琥珀は「あなたの番」の色なので選べません。灯りは気分で色が変わりません。');
  if(def.face)h+=group('顔',`<div class="av-row"><span>目</span>${chips('face.eyes',AVATAR_EYES.map(v=>[v,AVATAR_LABELS.eyes[v]]),s.face.eyes,'目')}</div><div class="av-toggles"><label><input class="switch" type="checkbox" data-action="av-toggle" data-key="face.cheeks" ${s.face.cheeks?'checked':''}> ほお</label><label><input class="switch" type="checkbox" data-action="av-toggle" data-key="face.brows" ${s.face.brows?'checked':''}> まゆ</label></div>`);
  if(def.parts?.includes('ears'))h+=group('耳',chips('parts.ears',AVATAR_EARS.map(v=>[v,AVATAR_LABELS.ears[v]]),s.parts.ears,'耳'));
  if(def.props)h+=group('小物',`<div class="av-row"><span>季節</span>${chips('props.season',AVATAR_SEASONS.map(v=>[v,AVATAR_LABELS.season[v]]),s.props.season,'季節の小物')}</div><div class="av-row"><span>好み</span>${chips('props.hobby',AVATAR_HOBBIES.map(v=>[v,AVATAR_LABELS.hobby[v]]),s.props.hobby,'好みの小物')}</div>`,'季節の小物は七十二候の暦で入れ替わります。');
  if(def.slots.length)h+=group(`${def.name}の設定`,def.slots.map(slot=>`<div class="av-row"><span>${escape(slot.label)}</span>${chips(`slot.${slot.key}`,slot.opts,s.slots[slot.key]??slot.opts[0][0],slot.label)}</div>`).join(''));
  if(def.modes.length>1)h+=group('質感',chips('render',def.modes.map(v=>[v,AVATAR_LABELS.render[v]]),s.render,'質感'),'立体は3Dで描きます。この端末で使えないときは、平面で表示します。');
  h+=group('大きさと動き',`<label class="av-range"><span>大きさ <b>${Math.round(s.size*100)}%</b></span><input type="range" min="${AVATAR_SIZE.min}" max="${AVATAR_SIZE.max}" step="0.05" value="${s.size}" data-action="av-range" data-key="size" aria-label="大きさ"></label><div class="av-row"><span>動き</span>${chips('motion',AVATAR_MOTIONS.map(v=>[v,AVATAR_LABELS.motion[v]]),s.motion,'動き')}</div>`,'OSの「視差効果を減らす」設定がオンなら、動きは自動で止まります。');
  return h;
 }
 function libraryHTML(){
  const s=spec(),list=assets();
  const meta=a=>a.kind==='vrm'?[a.meta.version==='1.0'?'VRM 1.0':'VRM 0.x',a.meta.authors?.length?`作者: ${a.meta.authors.join('、')}`:'',a.meta.license?`利用条件: ${a.meta.license}`:'',a.meta.commercialUsage?`商用: ${a.meta.commercialUsage}`:''].filter(Boolean).join(' · ')
   :a.kind==='image'?`${a.meta.width&&a.meta.height?`${a.meta.width}×${a.meta.height}`:''}`
   :a.kind==='imageset'?`${a.meta.moods?.length||0}種類の表情${a.meta.talkOpen?' · 口を開けた絵あり':''}`:`${a.meta.layers||0}層${a.meta.sprites?' · 表情スプライトあり':''}`;
  return `<div class="av-add"><span>持ち込む</span>${['vrm','image','imageset','mesh'].map(k=>btn('av-add',AVATAR_KIND_LABEL[k],'upload','button secondary',`data-kind="${k}"`)).join('')}</div>
  <p class="small-text">今までのキャラクターは、そのまま使えます。VRM は VRoid Studio などで作ったもの、メッシュアバターは <a href="https://github.com/shinshin86/mesh-avatar-studio" target="_blank" rel="noreferrer noopener">mesh-avatar-studio</a> で作った projects フォルダです。ファイルはこのPCにだけ保存します。${previewMode?'このプレビューでは、保存せず、この画面を開いている間だけ使えます。':''}</p>
  <div id="av-draft">${draftHTML()}</div>
  ${list.length?`<ul class="av-assets">${list.map(a=>`<li class="av-asset${s.asset===a.id?' is-on':''}"><div><b>${escape(a.name)}</b><small>${escape(AVATAR_KIND_LABEL[a.kind])} · ${escape(avatarMb(a.bytes))}${meta(a)?` · ${escape(meta(a))}`:''}</small></div><span>${s.asset===a.id?'<em>使用中</em>':btn('av-wear','この姿にする','','button secondary',`data-id="${escape(a.id)}"`)}${btn('av-remove','削除','','text-button danger',`data-id="${escape(a.id)}" aria-label="${escape(a.name)}を削除"`)}</span></li>`).join('')}</ul>`:'<p class="small-text">まだ、持ち込んだものはありません。</p>'}`;
 }
 function draftHTML(){
  if(!draft)return '';
  const moods=[['skip','使わない'],...AVATAR_MOODS.map(m=>[m,AVATAR_MOOD_LABEL[m]]),['talkOpen','口を開けた絵（話すとき）']];
  return `<div class="av-draft"><p><b>画像セット</b> — どの絵がどの気分かを選んでください。「いつも」は必須です。</p><ul>${draft.files.map((f,i)=>`<li><img src="${escape(f.url)}" alt="" width="48" height="48"><span>${escape(f.file.name)}</span><select data-action="av-draft-mood" data-index="${i}" aria-label="${escape(f.file.name)}の気分">${moods.map(([v,t])=>`<option value="${v}" ${f.mood===v?'selected':''}>${escape(t)}</option>`).join('')}</select></li>`).join('')}</ul><div class="sheet-actions">${btn('av-draft-go','取り込む','upload','button')}${btn('av-draft-cancel','やめる','','text-button')}</div></div>`;
 }
 function content(){
  return `<div id="avatar-sheet" class="avatar-sheet"><div class="av-top"><div class="av-preview" id="av-preview" aria-label="プレビュー"></div>
   <div class="av-side"><div class="segmented av-moods" role="group" aria-label="プレビューの気分">${AVATAR_MOODS.map(m=>`<button type="button" data-action="av-mood" data-value="${m}" aria-pressed="${m===previewMood}">${AVATAR_MOOD_LABEL[m]}</button>`).join('')}</div>
   <p class="small-text" id="av-status" role="status"></p></div></div>
   <div class="av-actions">${btn('av-dice','さいころ','','button secondary','title="体と部品を、おまかせで選びます"')}${btn('av-undo','前に戻す','undo','text-button')}${btn('av-reset','既定に戻す','','text-button')}<span class="av-actions-gap" aria-hidden="true"></span>${btn('av-export','姿を書き出す','download','text-button','aria-label="姿の設定を書き出す"')}${btn('av-import','読み込む','upload','text-button','aria-label="姿の設定を読み込む"')}</div>
   <div id="av-controls" class="av-controls">${controlsHTML()}</div>
   <h3 class="av-h">持ち込んだもの</h3><div id="av-library" class="av-library">${libraryHTML()}</div></div>`;
 }
 const status=text=>{const el=document.querySelector('#av-status');if(el)el.textContent=text;};
 async function mountPreview(){
  const host=document.querySelector('#av-preview');if(!host)return;
  abort?.abort();abort=new AbortController();const signal=abort.signal;
  preview?.destroy();preview=null;host.replaceChildren();
  const context=previewMode?{assets:assets(),assetUrl:(id,path)=>previewAvatar.url(id,path),readJSON:(id,path)=>previewAvatar.readJSON(id,path),previewMode:true}:{assets:assets(),assetUrl:avatarAssetUrl};
  const handle=await createAvatar(host,spec(),{...context,mood:previewMood,follow:true,director:false,theme:themeNow(),reduced:matchMedia?.('(prefers-reduced-motion: reduce)').matches===true,signal,onProblem:m=>status(m)});
  if(signal.aborted){handle?.destroy();return;}
  preview=handle;
 }
 function refresh(){
  if(!isOpen()||!root())return;
  const c=document.querySelector('#av-controls'),l=document.querySelector('#av-library'),f=document.activeElement;
  const sig=f&&f.closest?.('#avatar-sheet')&&f.dataset?.action?['action','key','value','id','index'].map(k=>f.dataset[k]??''):null;
  if(c)c.innerHTML=controlsHTML();if(l)l.innerHTML=libraryHTML();
  if(sig){const again=[...root().querySelectorAll('[data-action]')].find(el=>['action','key','value','id','index'].every((k,i)=>(el.dataset[k]??'')===sig[i]));again?.focus();}
  mountPreview();
 }
 const apply=async patch=>{await send(patch);};
 const randomPatch=()=>{
  const pick=a=>a[Math.floor(Math.random()*a.length)],bodies=AVATAR_BODIES.filter(b=>b.kind==='svg'),def=pick(bodies);
  const patch={body:def.id,palette:pick(Object.keys(AVATAR_PALETTES)),lamp:{hue:pick(Object.keys(AVATAR_LAMPS).filter(k=>k!=='snow')),shape:pick(AVATAR_LAMP_SHAPES.filter(v=>v!=='none'))},
   face:{eyes:pick(AVATAR_EYES),cheeks:Math.random()>.2,brows:Math.random()>.25},props:{season:pick(AVATAR_SEASONS),hobby:pick(AVATAR_HOBBIES)},slots:Object.fromEntries(def.slots.map(s=>[s.key,pick(s.opts)[0]]))};
  if(def.parts?.includes('ears'))patch.parts={ears:pick(AVATAR_EARS)};
  if(patch.palette==='sumi'&&['andon','kokedama'].includes(def.id))patch.palette='washi';
  return patch;
 };
 const apiFile=(kind,blob,name)=>bridge.request('/api/avatar/assets','PUT',blob,{'X-Tepora-Asset-Kind':kind,'X-Tepora-Filename':encodeURIComponent(name)});
 const wear=async asset=>{await send({body:AVATAR_KIND_BODY[asset.kind],asset:asset.id});};
 async function addVRM(){
  const [file]=await avatarPick({accept:'.vrm,model/gltf-binary'});if(!file)return;
  status('3Dモデルを確認しています…');
  const asset=previewMode?previewAvatar.add({kind:'vrm',name:file.name.replace(/\.[^.]+$/,''),meta:{version:'1.0',authors:[]},files:[{path:'file',blob:file,mime:'model/gltf-binary'}]}):(await apiFile('vrm',file,file.name)).asset;
  await wear(asset);status(`「${asset.name}」を使っています。${asset.meta?.license?`利用条件: ${asset.meta.license}`:''}`);
 }
 async function addImage(){
  const [file]=await avatarPick({accept:'image/png,image/jpeg,image/webp,image/avif,image/gif'});if(!file)return;
  status('画像を確認しています…');
  let asset;
  if(previewMode){
   if(!/^image\/(png|jpeg|webp|avif|gif)$/.test(file.type))throw new Error('PNG・JPEG・WebP・AVIF・GIFの画像を選んでください。SVGは使えません。');
   const bitmap=await createImageBitmap(file).catch(()=>{throw new Error('この画像は読み込めません。');});
   asset=previewAvatar.add({kind:'image',name:file.name.replace(/\.[^.]+$/,''),meta:{mime:file.type,width:bitmap.width,height:bitmap.height},files:[{path:'file',blob:file,mime:file.type}]});bitmap.close?.();
  }else asset=(await apiFile('image',file,file.name)).asset;
  await wear(asset);status(`「${asset.name}」を使っています。`);
 }
 async function startImageSet(){
  const files=await avatarPick({accept:'image/png,image/jpeg,image/webp,image/avif',multiple:true});if(!files.length)return;
  if(files.length>12)throw new Error('画像は12枚までです。');
  for(const f of draft?.files||[])URL.revokeObjectURL(f.url);
  draft={files:files.map(file=>({file,url:URL.createObjectURL(file),mood:avatarGuessMood(file.name)}))};
  document.querySelector('#av-draft').innerHTML=draftHTML();
 }
 async function finishImageSet(){
  const chosen=draft.files.filter(f=>f.mood!=='skip'),moods={};let talkOpen=null;
  const names=new Map(),files=[];
  for(const f of chosen){
   const ext=(f.file.name.match(/\.(png|webp|jpe?g|avif)$/i)?.[1]||'png').toLowerCase(),base=`${f.mood}`;
   let name=`images/${base}.${ext}`,n=1;while(names.has(name))name=`images/${base}-${++n}.${ext}`;names.set(name,true);
   files.push({path:name,blob:f.file,mime:f.file.type||`image/${ext==='jpg'?'jpeg':ext}`});
   if(f.mood==='talkOpen')talkOpen=name;else if(!moods[f.mood])moods[f.mood]=name;
  }
  if(!moods.idle)throw new Error('「いつも」の画像を選んでください。');
  const sheet={version:1,moods,...(talkOpen?{talkOpen}:{})},sheetBlob=new Blob([JSON.stringify(sheet)],{type:'application/json'}),name=chosen.find(f=>f.mood==='idle')?.file.name.replace(/\.[^.]+$/,'')||'画像セット';
  status('画像セットを確認しています…');
  const asset=previewMode?previewAvatar.add({kind:'imageset',name,meta:{moods:Object.keys(moods),talkOpen:!!talkOpen},files:[{path:'imageset.json',blob:sheetBlob,mime:'application/json'},...files]})
   :(await apiFile('imageset',avatarBuildPack('imageset',name,[{path:'imageset.json',blob:sheetBlob},...files]),`${name}.tpak`)).asset;
  for(const f of draft.files)URL.revokeObjectURL(f.url);draft=null;document.querySelector('#av-draft').innerHTML='';
  await wear(asset);status(`「${asset.name}」を使っています。`);
 }
 async function addMesh(){
  const picked=await avatarPick({directory:true});if(!picked.length)return;
  const files=avatarMeshFiles(picked);
  if(!files.length)throw new Error('rig.json が見つかりません。mesh-avatar-studio の projects/＜名前＞ フォルダを選んでください。');
  const name=String(picked[0].webkitRelativePath||'').split('/')[0]||'メッシュアバター';
  status('メッシュアバターを確認しています…');
  let asset;
  if(previewMode){
   const rig=JSON.parse(await files.find(f=>f.path==='rig.json').blob.text());
   asset=previewAvatar.add({kind:'mesh',name,meta:{rigVersion:rig.version,width:rig.image?.width,height:rig.image?.height,layers:files.length,sprites:files.some(f=>f.path.includes('sprites'))},files:files.map(f=>({path:f.path,blob:f.blob,mime:f.path.endsWith('.json')?'application/json':'image/png'}))});
  }else asset=(await apiFile('mesh',avatarBuildPack('mesh',name,files),`${name}.tpak`)).asset;
  await wear(asset);status(`「${asset.name}」を使っています。`);
 }
 const actions={
  'av-set':async el=>{await apply(avatarNestedPatch(el.dataset.key,el.dataset.value));},
  'av-dice':async()=>{await apply(randomPatch());status('さいころを振りました。気に入らなければ「前に戻す」で戻せます。');},
  'av-undo':async()=>{await bridge.request('/api/avatar/undo','POST',{expectedRevision:spec().revision});},
  'av-reset':async()=>{await bridge.request('/api/avatar/reset','POST',{expectedRevision:spec().revision});status('既定の姿に戻しました。');},
  'av-export':async()=>{saveFile('tepora-avatar.json',JSON.stringify(await bridge.request('/api/avatar/export'),null,2));},
  'av-import':async()=>{const preset=await chooseJSON();if(!preset)return;await bridge.request('/api/avatar/import','POST',{preset,expectedRevision:spec().revision});status('姿の設定を読み込みました。');},
  'av-mood':async el=>{previewMood=el.dataset.value;for(const b of document.querySelectorAll('#avatar-sheet [data-action="av-mood"]'))b.setAttribute('aria-pressed',String(b.dataset.value===previewMood));preview?.setMood(previewMood);},
  'av-add':async el=>{const kind=el.dataset.kind;await ({vrm:addVRM,image:addImage,imageset:startImageSet,mesh:addMesh}[kind])();},
  'av-wear':async el=>{const a=assets().find(x=>x.id===el.dataset.id);if(a)await wear(a);},
  'av-remove':async el=>{
   const id=el.dataset.id,a=assets().find(x=>x.id===id);if(!a)return;
   await bridge.request(`/api/avatar/assets/${encodeURIComponent(id)}`,'DELETE');status(`「${a.name}」を削除しました。元のファイルはそのまま残っています。`);
  },
  'av-draft-go':async()=>{await finishImageSet();},
  'av-draft-cancel':async()=>{for(const f of draft?.files||[])URL.revokeObjectURL(f.url);draft=null;document.querySelector('#av-draft').innerHTML='';}
 };
 const run=(fn,el)=>Promise.resolve(fn(el)).catch(err=>{notice(err?.message||String(err),'error');status(err?.message||'');});
 document.addEventListener('click',e=>{
  const b=e.target.closest?.('[data-action^="av-"]');if(!b||b.matches('input,select')||!isOpen()||!actions[b.dataset.action])return;
  run(actions[b.dataset.action],b);
 });
 document.addEventListener('change',e=>{
  const el=e.target;if(!el.dataset?.action?.startsWith('av-')||!isOpen())return;
  if(el.dataset.action==='av-toggle')run(()=>apply(avatarNestedPatch(el.dataset.key,el.checked)),el);
  else if(el.dataset.action==='av-range')run(()=>apply(avatarNestedPatch(el.dataset.key,Number(el.value))),el);
  else if(el.dataset.action==='av-draft-mood'&&draft)draft.files[Number(el.dataset.index)].mood=el.value;
 });
 document.addEventListener('input',e=>{
  const el=e.target;if(el.dataset?.action!=='av-range'||!isOpen())return;
  const label=el.closest('.av-range')?.querySelector('b');if(label)label.textContent=el.dataset.key==='size'?`${Math.round(Number(el.value)*100)}%`:`${Math.round(Number(el.value))}°`;
 });
 return {open(){draft=null;openSheet('キャラクターの姿',content(),'avatar');mountPreview();},refresh,close(){abort?.abort();preview?.destroy();preview=null;}};
}
