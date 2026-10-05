/** Window light and lamp light for the home stage. One soft patch of sun moves across the room with
 * the hour, softens under cloud and disappears in rain; the lamp comes up at dusk and on dark days.
 * Only the clock is required. Weather, sunrise and sunset refine it when they are known.
 * Pure: returns numbers and CSS custom properties and never touches the page.
 */
const dayClamp=(x,a,b)=>Math.max(a,Math.min(b,x)),dayLerp=(a,b,t)=>a+(b-a)*t;
const dayMix=(a,b,t)=>a.map((v,i)=>Math.round(dayLerp(v,b[i],t)));

/** How a WMO weather code behaves as light: clear, partly, cloud, fog, snow or rain. */
export function skyOf(code){
 const c=Number(code);
 if(code===null||code===undefined||!Number.isFinite(c)||c<=1)return 'clear';
 if(c===2)return 'partly';
 if(c===3)return 'cloud';
 if(c===45||c===48)return 'fog';
 if((c>=71&&c<=77)||c===85||c===86)return 'snow';
 return c>=51?'rain':'clear';
}
// sun: strength of the patch; blur and lines: [at noon, near sunrise/sunset]; lamp: extra lamp light on dull days.
const SKY={
 clear:{sun:1,blur:[5,9],lines:[.1,.16],lamp:0},
 partly:{sun:.8,blur:[8,12],lines:[.09,.13],lamp:.04},
 cloud:{sun:.4,blur:[24,24],lines:[.03,.03],lamp:.08},
 fog:{sun:.3,blur:[30,30],lines:[.02,.02],lamp:.12},
 snow:{sun:.45,blur:[26,26],lines:[.02,.02],lamp:.1},
 rain:{sun:0,blur:[24,24],lines:[0,0],lamp:.22}
};
const SKY_TINT={rain:'rgba(118,140,165,.09)',cloud:'rgba(140,140,140,.05)',fog:'rgba(170,170,170,.07)',snow:'rgba(200,220,245,.07)'};

/** Sunrise and sunset in hours of the local day. Today's values are used only when they are plausible. */
export function sunTimes(now=new Date(),weather=null){
 const midnight=new Date(now);midnight.setHours(0,0,0,0);
 const rise=Date.parse(weather?.daily?.sunrise?.[0]),set=Date.parse(weather?.daily?.sunset?.[0]);
 if(Number.isFinite(rise)&&Number.isFinite(set)){
  const r=(rise-midnight.getTime())/3600e3,s=(set-midnight.getTime())/3600e3;
  if(r>=2&&r<=11&&s>=13&&s<=23&&s>r+6)return {rise:r,set:s};
 }
 return {rise:6,set:18};
}

/** The light of the room at `now`: {hour, sky, sun, lamp, tint}. */
export function daylightState({now=new Date(),weather=null}={}){
 const hour=now.getHours()+now.getMinutes()/60,{rise,set}=sunTimes(now,weather);
 const sky=weather?.current?skyOf(weather.current.weather_code):'clear',k=SKY[sky];
 const t=dayClamp((hour-rise)/(set-rise),0,1),edge=Math.abs(t-.5)*2;
 const day=dayClamp(Math.min((hour-(rise-.3))/1.3,(set+.6-hour)/1.3),0,1);
 const color=t<.5?dayMix([255,248,234],[255,253,247],t*2):dayMix([255,253,247],[255,236,206],(t-.5)*2);
 const dusk=hour<rise-.5?1:dayClamp((hour-(set-.8))/2.4,0,1);
 let tint=SKY_TINT[sky]||'transparent';
 if(sky==='clear'||sky==='partly')tint=hour<rise+2?'rgba(190,214,255,.05)':hour>set-2&&hour<set+1.5?'rgba(255,170,100,.06)':'transparent';
 return {
  hour,sky,
  sun:{x:dayLerp(-16,62,t),skew:dayLerp(-26,22,t),opacity:day*k.sun,blur:dayLerp(k.blur[0],k.blur[1],edge),lines:dayLerp(k.lines[0],k.lines[1],edge),color},
  lamp:{pool:dayClamp(dusk*.5+k.lamp,0,.7),halo:dayClamp(dusk*.55+k.lamp*1.2,0,.6)},
  tint
 };
}
/** CSS custom properties for the wallpaper layers. Rounded, so an unchanged minute yields an identical set. */
export function daylightVars(state){
 const {sun,lamp,tint}=state,c=sun.color;
 return {
  '--sun-x':sun.x.toFixed(1),'--sun-skew':sun.skew.toFixed(1),'--sun-o':sun.opacity.toFixed(2),'--sun-blur':sun.blur.toFixed(1),
  '--sun-lines':sun.lines.toFixed(3),'--sun-color':`rgba(${c[0]},${c[1]},${c[2]},.96)`,
  '--pool-o':lamp.pool.toFixed(2),'--halo-o':lamp.halo.toFixed(2),'--sky-tint':tint
 };
}
