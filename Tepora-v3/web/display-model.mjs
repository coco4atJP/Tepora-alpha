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
export const STAGE_LAYOUTS=Object.freeze(['companion-split','dashboard-bento','center-stage','standby-clock']);
export const CLOCK_STYLES=Object.freeze(['editorial','modern','mono']);
export const CLOCK_SIZES=Object.freeze(['compact','medium','hero']);
export const WEATHER_MODES=Object.freeze(['notable','always']);
export const MONITOR_SCENES=Object.freeze({
  standard:{label:'いつもの部屋',desc:'相棒と時計を中心に、情報を静かに回す標準の配置',scene:'standard',layout:'companion-split',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,pinnedWidgets:[],weatherMode:'notable',workCard:false,widgets:['clock','companion','work','weather','news','media','artifact'],patch:{scene:'standard',layout:'companion-split',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,pinnedWidgets:[],weatherMode:'notable',workCard:false,widgets:['clock','companion','work','weather','news','media','artifact']}},
  work:{label:'ワークデスク',desc:'複数ウィジェットを常時表示し、作業と時計を見渡しやすくする配置',scene:'work',layout:'dashboard-bento',clockStyle:'modern',clockSize:'compact',clockSeconds:false,pinnedWidgets:['focus','work','schedule','system'],weatherMode:'always',workCard:true,widgets:['clock','companion','focus','work','schedule','system','weather','memo','news','artifact'],patch:{scene:'work',layout:'dashboard-bento',clockStyle:'modern',clockSize:'compact',clockSeconds:false,pinnedWidgets:['focus','work','schedule','system'],weatherMode:'always',workCard:true,widgets:['clock','companion','focus','work','schedule','system','weather','memo','news','artifact']}},
  relax:{label:'くつろぎの窓辺',desc:'相棒をステージ中央に据え、暦や天気をゆったり楽しむ配置',scene:'relax',layout:'center-stage',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,pinnedWidgets:['weather','almanac'],weatherMode:'always',workCard:false,widgets:['clock','companion','weather','almanac','media','news','memo','artifact'],patch:{scene:'relax',layout:'center-stage',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,pinnedWidgets:['weather','almanac'],weatherMode:'always',workCard:false,widgets:['clock','companion','weather','almanac','media','news','memo','artifact']}},
  night:{label:'ナイトクロック',desc:'時計と最小限のカードだけを残す、枕元・待機向けの静かな配置',scene:'night',layout:'standby-clock',clockStyle:'mono',clockSize:'hero',clockSeconds:true,pinnedWidgets:[],weatherMode:'notable',workCard:false,widgets:['clock','weather','schedule','almanac'],patch:{scene:'night',layout:'standby-clock',clockStyle:'mono',clockSize:'hero',clockSeconds:true,pinnedWidgets:[],weatherMode:'notable',workCard:false,widgets:['clock','weather','schedule','almanac']}}
});
export const MONITOR_DEFAULT=Object.freeze({
  scene:'standard',layout:'companion-split',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,
  pinnedWidgets:Object.freeze([]),weatherMode:'notable',workCard:false,focusMinutes:25,pinnedNote:''
});
const KEYS = new Set([
  'theme','textScale','widgets','hiddenUntil','ambient',
  'scene','layout','clockStyle','clockSize','clockSeconds',
  'pinnedWidgets','weatherMode','workCard','focusMinutes','pinnedNote'
]);
export const WIDGETS = ['clock','companion','weather','news','media','work','artifact','focus','schedule','memo','system','almanac'];
export const IDLE_CHOICES=[0,1,3,5,10,30];
export function monitorConfig(display=DISPLAY_DEFAULT){
  const src=display&&typeof display==='object'?display:{};
  return {
    scene:typeof src.scene==='string'&&Object.hasOwn(MONITOR_SCENES,src.scene)?src.scene:MONITOR_DEFAULT.scene,
    layout:STAGE_LAYOUTS.includes(src.layout)?src.layout:MONITOR_DEFAULT.layout,
    clockStyle:CLOCK_STYLES.includes(src.clockStyle)?src.clockStyle:MONITOR_DEFAULT.clockStyle,
    clockSize:CLOCK_SIZES.includes(src.clockSize)?src.clockSize:MONITOR_DEFAULT.clockSize,
    clockSeconds:typeof src.clockSeconds==='boolean'?src.clockSeconds:MONITOR_DEFAULT.clockSeconds,
    pinnedWidgets:Array.isArray(src.pinnedWidgets)?src.pinnedWidgets.filter(w=>WIDGETS.includes(w)&&w!=='clock'&&w!=='companion').slice(0,4):[],
    weatherMode:WEATHER_MODES.includes(src.weatherMode)?src.weatherMode:MONITOR_DEFAULT.weatherMode,
    workCard:typeof src.workCard==='boolean'?src.workCard:MONITOR_DEFAULT.workCard,
    focusMinutes:Number.isInteger(src.focusMinutes)&&src.focusMinutes>=5&&src.focusMinutes<=90?src.focusMinutes:MONITOR_DEFAULT.focusMinutes,
    pinnedNote:typeof src.pinnedNote==='string'?src.pinnedNote.slice(0,240):MONITOR_DEFAULT.pinnedNote
  };
}
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
  displayInvariant(next.scene===undefined||typeof next.scene==='string'&&Object.hasOwn(MONITOR_SCENES,next.scene),'Invalid monitor scene');
  displayInvariant(next.layout===undefined||STAGE_LAYOUTS.includes(next.layout),'Invalid stage layout');
  displayInvariant(next.clockStyle===undefined||CLOCK_STYLES.includes(next.clockStyle),'Invalid clock style');
  displayInvariant(next.clockSize===undefined||CLOCK_SIZES.includes(next.clockSize),'Invalid clock size');
  displayInvariant(next.clockSeconds===undefined||typeof next.clockSeconds==='boolean','Invalid clock seconds setting');
  displayInvariant(next.pinnedWidgets===undefined||Array.isArray(next.pinnedWidgets)&&next.pinnedWidgets.length<=4&&
    next.pinnedWidgets.every(w=>WIDGETS.includes(w)&&w!=='clock'&&w!=='companion')&&new Set(next.pinnedWidgets).size===next.pinnedWidgets.length,'Invalid pinned widgets');
  displayInvariant(next.weatherMode===undefined||WEATHER_MODES.includes(next.weatherMode),'Invalid weather mode');
  displayInvariant(next.workCard===undefined||typeof next.workCard==='boolean','Invalid work card setting');
  displayInvariant(next.focusMinutes===undefined||Number.isInteger(next.focusMinutes)&&next.focusMinutes>=5&&next.focusMinutes<=90,'Invalid focus timer minutes');
  displayInvariant(next.pinnedNote===undefined||typeof next.pinnedNote==='string'&&next.pinnedNote.length<=240,'Invalid pinned note');
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

