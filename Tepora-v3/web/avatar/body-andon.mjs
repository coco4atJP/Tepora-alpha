/* ===== B. 灯守 (andon-mori): a paper lantern that lives in the room. The face is ink on paper; at night it lights from inside;
 * while it thinks, silhouettes revolve inside it like a 走馬灯. ===== */
import {avatarFace,avatarFx,avatarLamp,avatarLampDefs,avatarProps} from './kit.mjs';

export const AVATAR_BODY_ANDON=(()=>{

 const SOMA={
  leaf:{name:'紅葉',d:'M0 -12L3 -6L9.5 -8.5L6.5 -1L12.5 1L5.5 5.5L7.5 11.5L0 8L-7.5 11.5L-5.5 5.5L-12.5 1L-6.5 -1L-9.5 -8.5L-3 -6Z M0 8L0 15',stroke:true},
  fish:{name:'金魚',d:'M-13 0C-7 -8 6 -8 10 0C6 8 -7 8 -13 0Z M9 0L19 -8L16 0L19 8Z M-8 -1.2a1.4 1.4 0 1 0 .01 0'},
  bird:{name:'燕',d:'M-15 -4C-7 -2 -2.5 2 0 7C2.5 2 7 -2 15 -4C7 -9 2.5 -5 0 1C-2.5 -5 -7 -9 -15 -4Z'},
  snow:{name:'雪',d:'M0 -11L0 11M-9.5 -5.5L9.5 5.5M-9.5 5.5L9.5 -5.5M-3 -9.5L0 -7L3 -9.5M-3 9.5L0 7L3 9.5',stroke:true,line:true},
  moon:{name:'月と星',d:'M-4 -11A11 11 0 1 0 8 7A9 9 0 0 1 -4 -11Z M11 -9L12.4 -5.6L16 -5.2L13.3 -2.9L14.1 .7L11 -1.1L7.9 .7L8.7 -2.9L6 -5.2L9.6 -5.6Z'}
 };
 const seasonSoma=()=>{const m=new Date().getMonth()+1;return m>=3&&m<=5?'bird':m>=6&&m<=8?'fish':m>=9&&m<=11?'leaf':'snow';};
 const SHAPES={
  round:{d:'M64 58C40 76 30 104 32 128C34 158 48 182 68 190L132 190C152 182 166 158 168 128C170 104 160 76 136 58Z',capW:80,top:58,bot:190,face:124,half:68},
  drum:{d:'M60 58C46 70 42 90 42 124C42 160 46 178 60 190L140 190C154 178 158 160 158 124C158 90 154 70 140 58Z',capW:84,top:58,bot:190,face:124,half:58},
  gourd:{d:'M72 58C56 62 56 84 68 96C46 108 34 130 38 156C42 178 60 190 78 190L122 190C140 190 158 178 162 156C166 130 154 108 132 96C144 84 144 62 128 58Z',capW:60,top:58,bot:190,face:136,half:62}
 };
 const ribs=(S,u)=>{
  const o=[];
  for(const t of [-.8,-.4,0,.4,.8]){const x0=100+t*(S.capW/2-4),x1=100+t*(S.half-2),x2=100+t*(S.capW/2-6);
   o.push(`<path d="M${x0} ${S.top}C${100+t*(S.half-3)} ${S.top+28} ${100+t*(S.half+1)} ${S.bot-30} ${x2} ${S.bot}"/>`);}
  return `<g class="ribs" clip-path="url(#${u}-c)">${o.join('')}<path d="M30 ${S.top+22}Q100 ${S.top+34} 170 ${S.top+22}M30 ${S.bot-20}Q100 ${S.bot-8} 170 ${S.bot-20}"/></g>`;
 };
 return {
  id:'andon',
  svg(r,u){
   const S=SHAPES[r.slots?.shape]||SHAPES.round,g=24,key=r.slots?.soma&&r.slots.soma!=='auto'?r.slots.soma:seasonSoma(),sm=SOMA[key]||SOMA.leaf,lampShape=r.lamp?.shape||'bead';
   const A={top:[100,36],headW:S.half*2-10,headH:90,face:[100,S.face],eyeGap:g,handR:[176,150],neck:[100,S.bot-12,S.half-6]};
   const sil=Array.from({length:5},(_,i)=>`<path class="sil" data-i="${i}" d="${sm.d}" ${sm.stroke?`fill="${sm.line?'none':'var(--c-ink)'}" stroke="var(--c-ink)" stroke-width="${sm.line?2.2:1.2}" stroke-linecap="round" stroke-linejoin="round"`:''}/>`).join('');
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id="${u}-p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".55" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></linearGradient>
   <linearGradient id="${u}-e" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--c-shade)" stop-opacity=".35"/><stop offset=".22" stop-color="var(--c-shade)" stop-opacity="0"/><stop offset=".72" stop-color="var(--c-shade)" stop-opacity="0"/><stop offset="1" stop-color="var(--c-shade)" stop-opacity=".5"/></linearGradient>
   <radialGradient id="${u}-in" cx=".5" cy=".62" r=".62"><stop offset="0" stop-color="#fff3d2"/><stop offset=".45" stop-color="#ffd48f"/><stop offset="1" stop-color="#ffbb6a" stop-opacity="0"/></radialGradient>
   <clipPath id="${u}-c"><path d="${S.d}"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="floor" cx="100" cy="213" rx="${S.half*.78}" ry="6.5"/>
  <g class="pose"><g class="breath">
   <g class="antenna" style="--ox:100px;--oy:38px"><g class="sway" style="--ox:100px;--oy:38px">
    <path class="stem" d="M100 38C99 28 104 21 112 16"/>${avatarLamp(u,lampShape,112,14,1)}
   </g></g>
   <g class="arm arm-l" style="--ox:${100-S.half+4}px;--oy:${S.face}px"><ellipse class="nub" cx="${100-S.half-1}" cy="${S.face+16}" rx="8" ry="11.5" transform="rotate(18 ${100-S.half-1} ${S.face+16})"/></g>
   <g class="arm arm-r" style="--ox:${100+S.half-4}px;--oy:${S.face}px"><ellipse class="nub" cx="${100+S.half+1}" cy="${S.face+16}" rx="8" ry="11.5" transform="rotate(-18 ${100+S.half+1} ${S.face+16})"/></g>
   <rect class="foot" x="66" y="198" width="22" height="9" rx="4.5"/><rect class="foot" x="112" y="198" width="22" height="9" rx="4.5"/>
   <g class="lantern">
    <path class="paper" fill="url(#${u}-p)" d="${S.d}"/>
    <g clip-path="url(#${u}-c)"><rect x="0" y="40" width="200" height="170" fill="url(#${u}-e)"/>
     <ellipse class="inner" cx="100" cy="${S.bot-34}" rx="74" ry="86" fill="url(#${u}-in)"/>
     <g class="soma" transform="translate(0 ${S.face-8})">${sil}</g></g>
    ${ribs(S,u)}
    <path class="edge" d="${S.d}" fill="none"/>
    <rect class="lid" x="${100-S.capW*.33}" y="${S.top-18}" width="${S.capW*.66}" height="9" rx="3.5"/>
    <rect class="cap" x="${100-S.capW/2}" y="${S.top-10}" width="${S.capW}" height="14" rx="5"/>
    <rect class="cap" x="${100-S.capW/2+2}" y="${S.bot-4}" width="${S.capW-4}" height="13" rx="5"/>
    <rect class="cap-hl" x="${100-S.capW/2+6}" y="${S.top-8}" width="${S.capW-30}" height="2.4" rx="1.2"/>
   </g>
   <g transform="translate(0 ${S.face-126})">${avatarFace(r,{g,c:S.half-22})}</g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[158,54],sweat:[146,S.face-24],z:[150,40],dots:[146,34]})}
 </svg>`;
  },
  init(svg,h){
   const sils=[...svg.querySelectorAll('.sil')],n=sils.length;let raf=0,t0=performance.now(),spin=0,on=false;
   const frame=now=>{
    if(h.dead||!on){raf=0;return;}
    const dt=(now-t0)/1000;t0=now;spin+=dt*.9;
    sils.forEach((el,i)=>{const th=spin+i*2*Math.PI/n,c=Math.cos(th),s=Math.sin(th),x=100+s*54,sx=Math.max(.12,Math.abs(c)),vis=c>0?1:.18;
     el.setAttribute('transform',`translate(${x.toFixed(1)} ${(30+Math.sin(th*2+i)*5).toFixed(1)}) scale(${(sx*1.55).toFixed(2)} 1.55) rotate(${(Math.sin(th*1.3)*14).toFixed(0)})`);el.style.opacity=(vis*(.3*Math.max(.3,sx))).toFixed(2);});
    raf=requestAnimationFrame(frame);
   };
   return {
    setMood(m){const want=m==='thinking'&&!h.isReduced();
     if(want&&!on){on=true;t0=performance.now();raf=requestAnimationFrame(frame);}else if(!want&&on){on=false;}
     if(m==='thinking'&&!want)frame(performance.now());},
    destroy(){on=false;cancelAnimationFrame(raf);}
   };
  }
 };
})();
