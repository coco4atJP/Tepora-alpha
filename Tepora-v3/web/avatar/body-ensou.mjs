/* ===== C. 円相 (ensō): one brush stroke with a gap. The gap is the character: it turns to listen, opens to speak,
 * closes when something is finished. Drawn per frame so the brush can breathe. ===== */
import {avatarFx,avatarLamp,avatarLampDefs,avatarProps} from './kit.mjs';

export const AVATAR_BODY_ENSOU=(()=>{
 const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

 const rad=d=>d*Math.PI/180,ss=(a,b,x)=>{x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x);};
 const CX=100,CY=118,R0=62,W0=15;
 const MOODT={
  idle:{phi:135,gap:34,wob:1,thick:1,alpha:1},
  listening:{phi:92,gap:46,wob:1.2,thick:1,alpha:1},
  thinking:{phi:135,gap:26,wob:1.4,thick:.95,alpha:1},
  talking:{phi:92,gap:34,wob:1.2,thick:1.02,alpha:1},
  happy:{phi:135,gap:3,wob:.7,thick:1.1,alpha:1},
  attention:{phi:-38,gap:30,wob:1.1,thick:1.04,alpha:1},
  concerned:{phi:100,gap:58,wob:3.2,thick:.8,alpha:.92},
  sleepy:{phi:-90,gap:22,wob:.6,thick:.52,alpha:.58}
 };
 function geom(P,t){
  const N=150,sweep=360-P.gap,start=P.phi+P.gap/2,ph=P.seed,out=[],inn=[],mid=[];
  const nz=(x,k=0)=>Math.sin(x*1.7+ph+k)*.5+Math.sin(x*3.3+ph*1.7+k*2)*.3+Math.sin(x*7.1+ph*.6+k*3)*.2;
  for(let i=0;i<=N;i++){
   const u=i/N,th=rad(start+sweep*u);
   const load=(.55+.45*ss(0,.1,u))*(1+.28*(1-ss(0,.05,u))),fade=1-.86*ss(.58,1,u);
   const w=W0*P.thick*load*fade*(1+.07*nz(u*9,1)),r=R0*P.size+P.wob*1.5*nz(u*5+t*.15,2)-3.5*u+P.breath;
   const ro=r+w/2+.6*nz(u*40+t*.6,3),ri=r-w/2+.6*nz(u*37+t*.6,4);
   const c=Math.cos(th),s=Math.sin(th);
   out.push([CX+ro*c,CY+ro*s]);inn.push([CX+ri*c,CY+ri*s]);mid.push([CX+r*c,CY+r*s,w,th]);
  }
  const f=a=>a.map(p=>p[0].toFixed(1)+' '+p[1].toFixed(1));
  const d='M'+f(out).join('L')+'L'+f(inn.reverse()).join('L')+'Z';
  // dry-brush streaks (飛白) near the tail
  const sk=[[.62,-.28],[.56,.1],[.7,.3],[.48,-.05],[.76,-.12]],streaks=sk.map(([u0,off],k)=>{
   const pts=[];for(let i=Math.floor(u0*N);i<=N;i+=2){const m=mid[i];const rr=Math.hypot(m[0]-CX,m[1]-CY)+off*m[2];pts.push((CX+rr*Math.cos(m[3])).toFixed(1)+' '+(CY+rr*Math.sin(m[3])).toFixed(1));}
   return pts.length>2?`M${pts.join('L')}`:'';});
  return {d,streaks};
 }
 const E=new Set();let tk=0,last=0;
 function loop(now){
  tk=requestAnimationFrame(loop);if(document.hidden||now-last<32)return;
  const dt=Math.min(.12,(now-last)/1000);last=now;for(const e of E)e(now/1000,dt);
 }
 return {
  id:'ensou',
  svg(r,u){
   const eyes=r.slots?.eyes||'dot',g=17,lampShape=r.lamp?.shape||'bead';
   const eo={dot:`<ellipse cx="${100-g}" cy="116" rx="6.4" ry="7.8" transform="rotate(-8 ${100-g} 116)"/><ellipse cx="${100+g}" cy="116" rx="6.4" ry="7.8" transform="rotate(8 ${100+g} 116)"/>`,
    line:`<path d="M${100-g-7} 117Q${100-g} 114 ${100-g+7} 117" /><path d="M${100+g-7} 117Q${100+g} 114 ${100+g+7} 117"/>`,
    slit:`<rect x="${100-g-3.2}" y="106" width="6.4" height="20" rx="3.2"/><rect x="${100+g-3.2}" y="106" width="6.4" height="20" rx="3.2"/>`}[eyes]||'';
   const A={top:[100,CY-R0],headW:110,headH:70,face:[100,CY],eyeGap:g,handR:[158,150],neck:[100,CY+R0-4,48]};
   const face=`<g transform="translate(0 -8)"><g class="face"><g class="eyes"><g class="eo ${eyes==='line'?'eo-line':''}">${eo}</g>
    <g class="eh"><path d="M${100-g-8} 121Q${100-g} 107 ${100-g+8} 121"/><path d="M${100+g-8} 121Q${100+g} 107 ${100+g+8} 121"/></g>
    <g class="ec"><path d="M${100-g-8} 116Q${100-g} 122 ${100-g+8} 116"/><path d="M${100+g-8} 116Q${100+g} 122 ${100+g+8} 116"/></g></g>
    <path class="smile" d="M94 140Q100 146 106 140"/><ellipse class="mouth" cx="100" cy="142" rx="5" ry="4.5" style="transform-origin:100px 142px"/></g></g>`;
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
  <defs><radialGradient id="${u}-w" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="var(--wash)"/><stop offset="1" stop-color="var(--wash)" stop-opacity="0"/></radialGradient>
   <mask id="${u}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="224"><path class="ring-mask" fill="#fff" d=""/><g class="streaks" fill="none" stroke="#000" stroke-linecap="round" stroke-width="1.3" stroke-dasharray="16 7 24 9 12 11"></g></mask>${avatarLampDefs(u)}</defs>
  <ellipse class="floor" cx="100" cy="206" rx="54" ry="5.5"/>
  <g class="pose"><g class="breath">
   <circle class="wash" cx="${CX}" cy="${CY}" r="${R0-4}" fill="url(#${u}-w)"/>
   <g class="think-ring"><circle cx="${CX}" cy="${CY}" r="${R0-22}" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="46 ${Math.round(2*Math.PI*(R0-22))-46}"/></g>
   <rect x="0" y="0" width="200" height="224" class="ink" mask="url(#${u}-m)"/>
   ${face}
   <g class="splat"><circle cx="40" cy="52" r="2.6"/><circle cx="52" cy="40" r="1.6"/><circle cx="162" cy="188" r="2.2"/><circle cx="172" cy="176" r="1.3"/><circle cx="34" cy="176" r="1.8"/></g>
   <g class="seal" style="--ox:146px;--oy:50px">${avatarLamp(u,lampShape,146,50,1.2)}</g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[160,92],sweat:[140,98],z:[150,50],dots:[150,34]})}
 </svg>`;
  },
  init(svg,h){
   const ring=svg.querySelector('.ring-mask'),streaks=svg.querySelector('.streaks'),size=h.recipe.size||1;
   const brush={thin:.74,mid:1,bold:1.3}[h.recipe.slots?.brush||'mid']||1;
   const cur={phi:135,gap:34,wob:1,thick:brush,alpha:1},seed=Math.random()*10;let spin=0,tgt={...MOODT.idle,thick:brush},mood='idle',level=0,off=false;
   const draw=(t,boil)=>{const g=geom({phi:cur.phi+spin,gap:cur.gap,wob:cur.wob,thick:cur.thick,size:1,breath:boil,seed},t);ring.setAttribute('d',g.d);streaks.innerHTML=g.streaks.map(d=>d?`<path d="${d}"/>`:'').join('');svg.style.setProperty('--ink-a',cur.alpha.toFixed(2));};
   const step=(t,dt)=>{
    if(off)return;
    const q=h.isReduced();
    if(mood==='thinking'&&!q)spin+=dt*46;else if(mood!=='thinking')spin*=Math.exp(-4*dt);
    let T=tgt;if(mood==='talking')T={...tgt,gap:20+34*(.5+.5*Math.sin(t*9+Math.sin(t*3)))*(.4+level*.6)};
    const k=q?1:1-Math.exp(-6*dt);
    for(const key of ['phi','gap','wob','thick','alpha']){let d=T[key]-cur[key];if(key==='phi'){d=((d+540)%360)-180;}cur[key]+=d*k;}
    draw(q?0:Math.floor(t*6)/6,q?0:Math.sin(t*1.3)*.9);
   };
   draw(0,0);E.add(step);if(!tk)tk=requestAnimationFrame(loop);
   return {
    setMood(m){mood=m;tgt={...(MOODT[m]||MOODT.idle)};tgt.thick*=brush;if(m==='thinking')spin=spin%360;},
    setLevel(v){level=v;},
    destroy(){off=true;E.delete(step);}
   };
  }
 };
})();
