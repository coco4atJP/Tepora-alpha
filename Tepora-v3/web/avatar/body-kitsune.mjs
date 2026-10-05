/* ===== E. 狐火 (kitsunebi): a small white fox with a lamp at the tip of its tail. Ears and tail do the talking. ===== */
import {avatarFace,avatarFx,avatarLamp,avatarLampDefs,avatarMirror,avatarProps} from './kit.mjs';

export const AVATAR_BODY_KITSUNE=(()=>{

 const BODY='M100 54C132 54 156 70 164 98L184 114L171 134C175 142 177 150 175 158C171 184 143 206 100 206C57 206 29 184 25 158C23 150 25 142 29 134L16 114L36 98C44 70 68 54 100 54Z';
 const EAR={outer:'M42 96C38 68 44 40 54 22C58 16 66 18 72 24C84 36 94 48 98 62Z',inner:'M54 80C52 62 55 46 60 34C68 40 78 50 84 62Z',tip:'M52 18L76 18L84 36L46 52Z'};
 const TAIL='M148 206C190 214 234 192 232 148C231 118 222 88 214 62C209 50 198 48 195 60C191 84 186 104 172 126C160 146 140 176 148 206Z';
 const TAIL_TIP='M180 114Q208 96 240 106L242 28L176 28Z';
 const earSVG=(side,u,kind)=>{
  const L=side<0,o=EAR.outer,i=EAR.inner,t=EAR.tip,P=d=>L?d:avatarMirror(d),ox=L?72:128,id=`${u}-ear${L?'l':'r'}`;
  const tall=kind==='long'?`transform="${L?'translate(8 -4) rotate(-7 60 60) scale(.96 1.22)':'translate(-8 -4) rotate(7 140 60) scale(.96 1.22)'}"`:'';
  return `<g class="ear ear-${L?'l':'r'}" style="--ox:${ox}px;--oy:76px"><g ${tall}><clipPath id="${id}"><path d="${P(o)}"/></clipPath><path class="ear-o" d="${P(o)}"/><path class="ear-i" d="${P(i)}"/><path class="ear-t" d="${P(t)}" clip-path="url(#${id})"/></g></g>`;
 };
 return {
  id:'kitsune',
  svg(r,u){
   const lampShape=r.lamp?.shape||'flame',g=27,eyes=r.face?.eyes||'capsule';
   const A={top:[100,56],headW:150,headH:96,face:[100,132],eyeGap:g,handR:[150,176],neck:[100,176,60]};
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id="${u}-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".6" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></linearGradient>
   <linearGradient id="${u}-t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".6" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></linearGradient>
   <radialGradient id="${u}-ao" cx=".5" cy="1" r=".62"><stop offset="0" stop-color="var(--c-shade)" stop-opacity=".85"/><stop offset="1" stop-color="var(--c-shade)" stop-opacity="0"/></radialGradient>
   <radialGradient id="${u}-hl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
   <clipPath id="${u}-c"><path d="${BODY}"/></clipPath><clipPath id="${u}-tc"><path d="${TAIL}"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="floor" cx="100" cy="212" rx="64" ry="7"/>
  <g transform="translate(-12 14) scale(.9)"><g class="pose"><g class="breath">
   <g class="tail" style="--ox:156px;--oy:200px"><g class="tail-sway" style="--ox:156px;--oy:200px">
    <path class="tail-body" d="${TAIL}" fill="url(#${u}-t)"/>
    <path class="tail-tip" d="${TAIL_TIP}" clip-path="url(#${u}-tc)"/>
    <path class="tail-rim" d="M226 152C229 126 222 98 212 72" />
    <g class="foxfire">${avatarLamp(u,lampShape,205,40,1.15)}</g>
   </g></g>
   ${earSVG(-1,u,r.slots?.ears)}${earSVG(1,u,r.slots?.ears)}
   <ellipse class="paw" cx="78" cy="205" rx="16" ry="8"/><ellipse class="paw" cx="122" cy="205" rx="16" ry="8"/>
   <path class="shell" fill="url(#${u}-b)" d="${BODY}"/>
   <g clip-path="url(#${u}-c)"><ellipse cx="100" cy="214" rx="100" ry="66" fill="url(#${u}-ao)" opacity=".7"/><ellipse cx="72" cy="82" rx="36" ry="20" transform="rotate(-24 72 82)" fill="url(#${u}-hl)"/>
    <ellipse class="muzzle" cx="100" cy="153" rx="34" ry="23"/></g>
   <g transform="translate(0 6)">${avatarFace(r,{g,c:56,my:11,browShort:true})}
    <path class="nose" d="M94 143Q100 139 106 143Q103.5 150 100 151Q96.5 150 94 143Z" transform="translate(0 -6)"/></g>
   ${avatarProps(r,A,u)}
  </g></g></g>
  ${avatarFx({spark:[16,70],sweat:[134,96],z:[58,30],dots:[52,22]})}
 </svg>`;
  }
 };
})();
