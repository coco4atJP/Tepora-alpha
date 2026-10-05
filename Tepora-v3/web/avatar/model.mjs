/** The avatar spec: everything a person can change about the character on the home stage, as plain
 * enumerated values. Shared by the browser and the service, like display-model.mjs.
 *
 * Nothing here is free text, a URL or markup, and nothing here can name a permission, an
 * endpoint or a file path: a spec can be saved, exported and shared without carrying anything
 * else along. Bodies declare their own `slots`, so a new body adds options without a schema change.
 */
const avFail=message=>{throw Object.assign(new Error(message),{status:400});};
const avCheck=(condition,message)=>{if(!condition)avFail(message);};
const avPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

export const AVATAR_SCHEMA=1;

/** Materials (素材): each one is a coherent set of colours, so any choice stays readable. */
export const AVATAR_PALETTES=Object.freeze({
 washi:{name:'和紙',body:'#fbf6ec',light:'#fffdf9',shade:'#e8dcc7',ink:'#2b2722',cheek:'#ef9f86',limb:'#efe4d2',foot:'#e6d8c1'},
 porcelain:{name:'陶器',body:'#f1f5f6',light:'#ffffff',shade:'#cdd8dc',ink:'#24303a',cheek:'#eaa8a2',limb:'#e3ecee',foot:'#cfdadd'},
 felt:{name:'フェルト',body:'#e8dcc3',light:'#f4ead6',shade:'#cbb88f',ink:'#3a2e22',cheek:'#e39a7e',limb:'#dccdae',foot:'#c9b68c'},
 moss:{name:'苔',body:'#a9ba8c',light:'#c6d4aa',shade:'#7c9066',ink:'#26331f',cheek:'#e6a58c',limb:'#9aae7c',foot:'#7c9066'},
 sora:{name:'空',body:'#dde8f2',light:'#f0f6fb',shade:'#b4c6d8',ink:'#26364a',cheek:'#eaa7a0',limb:'#cfdeeb',foot:'#aebfd1'},
 sakura:{name:'桜',body:'#f7e4e2',light:'#fff4f2',shade:'#e2bdb9',ink:'#3b2a2c',cheek:'#ee9a92',limb:'#f0d6d3',foot:'#dfb8b4'},
 kitsune:{name:'狐色',body:'#e9cba2',light:'#f6e0c2',shade:'#cfa571',ink:'#3a2a1c',cheek:'#e08f6f',limb:'#dfba8c',foot:'#c79a62'},
 sumi:{name:'墨',body:'#413c36',light:'#5d574f',shade:'#27231f',ink:'#f3ece0',cheek:'#b9735e',limb:'#38342f',foot:'#27231f',dark:true}
});
export const AVATAR_PALETTE_IDS=Object.freeze([...Object.keys(AVATAR_PALETTES),'custom']);
/** The lamp is the character's own colour. Amber is the colour of "waiting for you" and is never offered. */
export const AVATAR_LAMPS=Object.freeze({
 vermilion:{name:'朱',day:'#d4583a',night:'#ef7a58',glow:'239,122,88'},
 indigo:{name:'藍',day:'#3b5ba5',night:'#8fa8ea',glow:'110,140,230'},
 matcha:{name:'抹茶',day:'#5f8f4e',night:'#a5d18c',glow:'140,200,120'},
 plum:{name:'梅紫',day:'#8a4a7d',night:'#d093c4',glow:'200,130,190'},
 snow:{name:'雪',day:'#d9d0bd',night:'#fff6df',glow:'255,240,210'}
});
export const AVATAR_LAMP_SHAPES=Object.freeze(['bead','flame','bud','bulb','none']);
export const AVATAR_EYES=Object.freeze(['capsule','dot','big','sleepy']);
export const AVATAR_EARS=Object.freeze(['none','cat','bear','rabbit']);
export const AVATAR_SEASONS=Object.freeze(['auto','off','petal','uchiwa','leaf','scarf']);
export const AVATAR_HOBBIES=Object.freeze(['none','headphones','glasses','cup']);
export const AVATAR_MOTIONS=Object.freeze(['calm','normal','lively']);
export const AVATAR_RENDER=Object.freeze(['flat','solid']);
export const AVATAR_SIZE=Object.freeze({min:.8,max:1.25});
export const AVATAR_ASSET_KINDS=Object.freeze(['image','imageset','vrm','mesh']);
export const AVATAR_ASSET_ID=/^[a-f0-9-]{36}$/;

