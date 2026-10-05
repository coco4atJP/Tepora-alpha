/** Idle-screen wallpapers. The idle screen behaves like a screensaver: it starts by itself, covers
 * the whole screen, drifts a little against burn-in and goes away on any deliberate input. What sits
 * behind the clock is chosen here. Every wallpaper is drawn by CSS or from the person's own photos;
 * nothing is fetched from the network.
 */
export const WALLPAPER_LABELS=Object.freeze({room:'部屋',plain:'無地',drift:'ゆらぎ',stars:'星空',photos:'写真'});
export const WALLPAPER_NOTES=Object.freeze({
 room:'窓の光とランプ。時刻と天気でゆっくり動きます',
 plain:'何も置かない静かな紙色。ホームの光も入れません',
 drift:'やわらかな色が、ゆっくり流れます（動く）',
 stars:'夜空と、ときどき流れ星（動く）',
 photos:'写真立て。選んだ写真をゆっくり切り替えます'
});
/** What is drawn behind the screen now: 'room' | 'plain' | 'drift' | 'stars' | 'photos'. */
export function backdropFor({ambient=false,wallpaper='room',photoCount=0,shared=false,frameNow=false}={}){
 if(!ambient)return wallpaper==='plain'?'plain':'room';
 if(shared)return 'room';
 if((frameNow||wallpaper==='photos')&&photoCount>0)return 'photos';
 return wallpaper==='photos'?'room':wallpaper;
}
/** Dark lamp palette: a night idle screen, a night sky or photos (light text over a picture). */
export function lampPalette({ambient=false,backdrop='room',night=false,nightDim=true}={}){
 return ambient&&(backdrop==='stars'||backdrop==='photos'||(night&&nightDim));
}
const wallpaperRandom=seed=>()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
/** A fixed sky: positions in %, sizes in px and twinkle timing. The same seed gives the same stars. */
export function starField(count=96,seed=11){
 const random=wallpaperRandom(seed),stars=[];
 for(let i=0;i<count;i++){
  const big=random()>.9;
  stars.push({x:+(random()*100).toFixed(2),y:+(Math.pow(random(),1.3)*92).toFixed(2),size:big?2.6:+(1+random()*1.2).toFixed(2),
   delay:+(random()*-9).toFixed(2),dur:+(3+random()*6).toFixed(2),alpha:+(.35+random()*.6).toFixed(2)});
 }
 return stars;
}
/** The layers behind the stage. Which one shows is decided by body[data-backdrop]. */
export const wallpaperHTML=()=>'<div class="wallpaper" id="wallpaper" aria-hidden="true"><div class="wp wp-room"><i class="wp-tint"></i><i class="wp-sun"></i></div><div class="wp wp-drift"><i></i><i></i><i></i></div><div class="wp wp-stars" id="wp-stars"></div><div class="wp wp-photos" id="wp-photos"></div></div>';
export function paintStars(host,count=96){
 if(!host||host.childElementCount)return;
 const frag=document.createDocumentFragment();
 for(const s of starField(count)){
  const star=document.createElement('i');
  star.style.cssText=`left:${s.x}%;top:${s.y}%;width:${s.size}px;height:${s.size}px;--a:${s.alpha};animation-delay:${s.delay}s;animation-duration:${s.dur}s`;
  frag.append(star);
 }
 const shoot=document.createElement('b');shoot.className='shoot';frag.append(shoot);
 host.append(frag);
}
