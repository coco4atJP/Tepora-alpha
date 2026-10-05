/* ===== G. 苔玉 (kokedama): a moss ball with a sprout whose bud is the lamp. It leans toward the window, folds its leaves at night,
 * and changes leaf colour with the season. ===== */
import {avatarFace,avatarFx,avatarLamp,avatarLampDefs,avatarMirror,avatarProps} from './kit.mjs';

export const AVATAR_BODY_KOKEDAMA=(()=>{

 const seasonLeaf=()=>{const m=new Date().getMonth()+1;return m>=3&&m<=5?['#a9c68c','#7fa066']:m>=6&&m<=8?['#6f9a55','#4f7a3e']:m>=9&&m<=11?['#c9954f','#a4692f']:['#8aa27c','#667f5a'];};
 function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
 const LEAF_L='M101 86C86 90 70 82 62 64C80 58 98 68 101 86Z',LEAF_R=avatarMirror('M101 86C86 90 70 82 62 64C80 58 98 68 101 86Z').replace(/^M99/,'M99');
 const LEAF_SM_L='M102 68C96 67 91 62 90 55C97 55 101 60 102 68Z';
 const fuzz=(seed)=>{const R=rng(seed),o=[];for(let i=0;i<110;i++){const a=R()*Math.PI*2,d=Math.sqrt(R())*44,x=100+Math.cos(a)*d,y=160+Math.sin(a)*d,rx=2.2+R()*2.6,ry=1.5+R()*1.6,rot=Math.floor(R()*180),dark=R()<.45;
  o.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${dark?'var(--c-shade)':'var(--c-light)'}" opacity="${dark?.55:.5}"/>`);}return o.join('');};
 return {
  id:'kokedama',
  svg(r,u){
   const lampShape=r.lamp?.shape||'bud',g=14,fv=r.slots?.faceVis||'always',leaves=r.slots?.leaves&&r.slots.leaves!=='auto'?r.slots.leaves:null;
   const LC=leaves?{spring:['#a9c68c','#7fa066'],summer:['#6f9a55','#4f7a3e'],autumn:['#c9954f','#a4692f'],winter:['#8aa27c','#667f5a']}[leaves]:seasonLeaf();
   const A={top:[100,114],headW:84,headH:50,face:[100,160],eyeGap:g,handR:[144,176],neck:[100,184,40]};
   return `<svg viewBox="0 0 200 224" class="face-${fv}" aria-hidden="true" focusable="false" style="--leaf:${LC[0]};--leaf-d:${LC[1]}">
  <defs>
   <radialGradient id="${u}-b" cx=".38" cy=".3" r=".85"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".45" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></radialGradient>
   <clipPath id="${u}-c"><circle cx="100" cy="160" r="46"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="floor" cx="100" cy="212" rx="62" ry="7"/>
  <g class="pose"><g class="breath">
   <ellipse class="dish" cx="100" cy="205" rx="60" ry="10"/><ellipse class="dish-in" cx="100" cy="203" rx="52" ry="6.5"/>
   <g class="sprout" style="--ox:100px;--oy:120px"><g class="sway" style="--ox:100px;--oy:120px">
    <path class="stem" d="M100 122C97 108 104 96 101 82C99.5 74 101 68 102 60"/>
    <g class="leaf leaf-l" style="--ox:101px;--oy:86px"><path class="leaf-b" d="${LEAF_L}"/><path class="leaf-v" d="M101 86C90 80 76 72 66 64"/></g>
    <g class="leaf leaf-r" style="--ox:99px;--oy:86px"><path class="leaf-b" d="${LEAF_R}"/><path class="leaf-v" d="${avatarMirror('M101 86C90 80 76 72 66 64')}"/></g>
    <g class="leaf leaf-sl" style="--ox:102px;--oy:68px"><path class="leaf-b" d="${LEAF_SM_L}"/></g>
    <g class="leaf leaf-sr" style="--ox:98px;--oy:68px"><path class="leaf-b" d="${avatarMirror(LEAF_SM_L)}"/></g>
    <g class="bud">${avatarLamp(u,lampShape,102,50,1.15)}</g>
   </g></g>
   <circle class="moss" cx="100" cy="160" r="46" fill="url(#${u}-b)"/>
   <g clip-path="url(#${u}-c)">${fuzz(7)}
    <path class="twine" d="M56 142Q100 176 144 142M54 170Q100 200 146 170M70 124Q82 168 118 196"/>
    <ellipse cx="78" cy="132" rx="22" ry="12" transform="rotate(-28 78 132)" fill="#fff" opacity=".22"/></g>
   <g class="kface" transform="translate(0 34)">${avatarFace(r,{g,c:25,my:2})}</g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[148,70],sweat:[138,134],z:[150,60],dots:[142,42]})}
 </svg>`;
  }
 };
})();