const SHAPE_EYES=[['capsule','たて長'],['dot','点'],['big','大きい'],['sleepy','ねむたげ']];
/** The bodies. kind svg is drawn in the page; image, vrm and mesh need an asset from the library. */
export const AVATAR_BODIES=Object.freeze([
 {id:'shiro',kind:'svg',name:'しろ・改',note:'いまの姿を磨いた、既定の相棒',face:true,parts:['ears'],props:true,modes:['flat','solid'],
  slots:[{key:'shape',label:'からだ',opts:[['egg','たまご'],['mochi','もち'],['tall','のっぽ']]}]},
 {id:'andon',kind:'svg',name:'灯守',note:'和紙の行灯。夜は中から灯り、考え中は走馬灯の影が回る',face:true,props:true,modes:['flat'],
  slots:[{key:'shape',label:'行灯のかたち',opts:[['round','まる'],['drum','つつ'],['gourd','ひょうたん']]},{key:'soma',label:'走馬灯の影',opts:[['auto','季節にまかせる'],['leaf','紅葉'],['fish','金魚'],['bird','燕'],['snow','雪'],['moon','月と星']]}]},
 {id:'ensou',kind:'svg',name:'円相',note:'墨の一筆。輪のあきが口と耳',props:true,modes:['flat'],
  slots:[{key:'brush',label:'筆の太さ',opts:[['thin','細い'],['mid','ふつう'],['bold','太い']]},{key:'eyes',label:'目',opts:[['dot','墨の点'],['line','ひと筆'],['slit','たて筆']]}]},
 {id:'kobako',kind:'svg',name:'小箱',note:'画面が顔の小さな機械。遠くからでも読める',props:true,modes:['flat'],
  slots:[{key:'shape',label:'からだ',opts:[['box','はこ'],['tall','たて'],['round','まる']]},{key:'screen',label:'画面の顔',opts:[['led','棒の目'],['dot','丸い目'],['pixel','ドット'],['bar','一本線']]}]},
 {id:'kitsune',kind:'svg',name:'狐火',note:'尾の先に灯りを持つ白い小狐。耳としっぽに気持ちが出る',face:true,props:true,lampShape:'flame',modes:['flat'],
  slots:[{key:'earLength',label:'耳',opts:[['std','ふつう'],['long','長い']]}]},
 {id:'hotaru',kind:'svg',name:'蛍',note:'体のない、やわらかな光',face:true,props:true,eyes:'dot',modes:['flat'],
  slots:[{key:'faceVis',label:'顔',opts:[['always','いつも'],['engage','呼ばれたとき'],['never','出さない']]},{key:'halo',label:'光のひろがり',opts:[['soft','やわらか'],['wide','広い'],['tight','小さめ']]}]},
 {id:'kokedama',kind:'svg',name:'苔玉',note:'芽の先が灯りの蕾。窓へ傾き、季節で葉の色が変わる',face:true,props:true,palette:'moss',lampShape:'bud',eyes:'dot',modes:['flat'],
  slots:[{key:'leaves',label:'葉の色',opts:[['auto','季節にまかせる'],['spring','春'],['summer','夏'],['autumn','秋'],['winter','冬']]},{key:'faceVis',label:'顔',opts:[['always','いつも'],['never','出さない']]}]},
 {id:'image',kind:'image',name:'画像（1枚）',note:'好きな絵や写真をそのまま相棒に',needs:'image',modes:['flat'],slots:[]},
 {id:'imageset',kind:'image',name:'画像セット',note:'気分ごとの絵（PNGtuber形式）。口を開けた絵も使えます',needs:'imageset',modes:['flat'],slots:[]},
 {id:'vrm',kind:'vrm',name:'3Dモデル（VRM）',note:'VRM 1.0 / 0.x。今までのキャラクターをそのまま',needs:'vrm',modes:['flat'],
  slots:[{key:'framing',label:'映す範囲',opts:[['bust','上半身'],['full','全身']]}]},
 {id:'mesh',kind:'mesh',name:'メッシュアバター',note:'mesh-avatar-studio で作った、動くイラスト',needs:'mesh',modes:['flat'],slots:[]}
]);
export const AVATAR_BODY_IDS=Object.freeze(AVATAR_BODIES.map(b=>b.id));
export const avatarBody=id=>AVATAR_BODIES.find(b=>b.id===id)||null;
/** The kind of library asset a spec needs, or null. */
export const avatarNeeds=spec=>avatarBody(spec?.body)?.needs||null;

