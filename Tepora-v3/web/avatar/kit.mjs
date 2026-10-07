/** Drawing helpers shared by the drawn (SVG) bodies: the lamp, the standard face, ink marks and accessories.
 * Everything is built from the validated spec and fixed enumerations; nothing is taken from free text.
 * Colours come in as CSS custom properties on the body's root element (see avatarCssVars).
 */
import {resolveAvatarColors} from './model.mjs';

let avatarSerial=0;
/** A unique id prefix for the gradients and clip paths of one drawing. */
export const avatarUid=()=>`av${++avatarSerial}`;
/** The colours of a spec as CSS custom properties for a theme ('light', 'dark' or 'lamp'). */
export function avatarCssVars(spec,theme='light'){
 const c=resolveAvatarColors(spec,theme);
 return {'--c-body':c.body,'--c-light':c.light,'--c-shade':c.shade,'--c-ink':c.ink,'--c-cheek':c.cheek,'--c-limb':c.limb,'--c-foot':c.foot,'--c-lamp':c.lamp,'--c-lamp-rgb':c.lampRgb};
}

/* ---- shared drawing helpers ---- */
export const avatarLampDefs=u=>`<radialGradient id="${u}-lg"><stop offset="0" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity=".6"/><stop offset="1" stop-color="rgb(var(--c-lamp-rgb))" stop-opacity="0"/></radialGradient>`;
/** A small lamp at (x,y). k scales it. shape: bead, flame, bud or bulb. */
export function avatarLamp(u,shape,x,y,k=1){
 const glow=`<circle class="lamp-glow" cx="${x}" cy="${y}" r="${16*k}" fill="url(#${u}-lg)"/>`;
 let body;
 if(shape==='flame')body=`<path class="lamp-dot" d="M${x} ${y-12*k}C${x+7*k} ${y-4*k} ${x+7*k} ${y+7*k} ${x} ${y+8*k}C${x-7*k} ${y+7*k} ${x-7*k} ${y-4*k} ${x} ${y-12*k}Z"/><path d="M${x} ${y-4*k}C${x+3.2*k} ${y} ${x+3*k} ${y+4.5*k} ${x} ${y+5*k}C${x-3*k} ${y+4.5*k} ${x-3.2*k} ${y} ${x} ${y-4*k}Z" fill="#fff" opacity=".55"/>`;
 else if(shape==='bud')body=`<ellipse class="lamp-dot" cx="${x}" cy="${y-1*k}" rx="${6*k}" ry="${8.4*k}"/><path d="M${x-5.5*k} ${y+4*k}Q${x} ${y+10*k} ${x+5.5*k} ${y+4*k}" fill="none" stroke="var(--c-ink)" stroke-opacity=".45" stroke-width="${2.2*k}" stroke-linecap="round"/><ellipse cx="${x-2*k}" cy="${y-4*k}" rx="${1.6*k}" ry="${2.6*k}" fill="#fff" opacity=".5"/>`;
 else if(shape==='bulb')body=`<rect x="${x-3.4*k}" y="${y+5*k}" width="${6.8*k}" height="${4*k}" rx="1.2" fill="var(--c-ink)" opacity=".7"/><circle class="lamp-dot" cx="${x}" cy="${y}" r="${7.2*k}"/><circle cx="${x-2.2*k}" cy="${y-2.4*k}" r="${1.9*k}" fill="#fff" opacity=".55"/>`;
 else body=`<circle class="lamp-dot" cx="${x}" cy="${y}" r="${7*k}"/><circle cx="${x-2.2*k}" cy="${y-2.4*k}" r="${1.9*k}" fill="#fff" opacity=".55"/>`;
 return `<g class="lamp">${glow}${body}</g>`;
}
/** Effect marks near the face; shown only by the moods that use them. pos: {spark,sweat,z,dots} each [x,y]. */
export function avatarFx(pos={}){
 const o=[];
 if(pos.spark){const [x,y]=pos.spark;o.push(`<g class="fx fx-spark" transform="translate(${x} ${y})"><path class="sp sp1" d="M0 -9C1 -3 3 -1 9 0C3 1 1 3 0 9C-1 3 -3 1 -9 0C-3 -1 -1 -3 0 -9Z"/><path class="sp sp2" transform="translate(-20 14) scale(.55)" d="M0 -9C1 -3 3 -1 9 0C3 1 1 3 0 9C-1 3 -3 1 -9 0C-3 -1 -1 -3 0 -9Z"/><path class="sp sp3" transform="translate(16 20) scale(.4)" d="M0 -9C1 -3 3 -1 9 0C3 1 1 3 0 9C-1 3 -3 1 -9 0C-3 -1 -1 -3 0 -9Z"/></g>`);}
 if(pos.sweat){const [x,y]=pos.sweat;o.push(`<path class="fx fx-sweat" transform="translate(${x} ${y})" d="M0 -9C4 -2 6 2 6 5A6 6 0 0 1 -6 5C-6 2 -4 -2 0 -9Z"/>`);}
 if(pos.z){const [x,y]=pos.z;o.push(`<g class="fx fx-z"><text x="${x}" y="${y}">z</text><text x="${x+12}" y="${y-18}">z</text></g>`);}
 if(pos.dots){const [x,y]=pos.dots;o.push(`<g class="fx fx-dots" transform="translate(${x} ${y})"><circle cx="0" cy="0" r="2.4"/><circle cx="9" cy="0" r="2.4"/><circle cx="18" cy="0" r="2.4"/></g>`);}
 return o.join('');
}


