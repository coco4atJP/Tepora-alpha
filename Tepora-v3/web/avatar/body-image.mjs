/** A picture, or a set of pictures (one per mood), as the body. The picture is never touched: breathing, sway,
 * a lamp and the mood poses come from the same layer every drawn body uses. Pictures are only ever referenced by
 * the service's own asset URLs (or a blob made by the page in the offline preview).
 */
import {avatarFx,avatarLamp,avatarLampDefs} from './kit.mjs';

export const AVATAR_BODY_IMAGE=(()=>{
 const SAFE=/^(\/api\/avatar\/assets\/[a-f0-9-]{36}\/files\/[A-Za-z0-9_.\/%-]{1,200}|blob:[^\s"'<>]{1,300})$/;
 const safe=url=>{if(typeof url!=='string'||!SAFE.test(url))throw new Error('画像の場所が正しくありません。');return url;};
 return {
  id:'image',
  svg(r,u){
   const pics=r.pictures||{},keys=Object.keys(pics);
   if(!keys.includes('idle'))throw new Error('画像がありません。');
   const lamp=r.lamp?.shape==='none'?'':`<g class="bead" style="--ox:100px;--oy:112px">${avatarLamp(u,r.lamp?.shape||'bead',152,36,1.1)}</g>`;
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
 <defs>${avatarLampDefs(u)}<radialGradient id="${u}-h"><stop offset="0" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".32"/><stop offset="1" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity="0"/></radialGradient></defs>
 <ellipse class="floor" cx="100" cy="212" rx="58" ry="7"/>
 <g class="pose"><g class="breath">
  <circle class="pic-halo" cx="100" cy="116" r="98" fill="url(#${u}-h)"/>
  <g class="pics">${keys.map(key=>`<image class="pic" data-pic="${key.replace(/[^A-Za-z]/g,'')}" href="${safe(pics[key])}" x="16" y="18" width="168" height="190" preserveAspectRatio="xMidYMax meet"${key==='idle'?'':' visibility="hidden"'}/>`).join('')}</g>
  ${lamp}
 </g></g>
 ${avatarFx({spark:[28,52],sweat:[160,80],z:[150,52],dots:[40,36]})}
</svg>`;
  },
  init(svg,h){
   const pics=[...svg.querySelectorAll('.pic')],by=Object.fromEntries(pics.map(p=>[p.dataset.pic,p]));
   let mood='idle',level=0,timer=0,open=false;
   const show=key=>{for(const p of pics)p.setAttribute('visibility',p.dataset.pic===key?'visible':'hidden');};
   const rest=()=>by[mood]?mood:'idle';
   const apply=()=>{
    clearInterval(timer);timer=0;
    if(mood==='talking'&&by.talkOpen&&!h.isReduced()){
     const closed=by.talking?'talking':'idle';
     timer=setInterval(()=>{open=!open&&level>.12;show(open?'talkOpen':closed);},130);show(closed);
    }else show(rest());
   };
   apply();
   return {setMood(m){mood=m;apply();},setLevel(v){level=Number(v)||0;},setReduced(){apply();},destroy(){clearInterval(timer);}};
  }
 };
})();