/** A fresh spec for a body. */
export function defaultAvatar(body='shiro'){
 const def=avatarBody(body)||avatarBody('shiro');
 return {schema:AVATAR_SCHEMA,body:def.id,render:'flat',palette:def.palette||'washi',hue:30,
  lamp:{hue:'vermilion',shape:def.lampShape||'bead'},face:{eyes:def.eyes||'capsule',cheeks:true,brows:true},
  parts:{ears:'none'},props:{season:'off',hobby:'none'},slots:{},motion:'normal',size:1,asset:null};
}
export const AVATAR_DEFAULT=Object.freeze({...defaultAvatar('shiro'),revision:0});

/** Changing the body starts from that body's own defaults and carries over what is personal. */
function switchBody(previous,id){
 const old=avatarBody(previous.body),def=avatarBody(id),fresh=defaultAvatar(id);
 const ownPalette=previous.palette!==(old.palette||'washi'),ownShape=previous.lamp.shape!==(old.lampShape||'bead');
 const shape=ownShape&&(def.kind!=='svg'||previous.lamp.shape!=='none')?previous.lamp.shape:fresh.lamp.shape;
 return {...fresh,palette:ownPalette?previous.palette:fresh.palette,hue:previous.hue,lamp:{hue:previous.lamp.hue,shape},
  face:{...fresh.face,cheeks:previous.face.cheeks,brows:previous.face.brows},props:{...previous.props},motion:previous.motion,size:previous.size,
  render:def.modes.includes(previous.render)?previous.render:'flat',revision:previous.revision};
}

/** Merge a patch into the previous spec and check the result. Throws a 400 for anything unexpected. */
export function validateAvatar(input,previous=AVATAR_DEFAULT){
 avCheck(avPlain(input),'Invalid avatar settings');
 const top=['body','render','palette','hue','lamp','face','parts','props','slots','motion','size','asset'];
 for(const key of Object.keys(input))avCheck(top.includes(key),`Avatar cannot change ${key}`);
 let base=structuredClone(previous);
 if(input.body!==undefined&&input.body!==previous.body){avCheck(typeof input.body==='string'&&avatarBody(input.body),'Invalid body');base=switchBody(previous,input.body);}
 const next=structuredClone(base);
 const group=(key,allowed)=>{
  if(input[key]===undefined)return;
  avCheck(avPlain(input[key]),`Invalid ${key}`);
  for(const k of Object.keys(input[key]))avCheck(allowed.includes(k),`Avatar cannot change ${key}.${k}`);
  Object.assign(next[key],input[key]);
 };
 for(const key of ['render','palette','hue','motion','size','asset'])if(input[key]!==undefined)next[key]=input[key];
 group('lamp',['hue','shape']);group('face',['eyes','cheeks','brows']);group('parts',['ears']);group('props',['season','hobby']);
 const def=avatarBody(next.body);
 avCheck(def,'Invalid body');
 avCheck(def.modes.includes(next.render),'Invalid render mode for this body');
 avCheck(AVATAR_PALETTE_IDS.includes(next.palette),'Invalid palette');
 avCheck(typeof next.hue==='number'&&Number.isFinite(next.hue)&&next.hue>=0&&next.hue<=360,'Invalid hue');next.hue=Math.round(next.hue*10)/10;
 avCheck(Object.hasOwn(AVATAR_LAMPS,next.lamp.hue),'Invalid lamp colour');
 avCheck(AVATAR_LAMP_SHAPES.includes(next.lamp.shape)&&(next.lamp.shape!=='none'||def.kind!=='svg'),'Invalid lamp shape');
 avCheck(AVATAR_EYES.includes(next.face.eyes),'Invalid eyes');
 avCheck(typeof next.face.cheeks==='boolean'&&typeof next.face.brows==='boolean','Invalid face');
 avCheck(AVATAR_EARS.includes(next.parts.ears)&&(next.parts.ears==='none'||def.parts?.includes('ears')),'Invalid ears');
 avCheck(AVATAR_SEASONS.includes(next.props.season),'Invalid season prop');
 avCheck(AVATAR_HOBBIES.includes(next.props.hobby),'Invalid hobby prop');
 avCheck(AVATAR_MOTIONS.includes(next.motion),'Invalid motion');
 avCheck(typeof next.size==='number'&&Number.isFinite(next.size)&&next.size>=AVATAR_SIZE.min&&next.size<=AVATAR_SIZE.max,'Invalid size');next.size=Math.round(next.size*100)/100;
 if(input.slots!==undefined){
  avCheck(avPlain(input.slots),'Invalid slots');
  for(const [key,value] of Object.entries(input.slots)){
   const slot=def.slots.find(s=>s.key===key);avCheck(slot,`This body has no ${key} setting`);
   avCheck(slot.opts.some(o=>o[0]===value),`Invalid ${key}`);next.slots[key]=value;
  }
 }
 avCheck(next.asset===null||(typeof next.asset==='string'&&AVATAR_ASSET_ID.test(next.asset)),'Invalid asset');
 avCheck(def.needs||next.asset===null,'This body does not use an uploaded file');
 next.schema=AVATAR_SCHEMA;
 return next;
}