/* ---- the standard face rig: eyes (open / happy / closed), cheeks, brows and the mouths, in local coords centred on (100,126) ---- */
export function avatarEyes(style,g){
 const xl=100-g,xr=100+g;
 if(style==='dot')return `<circle cx="${xl}" cy="127" r="7.4"/><circle cx="${xr}" cy="127" r="7.4"/><circle class="catch" cx="${xl+2.4}" cy="124.4" r="2.3"/><circle class="catch" cx="${xr+2.4}" cy="124.4" r="2.3"/>`;
 if(style==='big')return `<ellipse cx="${xl}" cy="126" rx="11" ry="13.5"/><ellipse cx="${xr}" cy="126" rx="11" ry="13.5"/><circle class="catch" cx="${xl+3.6}" cy="120.4" r="4.4"/><circle class="catch" cx="${xr+3.6}" cy="120.4" r="4.4"/><circle class="catch" cx="${xl-3.4}" cy="132.4" r="2"/><circle class="catch" cx="${xr-3.4}" cy="132.4" r="2"/>`;
 if(style==='sleepy')return `<path d="M${xl-11} 124H${xl+11}A11 11 0 0 1 ${xl-11} 124Z"/><path d="M${xr-11} 124H${xr+11}A11 11 0 0 1 ${xr-11} 124Z"/>`;
 return `<rect x="${xl-6}" y="113" width="12" height="26" rx="6"/><rect x="${xr-6}" y="113" width="12" height="26" rx="6"/><circle class="catch" cx="${xl+1.6}" cy="119.4" r="2.5"/><circle class="catch" cx="${xr+1.6}" cy="119.4" r="2.5"/><circle class="catch" cx="${xl-1.8}" cy="133" r="1.2"/><circle class="catch" cx="${xr-1.8}" cy="133" r="1.2"/>`;
}
export function avatarFace(r,{g=24,c=44,mouth=true,my=0,browShort=false}={}){
 const bh=browShort?4:10,brows=r.face?.brows?`<g class="brows"><path class="brow brow-l" d="M${100-g-bh} 105Q${100-g} 101 ${100-g+bh} 105"/><path class="brow brow-r" d="M${100+g-bh} 105Q${100+g} 101 ${100+g+bh} 105"/></g>`:'';
 return `<g class="face">
  ${r.face?.cheeks===false?'':`<ellipse class="cheek" cx="${100-c}" cy="144" rx="12" ry="6.5"/><ellipse class="cheek" cx="${100+c}" cy="144" rx="12" ry="6.5"/>`}
  ${brows}
  <g class="eyes"><g class="eo">${avatarEyes(r.face?.eyes||'capsule',g)}</g>
   <g class="eh"><path d="M${100-g-8} 130Q${100-g} 117 ${100-g+8} 130"/><path d="M${100+g-8} 130Q${100+g} 117 ${100+g+8} 130"/></g>
   <g class="ec"><path d="M${100-g-8} 125Q${100-g} 132 ${100-g+8} 125"/><path d="M${100+g-8} 125Q${100+g} 132 ${100+g+8} 125"/></g></g>
  ${mouth?`<g transform="translate(0 ${my})"><path class="smile" d="M92 146Q100 155 108 146"/><ellipse class="mouth" cx="100" cy="150" rx="7" ry="6"/><path class="mouth-w" d="M93 152q3.5-3 7 0t7 0"/><path class="mouth-s" d="M102 151q5.5-3.6 11-1"/></g>`:''}
 </g>`;
}

export const avatarMirror=d=>d.replace(/([MLCQSTZ])([^MLCQSTZ]*)/g,(m,c,a)=>{const n=a.trim().split(/[\s,]+/).filter(Boolean).map(Number);return c+n.map((v,i)=>i%2===0?(200-v):v).join(' ');});

