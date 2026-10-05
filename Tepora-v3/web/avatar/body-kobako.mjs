/* ===== D. 小箱 (kobako): a little device whose face is a screen. Expressions are light on dark, so they read from across the room. ===== */
import {avatarFx,avatarLamp,avatarLampDefs,avatarProps} from './kit.mjs';

export const AVATAR_BODY_KOBAKO=(()=>{

 const FACES={
  led:{name:'棒の目',eo:g=>`<rect x="${100-g-6}" y="104" width="12" height="28" rx="6"/><rect x="${100+g-6}" y="104" width="12" height="28" rx="6"/>`},
  dot:{name:'丸い目',eo:g=>`<circle cx="${100-g}" cy="118" r="9.5"/><circle cx="${100+g}" cy="118" r="9.5"/>`},
  pixel:{name:'ドット',eo:g=>{const px=(x,y)=>`<rect x="${x}" y="${y}" width="6" height="6"/>`;const e=x=>[0,1,2,3].map(i=>px(x,106+i*7)).join('')+px(x+7,110)+px(x+7,117);return `<g class="pix">${e(100-g-9)}${e(100+g-9)}</g>`;}},
  bar:{name:'一本線',eo:g=>`<rect x="${100-g-10}" y="115" width="20" height="7" rx="3.5"/><rect x="${100+g-10}" y="115" width="20" height="7" rx="3.5"/>`}
 };
 const BODYS={
  box:{d:'M28 100C28 78 44 64 66 64H134C156 64 172 78 172 100V162C172 184 156 198 134 198H66C44 198 28 184 28 162Z',sx:46,sy:84,sw:108,sh:82,sr:24,top:64},
  tall:{d:'M40 90C40 74 52 64 70 64H130C148 64 160 74 160 90V170C160 188 148 198 130 198H70C52 198 40 188 40 170Z',sx:54,sy:80,sw:92,sh:92,sr:22,top:64},
  round:{d:'M100 62C146 62 176 92 176 130C176 172 146 198 100 198C54 198 24 172 24 130C24 92 54 62 100 62Z',sx:42,sy:82,sw:116,sh:84,sr:40,top:62}
 };
 return {
  id:'kobako',
  svg(r,u){
   const S=BODYS[r.slots?.shape]||BODYS.box,F=FACES[r.slots?.screen]||FACES.led,g=26,lampShape=r.lamp?.shape||'bead',sy=S.sy,cy=sy+S.sh/2;
   const A={top:[100,S.top+2],headW:S.sw+40,headH:80,face:[100,cy],eyeGap:g,handR:[176,150],neck:[100,184,56]};
   return `<svg viewBox="0 0 200 224" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id="${u}-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c-light)"/><stop offset=".6" stop-color="var(--c-body)"/><stop offset="1" stop-color="var(--c-shade)"/></linearGradient>
   <linearGradient id="${u}-s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d2721"/><stop offset="1" stop-color="#1a1613"/></linearGradient>
   <radialGradient id="${u}-sg" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#fff1d6" stop-opacity=".22"/><stop offset="1" stop-color="#fff1d6" stop-opacity="0"/></radialGradient>
   <radialGradient id="${u}-hl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
   <clipPath id="${u}-c"><path d="${S.d}"/></clipPath><clipPath id="${u}-sc"><rect x="${S.sx}" y="${sy}" width="${S.sw}" height="${S.sh}" rx="${S.sr}"/></clipPath>${avatarLampDefs(u)}
  </defs>
  <ellipse class="floor" cx="100" cy="212" rx="60" ry="7"/>
  <g class="pose"><g class="breath">
   <g class="antenna" style="--ox:112px;--oy:${S.top+2}px"><g class="sway" style="--ox:112px;--oy:${S.top+2}px">
    <path class="rod" d="M112 ${S.top+2}L118 ${S.top-24}"/>${avatarLamp(u,lampShape,118,S.top-28,1.05)}
   </g></g>
   <circle class="pod" cx="${S.d.startsWith('M100')?24:26}" cy="${cy+6}" r="11"/><circle class="pod" cx="${S.d.startsWith('M100')?176:174}" cy="${cy+6}" r="11"/>
   <rect class="foot" x="58" y="192" width="30" height="14" rx="7"/><rect class="foot" x="112" y="192" width="30" height="14" rx="7"/>
   <path class="shell" fill="url(#${u}-b)" d="${S.d}"/>
   <g clip-path="url(#${u}-c)"><ellipse cx="72" cy="${S.top+20}" rx="34" ry="14" transform="rotate(-18 72 ${S.top+20})" fill="url(#${u}-hl)"/><ellipse cx="100" cy="206" rx="90" ry="34" fill="var(--c-shade)" opacity=".45"/></g>
   <rect class="bezel" x="${S.sx-3}" y="${sy-3}" width="${S.sw+6}" height="${S.sh+6}" rx="${S.sr+3}"/>
   <rect class="screen" x="${S.sx}" y="${sy}" width="${S.sw}" height="${S.sh}" rx="${S.sr}" fill="url(#${u}-s)"/>
   <g clip-path="url(#${u}-sc)"><rect x="${S.sx}" y="${sy}" width="${S.sw}" height="${S.sh}" fill="url(#${u}-sg)" class="screen-glow"/>
    <g transform="translate(0 ${cy-118})"><g class="face led">
     <g class="ripples"><path d="M154 104q8 14 0 28"/><path d="M162 98q12 20 0 40"/></g>
     <g class="eyes"><g class="eo">${F.eo(g)}</g>
      <g class="eh"><path d="M${100-g-9} 126Q${100-g} 108 ${100-g+9} 126"/><path d="M${100+g-9} 126Q${100+g} 108 ${100+g+9} 126"/></g>
      <g class="ec"><rect x="${100-g-10}" y="118" width="20" height="6" rx="3"/><rect x="${100+g-10}" y="118" width="20" height="6" rx="3"/></g></g>
     <path class="smile" d="M90 146Q100 154 110 146"/>
     <g class="eq"><rect x="82" y="142" width="5" height="12" rx="2.5"/><rect x="90" y="142" width="5" height="12" rx="2.5"/><rect x="98" y="142" width="5" height="12" rx="2.5"/><rect x="106" y="142" width="5" height="12" rx="2.5"/><rect x="114" y="142" width="5" height="12" rx="2.5"/></g>
     <g class="think"><circle cx="88" cy="148" r="3.4"/><circle cx="100" cy="148" r="3.4"/><circle cx="112" cy="148" r="3.4"/></g>
     <path class="wavy" d="M91 150q4.5-4 9 0t9 0"/>
     <text class="bang" x="140" y="106">!</text>
    </g></g></g>
   ${avatarProps(r,A,u)}
  </g></g>
  ${avatarFx({spark:[160,S.top+6],sweat:[158,S.top+34],z:[150,S.top-8],dots:[146,S.top-18]})}
 </svg>`;
  }
 };
})();
