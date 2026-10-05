/** The photo frame sheet: add and remove photos, and choose how they are shown. Photos are prepared
 * here, in the browser (a large one is scaled to a size a screen can use), then stored by the
 * service on this PC. In the offline preview they stay in this window only. */
import {escape,btn,icon} from './ui.mjs';
import {FRAME_SECONDS} from './display-model.mjs';
import {FRAME_MAX_EDGE,fitWithin,framePhotos,framePreview} from './frame.mjs';

const FRAME_SECOND_LABEL={10:'10秒',30:'30秒',60:'1分',300:'5分',900:'15分',3600:'1時間'};
const FRAME_ACCEPT='image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.gif,.avif,.heic,.heif';
const FRAME_DIRECT=['image/jpeg','image/png','image/webp','image/avif'];
const frameValue=v=>v==='true'?true:v==='false'?false:/^\d+$/.test(v)?Number(v):v;

/** A scene to try the frame with in the offline preview. Abstract, drawn here, never fetched. */
export function sampleFramePhotos(){
 const svg=(w,h,body)=>`data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`;
 return [
  {name:'日だまりの丘',url:svg(1600,1000,'<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6e7cf"/><stop offset="1" stop-color="#f2c9a4"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#a)"/><circle cx="1150" cy="300" r="120" fill="#fff4dc" opacity=".9"/><path d="M0 640C260 520 520 560 800 620S1360 560 1600 600V1000H0z" fill="#d8b98a"/><path d="M0 760C300 660 620 720 900 760S1380 700 1600 740V1000H0z" fill="#a9b48d"/><path d="M0 880C320 820 700 860 1000 890S1400 850 1600 870V1000H0z" fill="#7e9272"/>')},
  {name:'夕暮れ',url:svg(1600,1000,'<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2540"/><stop offset=".55" stop-color="#7a4a58"/><stop offset="1" stop-color="#e58a62"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#b)"/><circle cx="420" cy="640" r="70" fill="#ffd9a8" opacity=".85"/><path d="M0 700C300 640 600 700 900 690S1400 640 1600 680V1000H0z" fill="#2a2036"/><path d="M0 820C340 770 700 830 1000 820S1400 780 1600 810V1000H0z" fill="#171220"/><circle cx="1180" cy="760" r="9" fill="#ef7a58"/>')},
  {name:'朝のもや',url:svg(1600,1000,'<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe7ea"/><stop offset="1" stop-color="#b9c8cc"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#c)"/><path d="M0 560H1600" stroke="#fff" stroke-width="2" opacity=".6"/><ellipse cx="800" cy="560" rx="560" ry="46" fill="#fff" opacity=".35"/><path d="M0 640C300 600 640 650 960 630S1400 600 1600 625V1000H0z" fill="#9db0b3"/><path d="M0 760C360 720 720 770 1040 750S1420 730 1600 745V1000H0z" fill="#788f93"/>')},
  {name:'月と木（縦長）',url:svg(1000,1400,'<defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26324a"/><stop offset="1" stop-color="#6d5a6e"/></linearGradient></defs><rect width="1000" height="1400" fill="url(#d)"/><circle cx="700" cy="360" r="120" fill="#f6ecd2"/><path d="M0 1120C260 1060 560 1100 1000 1070V1400H0z" fill="#191625"/><path d="M470 1100V760M470 900C400 860 360 820 330 760M470 840C540 800 590 760 620 700" stroke="#191625" stroke-width="22" stroke-linecap="round" fill="none"/>')}
 ].map((p,i)=>({...p,id:`sample:${i}`}));
}

/** Makes a chosen file ready to store: unreadable files are refused, large ones are scaled down. */
export async function prepareFramePhoto(file){
 const name=file.name||'写真';
 if(!/^image\//.test(file.type)&&!/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(name))throw new Error('画像ファイルを選んでください。');
 if(file.type==='image/gif'||/\.gif$/i.test(name)){
  if(file.size>24*1024*1024)throw new Error('GIFは24MBまでです。');
  return {blob:file,name};
 }
 let bitmap;
 try{bitmap=await createImageBitmap(file);}catch{throw new Error('この画像は読み込めません。JPEG・PNG・WebPで試してください。');}
 const size=fitWithin(bitmap.width,bitmap.height,FRAME_MAX_EDGE);
 if(FRAME_DIRECT.includes(file.type)&&!size.scaled&&file.size<=8*1024*1024){bitmap.close?.();return {blob:file,name};}
 const canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
 const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,size.width,size.height);context.drawImage(bitmap,0,0,size.width,size.height);bitmap.close?.();
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));
 if(!blob)throw new Error('画像を変換できませんでした。');
 return {blob,name:`${name.replace(/\.[^.]+$/,'')}.jpg`};
}

