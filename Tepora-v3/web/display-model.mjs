const displayInvariant=(condition,message)=>{if(!condition)throw Object.assign(new Error(message),{status:400});};
/** Idle-screen wallpapers. 部屋 is the window light and lamp of the home stage; 写真 is the photo frame. */
export const WALLPAPERS=Object.freeze(['room','plain','drift','stars','photos']);
export const FRAME_SECONDS=Object.freeze([10,30,60,300,900,3600]);
export const FRAME_FITS=Object.freeze(['cover','contain','mat']);
export const FRAME_CLOCKS=Object.freeze(['off','small','large']);
export const AMBIENT_DEFAULT=Object.freeze({idleMinutes:5,rotateSeconds:12,nightDim:true,wallpaper:'room',keepAwake:false,
  frameSeconds:30,frameShuffle:true,frameFit:'cover',frameMotion:true,frameClock:'small',frameCreated:true});
export const DISPLAY_DEFAULT = Object.freeze({
  schema:1,revision:0,theme:'system',textScale:1,
  widgets:['clock','companion','work','weather','news','media','artifact'],hiddenUntil:{},ambient:AMBIENT_DEFAULT
});
const KEYS = new Set(['theme','textScale','widgets','hiddenUntil','ambient']);
export const WIDGETS = ['clock','companion','weather','news','media','work','artifact'];
export const IDLE_CHOICES=[0,1,3,5,10,30];
export function validateDisplay(input,previous=DISPLAY_DEFAULT) {
  displayInvariant(input && typeof input==='object' && !Array.isArray(input),'Invalid display settings');
  for(const key of Object.keys(input)) displayInvariant(KEYS.has(key),`Display cannot change ${key}`);
  const next=structuredClone({...previous,...input});
  displayInvariant(['system','light','dark'].includes(next.theme),'Invalid theme');
  displayInvariant(Number.isFinite(next.textScale)&&next.textScale>=0.8&&next.textScale<=1.8,'Invalid text scale');
  displayInvariant(Array.isArray(next.widgets)&&next.widgets.length<=WIDGETS.length&&
    next.widgets.every(w=>WIDGETS.includes(w))&&new Set(next.widgets).size===next.widgets.length,'Invalid widgets');
  displayInvariant(next.hiddenUntil && typeof next.hiddenUntil==='object' && !Array.isArray(next.hiddenUntil),'Invalid temporary visibility');
  for(const [widget,until] of Object.entries(next.hiddenUntil)) {
    displayInvariant(WIDGETS.includes(widget)&&typeof until==='string'&&Number.isFinite(Date.parse(until)),'Invalid hide-until time');
  }
  const ambient={...AMBIENT_DEFAULT,...(next.ambient||{})};
  displayInvariant(next.ambient===undefined||next.ambient&&typeof next.ambient==='object'&&!Array.isArray(next.ambient),'Invalid idle screen settings');
  for(const key of Object.keys(ambient))displayInvariant(Object.hasOwn(AMBIENT_DEFAULT,key),`Display cannot change ambient.${key}`);
  displayInvariant(IDLE_CHOICES.includes(ambient.idleMinutes),'Invalid idle time');
  displayInvariant(Number.isInteger(ambient.rotateSeconds)&&ambient.rotateSeconds>=6&&ambient.rotateSeconds<=120,'Invalid card interval');
  displayInvariant(typeof ambient.nightDim==='boolean','Invalid night setting');
  displayInvariant(WALLPAPERS.includes(ambient.wallpaper),'Invalid wallpaper');
  displayInvariant(typeof ambient.keepAwake==='boolean','Invalid keep-awake setting');
  displayInvariant(FRAME_SECONDS.includes(ambient.frameSeconds),'Invalid photo interval');
  displayInvariant(typeof ambient.frameShuffle==='boolean','Invalid photo order');
  displayInvariant(FRAME_FITS.includes(ambient.frameFit),'Invalid photo fit');
  displayInvariant(typeof ambient.frameMotion==='boolean','Invalid photo motion');
  displayInvariant(FRAME_CLOCKS.includes(ambient.frameClock),'Invalid photo clock');
  displayInvariant(typeof ambient.frameCreated==='boolean','Invalid created-images setting');
  next.ambient=ambient;
  return next;
}