/* ---- accessories drawn on anchors (the same part fits every body that exposes the anchor) ---- */
export const avatarSeasonProp=m=>m>=3&&m<=5?'petal':m>=6&&m<=8?'uchiwa':m>=9&&m<=11?'leaf':'scarf';
export function avatarProps(r,a,u){
 if(!a)return '';
 const out=[],sp=r.props?.season==='auto'?avatarSeasonProp(new Date().getMonth()+1):r.props?.season;
 const prop=name=>({
  leaf:a.top&&`<g class="prop prop-leaf" transform="translate(${a.top[0]-a.headW*.2} ${a.top[1]+5}) rotate(-12)"><path d="M0 0C-10 -5 -14 -17 -8 -27C2 -21 8 -9 0 0Z" fill="#c8a15f"/><path d="M0 0L-6 -20" stroke="#9b7a3e" stroke-width="1.4" stroke-linecap="round" fill="none"/></g>`,
  petal:a.top&&`<g class="prop prop-petal" transform="translate(${a.top[0]-a.headW*.18} ${a.top[1]+5}) rotate(-22)"><path d="M0 0C-8 -4 -10 -14 -3 -20C3 -14 7 -6 0 0Z" fill="#f2c4c4"/><path d="M0 0C4 -4 8 -10 3 -18" stroke="#e3a3a6" stroke-width="1" fill="none"/></g>`,
  uchiwa:a.handR&&`<g class="prop prop-uchiwa" transform="translate(${a.handR[0]} ${a.handR[1]}) rotate(-18)"><rect x="-1.6" y="-4" width="3.2" height="20" rx="1.4" fill="#b78f5a"/><ellipse cx="0" cy="-17" rx="14" ry="15" fill="#f1ead8" stroke="#cdbf9d" stroke-width="1.2"/><path d="M-9 -22Q0 -14 9 -22M-10 -15Q0 -8 10 -15" fill="none" stroke="#b9ab88" stroke-width="1"/></g>`,
  scarf:a.neck&&`<g class="prop prop-scarf"><path d="M${a.neck[0]-a.neck[2]} ${a.neck[1]}Q${a.neck[0]} ${a.neck[1]+13} ${a.neck[0]+a.neck[2]} ${a.neck[1]}L${a.neck[0]+a.neck[2]-2} ${a.neck[1]+11}Q${a.neck[0]} ${a.neck[1]+24} ${a.neck[0]-a.neck[2]+2} ${a.neck[1]+11}Z" fill="#a9b3bd"/><path d="M${a.neck[0]+a.neck[2]-14} ${a.neck[1]+10}l6 24 12 -3 -5 -22z" fill="#9aa5b0"/><path d="M${a.neck[0]-a.neck[2]+6} ${a.neck[1]+9}Q${a.neck[0]} ${a.neck[1]+19} ${a.neck[0]+a.neck[2]-6} ${a.neck[1]+9}" fill="none" stroke="#c9d1d8" stroke-width="2" stroke-dasharray="5 5"/></g>`,
  headphones:a.top&&`<g class="prop prop-hp"><path d="M${a.top[0]-a.headW*.5} ${a.top[1]+a.headH*.42}C${a.top[0]-a.headW*.5} ${a.top[1]-6} ${a.top[0]+a.headW*.5} ${a.top[1]-6} ${a.top[0]+a.headW*.5} ${a.top[1]+a.headH*.42}" fill="none" stroke="#3a342d" stroke-width="5" stroke-linecap="round"/><rect x="${a.top[0]-a.headW*.5-6}" y="${a.top[1]+a.headH*.34}" width="12" height="22" rx="6" fill="#4a443c"/><rect x="${a.top[0]+a.headW*.5-6}" y="${a.top[1]+a.headH*.34}" width="12" height="22" rx="6" fill="#4a443c"/></g>`,
  glasses:a.face&&`<g class="prop prop-glasses" transform="translate(${a.face[0]} ${a.face[1]})" fill="none" stroke="#3a342d" stroke-width="2.6"><rect x="${-a.eyeGap-13}" y="-14" width="26" height="28" rx="11" fill="rgba(255,255,255,.18)"/><rect x="${a.eyeGap-13}" y="-14" width="26" height="28" rx="11" fill="rgba(255,255,255,.18)"/><path d="M${-a.eyeGap+13} -3Q0 -9 ${a.eyeGap-13} -3"/></g>`,
  cup:a.handR&&`<g class="prop prop-cup" transform="translate(${a.handR[0]-4} ${a.handR[1]-2})"><path class="steam" d="M-3 -16Q-7 -22 -3 -28M4 -16Q0 -22 4 -28" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/><path d="M-10 -10h20l-2.6 17a4 4 0 0 1-4 3.4h-6.8a4 4 0 0 1-4-3.4z" fill="#f4f0e6" stroke="#cbbf9f" stroke-width="1.2"/><path d="M10 -6c6 0 6 9 -1 9" fill="none" stroke="#cbbf9f" stroke-width="1.6"/></g>`
 }[name]||'');
 if(sp&&sp!=='off')out.push(prop(sp));
 if(r.props?.hobby&&r.props.hobby!=='none')out.push(prop(r.props.hobby));
 return out.join('');
}

