/** The companion's body. A small cream character whose antenna light is the dot in "tepora•".
 * Mood is derived from app state (see companionMood); this module only draws and animates.
 * An optional VRM avatar can replace the drawing on the home stage; it receives the same moods.
 */
export const MOODS=['idle','listening','thinking','talking','happy','attention','concerned','sleepy'];
let characterSerial=0;

export function characterSVG({variant='orb',label=''}={}){
 const id=`tc${++characterSerial}`;
 return `<svg class="tc tc-${variant==='brass'?'brass':'orb'}" viewBox="0 0 200 224" ${label?`role="img" aria-label="${label}"`:'aria-hidden="true"'} focusable="false">
 <defs><linearGradient id="${id}-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--tc-light)"/><stop offset=".62" stop-color="var(--tc-body)"/><stop offset="1" stop-color="var(--tc-shade)"/></linearGradient>
 <radialGradient id="${id}-glow"><stop offset="0" stop-color="var(--tc-dot)" stop-opacity=".55"/><stop offset="1" stop-color="var(--tc-dot)" stop-opacity="0"/></radialGradient></defs>
 <ellipse class="tc-floor" cx="100" cy="212" rx="54" ry="7"/>
 <g class="tc-pose"><g class="tc-breath">
  <g class="tc-antenna"><path class="tc-stem" d="M100 46 C99 34 102 25 108 18"/><circle class="tc-glow" cx="108" cy="15" r="15" fill="url(#${id}-glow)"/><circle class="tc-dot" cx="108" cy="15" r="7"/></g>
  <ellipse class="tc-foot" cx="80" cy="203" rx="15" ry="7.5"/><ellipse class="tc-foot" cx="120" cy="203" rx="15" ry="7.5"/>
  <g class="tc-arm tc-arm-left"><ellipse cx="29" cy="142" rx="10" ry="15" transform="rotate(18 29 142)"/></g>
  <g class="tc-arm tc-arm-right"><ellipse cx="171" cy="142" rx="10" ry="15" transform="rotate(-18 171 142)"/></g>
  <path class="tc-shell" fill="url(#${id}-shade)" d="M100 44C150 44 177 84 177 132C177 177 147 204 100 204C53 204 23 177 23 132C23 84 50 44 100 44Z"/>
  <path class="tc-rim" d="M60 70C70 58 84 52 100 51"/>
  <g class="tc-face">
   <ellipse class="tc-cheek" cx="61" cy="140" rx="12" ry="6.5"/><ellipse class="tc-cheek" cx="139" cy="140" rx="12" ry="6.5"/>
   <g class="tc-eyes">
    <g class="tc-eye-open"><rect x="72" y="104" width="12" height="25" rx="6"/><rect x="116" y="104" width="12" height="25" rx="6"/><circle class="tc-spark" cx="80.5" cy="110" r="2.2"/><circle class="tc-spark" cx="124.5" cy="110" r="2.2"/></g>
    <g class="tc-eye-happy"><path d="M70 120 Q78 108 86 120"/><path d="M114 120 Q122 108 130 120"/></g>
    <g class="tc-eye-closed"><path d="M70 117 Q78 124 86 117"/><path d="M114 117 Q122 124 130 117"/></g>
   </g>
   <path class="tc-smile" d="M92 143 Q100 150 108 143"/>
   <ellipse class="tc-mouth" cx="100" cy="146" rx="7" ry="6"/>
  </g>
 </g></g>
 <g class="tc-zzz"><text x="150" y="58">z</text><text x="162" y="40">z</text></g>
</svg>`;
}

/** Mount a character into host. Returns {setMood, setLook, setLevel, destroy}. */
export function createCharacter(host,{variant='orb',label='',follow=true,reducedMotion=false}={}){
 host.classList.add('tc-host');host.innerHTML=characterSVG({variant,label});
 const svg=host.firstElementChild;let mood='idle',blinkTimer=0,glanceTimer=0,destroyed=false,frame=0,pending=null;
 const blink=()=>{if(destroyed)return;if(mood!=='sleepy'&&mood!=='happy'){svg.classList.add('is-blinking');setTimeout(()=>svg.classList.remove('is-blinking'),130);if(Math.random()<.18)setTimeout(()=>{svg.classList.add('is-blinking');setTimeout(()=>svg.classList.remove('is-blinking'),120);},260);}blinkTimer=setTimeout(blink,2200+Math.random()*4200);};
 const look=(x,y)=>{svg.style.setProperty('--look-x',`${(x*5).toFixed(2)}px`);svg.style.setProperty('--look-y',`${(y*3.5).toFixed(2)}px`);};
 const glance=()=>{if(destroyed)return;if(!pending&&!reducedMotion&&mood==='idle')look((Math.random()*2-1)*.7,(Math.random()*2-1)*.4);glanceTimer=setTimeout(glance,5000+Math.random()*7000);};
 const onPointer=e=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const r=host.getBoundingClientRect();if(!r.width)return;
  const x=(e.clientX-(r.left+r.width/2))/Math.max(260,window.innerWidth/2),y=(e.clientY-(r.top+r.height*.45))/Math.max(220,window.innerHeight/2);
  pending={x:Math.max(-1,Math.min(1,x)),y:Math.max(-1,Math.min(1,y))};look(pending.x,pending.y);clearTimeout(pending.timer);pending.timer=setTimeout(()=>{pending=null;},4000);});};
 if(follow&&!reducedMotion)window.addEventListener('pointermove',onPointer,{passive:true});
 blinkTimer=setTimeout(blink,1200);glanceTimer=setTimeout(glance,4000);
 return {
  kind:'drawn',
  setMood(next){mood=MOODS.includes(next)?next:'idle';svg.dataset.mood=mood;if(mood==='sleepy')look(0,.6);},
  setLook(x,y){look(x,y);},
  setLevel(value){svg.style.setProperty('--mouth',String(.35+Math.max(0,Math.min(1,value))*.75));},
  destroy(){destroyed=true;clearTimeout(blinkTimer);clearTimeout(glanceTimer);cancelAnimationFrame(frame);window.removeEventListener('pointermove',onPointer);host.classList.remove('tc-host');host.replaceChildren();}
 };
}

/** Derive one mood from what is actually happening. Pure; the caller decides when to repaint. */
export function companionMood({recording=false,typing=false,sending=false,awaitingReply=false,talking=false,celebrate=false,attention=0,failures=0,sleepy=false}={}){
 if(talking)return 'talking';
 if(recording)return 'listening';
 if(sending||awaitingReply)return 'thinking';
 if(celebrate)return 'happy';
 if(typing)return 'listening';
 if(failures)return 'concerned';
 if(attention)return 'attention';
 if(sleepy)return 'sleepy';
 return 'idle';
}