/** A preset carries the look only. Asset ids belong to this PC and are never exported. */
export function exportAvatar(spec){const {schema,revision,asset,...settings}=spec;return {format:'tepora-avatar',version:1,settings};}
export function importAvatarPreset(preset){
 avCheck(avPlain(preset)&&preset.format==='tepora-avatar'&&preset.version===1,'Unsupported avatar preset');
 avCheck(Object.keys(preset).every(k=>['format','version','settings'].includes(k)),'Presets cannot include capabilities');
 avCheck(avPlain(preset.settings),'Invalid avatar preset');
 const {asset,...rest}=preset.settings;avCheck(asset===undefined||asset===null,'Presets cannot name an uploaded file');
 return rest;
}

/* ---- colours: one resolver for every renderer ---- */
const avClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const avRgb=h=>{h=h.replace('#','');const n=parseInt(h,16);return [n>>16&255,n>>8&255,n&255];};
const avHex=a=>'#'+a.map(v=>Math.round(avClamp(v,0,255)).toString(16).padStart(2,'0')).join('');
const avMix=(a,b,t)=>{const A=avRgb(a),B=avRgb(b);return avHex(A.map((v,i)=>v+(B[i]-v)*t));};
const avHsl=(h,s,l)=>{h=((h%360)+360)%360;s/=100;l/=100;const k=n=>(n+h/30)%12,a=s*Math.min(l,1-l),f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1)));return avHex([f(0)*255,f(8)*255,f(4)*255]);};
/** One knob for "any colour I like": lightness and chroma are fixed, so the face always reads. */
export function customAvatarPalette(hue){return {name:'好きな色',body:avHsl(hue,34,91),light:avHsl(hue,46,96),shade:avHsl(hue,26,79),ink:avHsl(hue,24,14),cheek:avHsl(hue+8,68,76),limb:avHsl(hue,30,88),foot:avHsl(hue,24,83)};}
export function avatarLuminance(hex){const [r,g,b]=avRgb(hex).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;}
export function avatarContrast(a,b){const x=avatarLuminance(a),y=avatarLuminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
/** The colours a body draws with, for a theme ('light', 'dark' or 'lamp'). Bright materials are dimmed a little on dark grounds. */
export function resolveAvatarColors(spec,theme='light'){
 let p=spec.palette==='custom'?customAvatarPalette(spec.hue??30):AVATAR_PALETTES[spec.palette]||AVATAR_PALETTES.washi;
 if(theme!=='light'&&!p.dark){const k=c=>avMix(c,'#cfc3ad',.22);p={...p,body:k(p.body),light:k(p.light),shade:k(p.shade),limb:k(p.limb),foot:k(p.foot)};}
 const lamp=AVATAR_LAMPS[spec.lamp?.hue]||AVATAR_LAMPS.vermilion;
 return {...p,lamp:theme==='light'?lamp.day:lamp.night,lampRgb:lamp.glow};
}
