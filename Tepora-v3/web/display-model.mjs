const displayInvariant=(condition,message)=>{if(!condition)throw Object.assign(new Error(message),{status:400});};
export const AMBIENT_DEFAULT=Object.freeze({idleMinutes:5,rotateSeconds:12,nightDim:true});
export const DISPLAY_DEFAULT = Object.freeze({
  schema:1,revision:0,theme:'system',textScale:1,companion:'orb',
  widgets:['clock','companion','work','weather','news','media','artifact'],hiddenUntil:{},ambient:AMBIENT_DEFAULT
});
const KEYS = new Set(['theme','textScale','companion','widgets','hiddenUntil','ambient']);
export const WIDGETS = ['clock','companion','weather','news','media','work','artifact'];
export const IDLE_CHOICES=[0,1,3,5,10,30];
export function validateDisplay(input,previous=DISPLAY_DEFAULT) {
  displayInvariant(input && typeof input==='object' && !Array.isArray(input),'Invalid display settings');
  for(const key of Object.keys(input)) displayInvariant(KEYS.has(key),`Display cannot change ${key}`);
  const next=structuredClone({...previous,...input});
  displayInvariant(['system','light','dark'].includes(next.theme),'Invalid theme');
  displayInvariant(Number.isFinite(next.textScale)&&next.textScale>=0.8&&next.textScale<=1.8,'Invalid text scale');
  displayInvariant(['orb','brass','none','vrm'].includes(next.companion),'Invalid companion');
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
  next.ambient=ambient;
  return next;
}
