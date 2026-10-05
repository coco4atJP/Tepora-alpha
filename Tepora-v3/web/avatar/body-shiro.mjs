/* ===== A. しろ・改: the cream figure, refined (lit by the room, rounder hands, lids and brows, a real lamp) ===== */
import {avatarFace,avatarFx,avatarLamp,avatarLampDefs,avatarProps} from './kit.mjs';

export const AVATAR_BODY_SHIRO=(()=>{

 const SHAPES={
  egg:{d:'M100 48C142 48 170 80 175 122C180 170 150 206 100 206C50 206 20 170 25 122C30 80 58 48 100 48Z',top:48,faceY:126,gap:24,cheek:44,arm:[27,152],neckY:168,neckW:62,headW:126,rim:'M46 98C50 72 68 56 94 52'},
  mochi:{d:'M100 68C150 68 184 98 186 142C188 184 150 206 100 206C50 206 12 184 14 142C16 98 50 68 100 68Z',top:68,faceY:142,gap:28,cheek:55,arm:[19,160],neckY:174,neckW:72,headW:146,rim:'M32 116C36 94 60 76 92 72'},
  tall:{d:'M100 36C136 36 160 68 164 110C168 162 142 206 100 206C58 206 32 162 36 110C40 68 64 36 100 36Z',top:36,faceY:110,gap:21,cheek:37,arm:[35,142],neckY:152,neckW:50,headW:104,rim:'M50 86C54 60 74 42 96 39'}
 };
 const shoulder=(side,S)=>{const [ax,ay]=S.arm;const x=side<0?ax+9:200-ax-9,y=ay-24;return [x,y];};
 const limb=(side,S)=>{const [ax,ay]=S.arm,[sx,sy]=shoulder(side,S),hx=side<0?ax:200-ax,mx=(sx+hx)/2,my=(sy+ay)/2,ang=Math.atan2(hx-sx,ay-sy)*180/Math.PI;
  return `<g class="arm arm-${side<0?'l':'r'}" style="--ox:${sx}px;--oy:${sy}px"><ellipse class="limb" cx="${mx}" cy="${my}" rx="8.6" ry="${Math.hypot(hx-sx,ay-sy)/2+9}" transform="rotate(${-ang} ${mx} ${my})"/></g>`;};
 const arm=(side,S)=>{const [ax,ay]=S.arm,[sx,sy]=shoulder(side,S),hx=side<0?ax:200-ax;
  return `<g class="arm arm-${side<0?'l':'r'}" style="--ox:${sx}px;--oy:${sy}px"><ellipse class="mitt" cx="${hx}" cy="${ay}" rx="10.5" ry="12.5"/><ellipse cx="${hx-3}" cy="${ay-5}" rx="3.6" ry="2.6" fill="#fff" opacity=".5"/></g>`;};
 const ears=(kind,S,u)=>{
  const T=S.top,L=100-S.headW*.36,R=100+S.headW*.36;
  if(kind==='cat')return `<g class="ear ear-l" style="--ox:${L+8}px;--oy:${T+30}px"><path d="M${L-14} ${T+34}L${L-8} ${T-10}Q${L-6} ${T-15} ${L-1} ${T-11}L${L+30} ${T+10}Z" fill="var(--c-body)"/><path d="M${L-6} ${T+22}L${L-3} ${T+2}L${L+14} ${T+13}Z" fill="var(--c-cheek)" opacity=".5"/></g><g class="ear ear-r" style="--ox:${R-8}px;--oy:${T+30}px"><path d="M${R+14} ${T+34}L${R+8} ${T-10}Q${R+6} ${T-15} ${R+1} ${T-11}L${R-30} ${T+10}Z" fill="var(--c-body)"/><path d="M${R+6} ${T+22}L${R+3} ${T+2}L${R-14} ${T+13}Z" fill="var(--c-cheek)" opacity=".5"/></g>`;
  if(kind==='bear')return `<g class="ear ear-l" style="--ox:${L}px;--oy:${T+26}px"><circle cx="${L-4}" cy="${T+16}" r="16" fill="var(--c-body)"/><circle cx="${L-4}" cy="${T+17}" r="8.5" fill="var(--c-shade)" opacity=".7"/></g><g class="ear ear-r" style="--ox:${R}px;--oy:${T+26}px"><circle cx="${R+4}" cy="${T+16}" r="16" fill="var(--c-body)"/><circle cx="${R+4}" cy="${T+17}" r="8.5" fill="var(--c-shade)" opacity=".7"/></g>`;
  if(kind==='rabbit')return `<g class="ear ear-l" style="--ox:${L+12}px;--oy:${T+16}px"><ellipse cx="${L+10}" cy="${T-14}" rx="11.5" ry="31" transform="rotate(-9 ${L+10} ${T-14})" fill="var(--c-body)"/><ellipse cx="${L+10}" cy="${T-12}" rx="5.4" ry="23" transform="rotate(-9 ${L+10} ${T-12})" fill="var(--c-cheek)" opacity=".42"/></g><g class="ear ear-r" style="--ox:${R-12}px;--oy:${T+16}px"><ellipse cx="${R-10}" cy="${T-14}" rx="11.5" ry="31" transform="rotate(9 ${R-10} ${T-14})" fill="var(--c-body)"/><ellipse cx="${R-10}" cy="${T-12}" rx="5.4" ry="23" transform="rotate(9 ${R-10} ${T-12})" fill="var(--c-cheek)" opacity=".42"/></g>`;
  return '';
 };
 return {
  id:'shiro',
  svg(r,u){
   const S=SHAPES[r.slots?.shape]||SHAPES.egg,eyes=r.face?.eyes||'capsule',g=S.gap,ax=100,ay=S.top+2,[armX,armY]=S.arm,lampShape=r.lamp?.shape||'bead';
   const A={top:[100,S.top+2],headW:S.headW,headH:92,face:[100,S.faceY],eyeGap:g,handR:[200-armX+2,armY+2],neck:[100,S.neckY,S.neckW]};
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id="${u}-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".6" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></linearGradient>
   <linearGradient id="${u}-e" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".62" stop-color="var(--c-shade)" stop-opacity="0"/><stop offset="1" stop-color="var(--c-shade)" stop-opacity=".55"/></linearGradient>
   <radialGradient id="${u}-ao" cx=".5" cy="1" r=".62"><stop offset="0" stop-color="var(--c-shade)" stop-opacity=".85"/><stop offset="1" stop-color="var(--c-shade)" stop-opacity="0"/></radialGradient>
   <radialGradient id="${u}-hl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
   <clipPath id="${u}-c"><path d="${S.d}"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="floor" cx="100" cy="212" rx="${S.headW*.46}" ry="7"/>
  <g class="pose"><g class="breath">
   <g class="antenna" style="--ox:${ax}px;--oy:${ay}px"><g class="sway" style="--ox:${ax}px;--oy:${ay}px">
    <path class="stem" d="M${ax} ${ay}C${ax-1} ${ay-14} ${ax+4} ${ay-24} ${ax+13} ${ay-31}"/>${avatarLamp(u,lampShape,ax+13,ay-33,1.05)}
   </g></g>
   ${ears(r.parts?.ears,S,u)}
   <ellipse class="foot" cx="78" cy="205" rx="15.5" ry="7.5"/><ellipse class="foot" cx="122" cy="205" rx="15.5" ry="7.5"/>
   ${limb(-1,S)}${limb(1,S)}
   <path class="shell" fill="url(#${u}-b)" d="${S.d}"/>
   <g clip-path="url(#${u}-c)"><rect x="0" y="0" width="200" height="224" fill="url(#${u}-e)"/><ellipse cx="100" cy="212" rx="96" ry="64" fill="url(#${u}-ao)" opacity=".7"/><ellipse class="hl" cx="${S.rim?70:70}" cy="${S.top+38}" rx="34" ry="22" transform="rotate(-26 70 ${S.top+38})" fill="url(#${u}-hl)"/></g>
   <path class="rim" d="${S.rim}"/>
   ${arm(-1,S)}${arm(1,S)}
   <g transform="translate(0 ${S.faceY-126})">${avatarFace(r,{g,c:S.cheek})}</g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[S.headW>130?160:150,S.top+10],sweat:[146,S.faceY-24],z:[148,S.top+14],dots:[146,S.top+4]})}
 </svg>`;
  },
  init(svg,h){return {};}
 };
})();
