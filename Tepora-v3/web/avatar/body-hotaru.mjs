/* ===== F. 蛍 (hotaru): no body at all. A soft light that listens, thinks and speaks by how it glows and moves.
 * The same species as the work lights, only larger; the brand dot floats beside it. ===== */
import {avatarFace,avatarFx,avatarLamp,avatarLampDefs,avatarProps} from './kit.mjs';

export const AVATAR_BODY_HOTARU=(()=>{

 return {
  id:'hotaru',
  svg(r,u){
   const vis=r.slots?.faceVis||'always',halo=r.slots?.halo||'soft',lampShape=r.lamp?.shape||'bead',g=15;
   const A={top:[100,70],headW:90,headH:60,face:[100,112],eyeGap:g,handR:[150,128],neck:[100,148,40]};
   return `<svg viewBox="0 0 200 224" class="face-${vis} halo-${halo}" aria-hidden="true" focusable="false">
  <defs>
   <radialGradient id="${u}-o" cx=".4" cy=".34" r=".75"><stop offset="0" stop-color="#fffef9"/><stop offset=".42" stop-color="var(--c-light)"/><stop offset=".78" stop-color="var(--c-body)"/><stop offset="1" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".42"/></radialGradient>
   <radialGradient id="${u}-h"><stop offset="0" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".34"/><stop offset=".5" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".12"/><stop offset="1" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity="0"/></radialGradient>
   <radialGradient id="${u}-p"><stop offset="0" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".34"/><stop offset="1" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity="0"/></radialGradient>
   <filter id="${u}-bl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
   <clipPath id="${u}-oc"><circle cx="100" cy="112" r="42"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="pool" cx="100" cy="210" rx="56" ry="8" fill="url(#${u}-p)"/>
  <g class="pose"><g class="float">
   <circle class="halo-c" cx="100" cy="112" r="98" fill="url(#${u}-h)"/>
   <g class="orb">
    <circle class="orb-body" cx="100" cy="112" r="42" fill="url(#${u}-o)"/>
    <g clip-path="url(#${u}-oc)"><g class="swirl" filter="url(#${u}-bl)"><circle cx="86" cy="98" r="19" fill="#fff" opacity=".7"/><circle cx="118" cy="128" r="14" fill="rgb(var(--c-lamp-rgb))" opacity=".16"/></g></g>
    <path class="rim" d="M68 94C73 79 87 70 101 70"/>
    <g transform="translate(0 -14)">${avatarFace(r,{g,c:29,my:3})}</g>
   </g>
   <g class="bead" style="--ox:100px;--oy:112px">${avatarLamp(u,lampShape,146,56,1.1)}</g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[150,100],sweat:[134,92],z:[142,58],dots:[40,60]})}
 </svg>`;
  }
 };
})();