export function createFrameSettings({bridge,openSheet,notice,previewMode,isOpen,stored,created,ambient,setAmbient,onPhotos}){
 const root=()=>document.querySelector('#frame-sheet');
 function optionsHTML(a){
  const group=(label,key,options)=>`<div class="frame-opt"><span>${label}</span><div class="segmented" role="group" aria-label="${label}">${options.map(([v,t])=>`<button type="button" data-action="frame-opt" data-key="${key}" data-value="${v}" aria-pressed="${String(a[key])===String(v)}">${t}</button>`).join('')}</div></div>`;
  return [group('切り替え','frameSeconds',FRAME_SECONDS.map(n=>[n,FRAME_SECOND_LABEL[n]])),group('順番','frameShuffle',[[true,'シャッフル'],[false,'追加順']]),
   group('表示','frameFit',[['cover','画面いっぱい'],['contain','全体'],['mat','額装']]),group('動き','frameMotion',[[true,'ゆっくり動かす'],[false,'止める']]),
   group('時計','frameClock',[['off','なし'],['small','小さく'],['large','大きく']]),group('つくった画像','frameCreated',[[true,'混ぜる'],[false,'混ぜない']])].join('');
 }
 function gridHTML(list){
  if(!list.length)return '<p class="frame-empty">まだ写真がありません。「写真を追加」から選んでください。</p>';
  return `<ul class="frame-grid">${list.map(p=>`<li class="frame-tile"><img src="${escape(p.url)}" alt="${escape(p.name||'写真')}" loading="lazy" decoding="async"><button type="button" class="icon-button" data-action="frame-remove" data-id="${escape(p.id)}" aria-label="${escape(p.name||'この写真')}を外す">${icon('close')}</button></li>`).join('')}</ul>`;
 }
 const summary=list=>`${list.length}枚${created().length&&ambient().frameCreated?` · つくった画像 ${created().length}枚も混ぜます`:''}`;
 function content(){
  const list=framePhotos({photos:stored(),includeCreated:false});
  return `<div id="frame-sheet"><p>待機画面に、写真をゆっくり映します。選んだ写真はこのPCに保存し、外へは送りません。大きな写真は、画面に十分な大きさ（長辺${FRAME_MAX_EDGE}px）に整えて保存します。${previewMode?'このプレビューでは、保存せず、この画面を開いている間だけ表示します。':''}</p>
  <div class="sheet-actions">${btn('frame-add','写真を追加','upload','button')}${previewMode?btn('frame-sample','サンプルを入れる','image','button secondary'):''}${btn('frame-now','写真立てを始める','','text-button')}</div>
  <div id="frame-progress" class="small-text" role="status"></div>
  <div id="frame-grid">${gridHTML(list)}</div><p id="frame-count" class="small-text">${summary(list)}</p>
  <div id="frame-options" class="frame-options">${optionsHTML(ambient())}</div></div>`;
 }
 function refresh(){
  if(!isOpen()||!root())return;
  const list=framePhotos({photos:stored(),includeCreated:false});
  document.querySelector('#frame-grid').innerHTML=gridHTML(list);document.querySelector('#frame-count').textContent=summary(list);
  document.querySelector('#frame-options').innerHTML=optionsHTML(ambient());
 }
 const progress=text=>{const el=document.querySelector('#frame-progress');if(el)el.textContent=text;};
 const pick=()=>new Promise(resolve=>{
  const input=document.createElement('input');input.type='file';input.multiple=true;input.accept=FRAME_ACCEPT;
  input.onchange=()=>resolve([...input.files]);input.addEventListener('cancel',()=>resolve([]),{once:true});input.click();
 });
 const actions={
  async 'frame-add'(){
   const files=await pick();if(!files.length)return;
   const failed=[];let added=0;
   for(const [i,file] of files.entries()){
    progress(`${i+1} / ${files.length}枚を整えています…`);
    try{
     const item=await prepareFramePhoto(file);
     if(previewMode){framePreview.push({id:`preview:${globalThis.crypto?.randomUUID?.()||Date.now()+Math.random()}`,name:item.name,url:URL.createObjectURL(item.blob)});onPhotos(null);}
     else onPhotos(await bridge.request('/api/frame/photos','PUT',item.blob,{'X-Tepora-Filename':encodeURIComponent(item.name)}));
     added++;refresh();
    }catch(e){failed.push(`${file.name}: ${e.message}`);}
   }
   progress(failed.length?`${added}枚を追加しました。${failed.length}枚は追加できませんでした。${failed[0]}`:`${added}枚を追加しました。`);
   if(added&&!failed.length)notice(`${added}枚を追加しました。待機画面の壁紙を「写真」にすると映ります。`);
  },
  'frame-sample'(){
   if(!previewMode)return;
   for(const p of sampleFramePhotos())if(!framePreview.some(x=>x.id===p.id))framePreview.push(p);
   onPhotos(null);refresh();progress('サンプルの風景を入れました。');
  },
  async 'frame-remove'(el){
   const id=el.dataset.id;
   if(previewMode){const i=framePreview.findIndex(p=>p.id===id);if(i>=0){const [gone]=framePreview.splice(i,1);if(gone.url.startsWith('blob:'))URL.revokeObjectURL(gone.url);}onPhotos(null);}
   else onPhotos(await bridge.request(`/api/frame/photos/${encodeURIComponent(id)}`,'DELETE'));
   refresh();progress('写真を外しました。元のファイルはそのまま残っています。');
  },
  async 'frame-opt'(el){await setAmbient({[el.dataset.key]:frameValue(el.dataset.value)});refresh();}
 };
 document.addEventListener('click',e=>{
  const b=e.target.closest('[data-action]');if(!b||!isOpen()||!actions[b.dataset.action])return;
  Promise.resolve(actions[b.dataset.action](b)).catch(err=>notice(err.message||String(err),'error'));
 });
 return {open(){openSheet('写真立て',content(),'frame');},refresh};
}
