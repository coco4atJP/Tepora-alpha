// TEST-ONLY frozen JavaScript oracle from the current published19008a1 migration snapshot.
// Production imports are forbidden. Only imports/environment shims were adjusted.
/** The character's voice: the fixed lines the screen speaks (greetings, welcome back, "something needs
 * you") and the style hint the model receives. It belongs to the persona, not to the avatar: any
 * voice can be worn by any avatar. Shared by the browser and the service, like display-model.mjs.
 *
 * A person picks a tone pack and may rewrite any single line. Rewritten lines are for the screen
 * only; the model is only ever told the tone, the call name and how often to speak up.
 */
const voiceFail=message=>{throw Object.assign(new Error(message),{status:400});};
const voiceCheck=(condition,message)=>{if(!condition)voiceFail(message);};
const voicePlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Every fixed line, with what it is for and the values it may use. */
export const VOICE_SCENES=Object.freeze([
 {key:'opening.morning',group:'あいさつ',label:'朝（〜10時）'},
 {key:'opening.day',group:'あいさつ',label:'昼'},
 {key:'opening.evening',group:'あいさつ',label:'夕方'},
 {key:'opening.night',group:'あいさつ',label:'夜'},
 {key:'note.morning',group:'ひとこと',label:'朝のひとこと'},
 {key:'note.day',group:'ひとこと',label:'昼のひとこと'},
 {key:'note.evening',group:'ひとこと',label:'夕方のひとこと'},
 {key:'note.night',group:'ひとこと',label:'夜のひとこと'},
 {key:'weather.rain',group:'天気',label:'雨・雷',vars:['label']},
 {key:'weather.snow',group:'天気',label:'雪'},
 {key:'weather.hot',group:'天気',label:'暑い日',vars:['t']},
 {key:'weather.cold',group:'天気',label:'寒い日',vars:['t']},
 {key:'back.hello',group:'おかえり',label:'戻ってきたとき'},
 {key:'back.finished',group:'おかえり',label:'仕事が終わっていたとき',vars:['n']},
 {key:'back.waiting',group:'おかえり',label:'確認が待っているとき',vars:['n']},
 {key:'back.running',group:'おかえり',label:'仕事が続いているとき',vars:['n']},
 {key:'back.quiet',group:'おかえり',label:'何もなかったとき'},
 {key:'waiting',group:'お願い',label:'確認してほしいとき',vars:['n']},
 {key:'season',group:'季節',label:'季節の話題（おしゃべりのとき）',vars:['kou']}
]);
export const VOICE_KEYS=Object.freeze(VOICE_SCENES.map(s=>s.key));

/** The tone packs. polite is the text the screen has always used. */
export const VOICE_TONES=Object.freeze({
 polite:{name:'ていねい',note:'いまの標準',suffix:'さん',
  style:'です・ます調で、落ち着いて親しみやすく話す。返事は1〜3文で短く。',
  lines:{'opening.morning':'おはようございます。','opening.day':'こんにちは。','opening.evening':'おつかれさまです。','opening.night':'夜遅くまでおつかれさまです。',
   'note.morning':'よく眠れましたか。','note.day':'ひと息ついていきませんか。','note.evening':'今日はどんな一日でしたか。','note.night':'そろそろ休みませんか。',
   'weather.rain':'外は{label}です。出かけるなら傘を。','weather.snow':'雪が降っています。足もとに気をつけて。','weather.hot':'{t}°まで上がっています。水分を少し多めに。','weather.cold':'{t}°と冷えています。あたたかくしてください。',
   'back.hello':'おかえりなさい。','back.finished':'留守のあいだに、仕事が{n}終わりました。','back.waiting':'確認が{n}、お待ちです。','back.running':'仕事は、あと{n}進めています。','back.quiet':'おかえりなさい。留守のあいだ、静かでした。',
   'waiting':'確認していただきたいことが、{n}あります。','season':'いまは「{kou}」の頃です。'}},
 soft:{name:'やわらか',note:'やさしく寄りそう',suffix:'さん',
  style:'やさしい言葉で、急かさずに話す。相手の気持ちに寄りそってから要点を伝える。返事は短めに。',
  lines:{'opening.morning':'おはようございます。','opening.day':'こんにちは。','opening.evening':'おつかれさま。','opening.night':'遅くまでおつかれさま。',
   'note.morning':'今日もゆっくり始めましょうね。','note.day':'お茶でもいかがですか。','note.evening':'今日もよくがんばりましたね。','note.night':'そろそろ休みましょうか。',
   'weather.rain':'外は{label}ですよ。傘をお忘れなく。','weather.snow':'雪が降っていますよ。足もとに気をつけてくださいね。','weather.hot':'{t}°まで上がっています。水分をとってくださいね。','weather.cold':'{t}°と冷えていますよ。あたたかくしてくださいね。',
   'back.hello':'おかえりなさい。','back.finished':'留守のあいだに、仕事が{n}終わりましたよ。','back.waiting':'見てほしいことが{n}あります。急ぎではありませんよ。','back.running':'仕事は、あと{n}進めていますよ。','back.quiet':'おかえりなさい。留守のあいだは、静かでしたよ。',
   'waiting':'見てほしいことが、{n}あります。急ぎではありませんよ。','season':'いまは「{kou}」の頃ですよ。'}},
 casual:{name:'くだけた',note:'友だちのように',suffix:'',
  style:'友だちのように、くだけた話し方をする。短く、あたたかく。大事な確認は、ふざけずにはっきり伝える。',
  lines:{'opening.morning':'おはよ。','opening.day':'やあ。','opening.evening':'おつかれ！','opening.night':'まだ起きてたんだ。',
   'note.morning':'よく寝れた？','note.day':'ちょっと休憩しない？','note.evening':'今日はどうだった？','note.night':'そろそろ寝ようよ。',
   'weather.rain':'外、{label}だよ。傘持っていってね。','weather.snow':'雪だよ。足もと気をつけてね。','weather.hot':'{t}°まで上がるよ。水分とってね。','weather.cold':'{t}°と冷えてるよ。あったかくしてね。',
   'back.hello':'おかえり！','back.finished':'留守のあいだに、仕事が{n}終わったよ。','back.waiting':'確認してほしいのが{n}あるよ。','back.running':'仕事は、あと{n}進めてるよ。','back.quiet':'おかえり。留守のあいだ、静かだったよ。',
   'waiting':'ねえ、確認してほしいことが{n}あるんだ。','season':'いまは「{kou}」の頃なんだって。'}},
 terse:{name:'ひとこと',note:'必要なことだけ',suffix:'さん',
  style:'必要なことだけを、一文で伝える。挨拶や感想は添えない。確認が必要なときははっきり言う。',
  lines:{'opening.morning':'おはようございます。','opening.day':'こんにちは。','opening.evening':'おつかれさまです。','opening.night':'遅い時間です。',
   'note.morning':'','note.day':'','note.evening':'','note.night':'',
   'weather.rain':'{label}です。','weather.snow':'雪です。','weather.hot':'{t}°です。','weather.cold':'{t}°です。',
   'back.hello':'','back.finished':'仕事が{n}終わりました。','back.waiting':'確認が{n}あります。','back.running':'仕事が{n}進行中です。','back.quiet':'おかえりなさい。',
   'waiting':'確認待ちが、{n}あります。','season':'「{kou}」。'}},
 night:{name:'しっとり',note:'静かな夜の声',suffix:'さん',
  style:'静かで落ち着いた、少し詩的な話し方をする。急がせず、言葉を選ぶ。確認が必要なときははっきり伝える。',
  lines:{'opening.morning':'朝ですね。','opening.day':'こんにちは。','opening.evening':'灯りをともしましょうか。','opening.night':'静かな夜ですね。',
   'note.morning':'窓の光がやわらかいです。','note.day':'ひとやすみの時間かもしれません。','note.evening':'','note.night':'そろそろ灯りを落としましょう。',
   'weather.rain':'雨の音がしますね。しずかな一日になりそうです。','weather.snow':'雪が降っています。しんとした音がしますね。','weather.hot':'{t}°まで上がっています。日陰で、ひと息どうぞ。','weather.cold':'{t}°と冷えています。温かいものをどうぞ。',
   'back.hello':'おかえりなさい。','back.finished':'留守のあいだに、{n}仕上がりました。','back.waiting':'見ていただきたいことが、{n}ございます。','back.running':'もう少し、{n}進めています。','back.quiet':'おかえりなさい。静かな時間でした。',
   'waiting':'お手すきのときに、見ていただきたいことが{n}。','season':'「{kou}」——そんな頃です。'}}
});
export const VOICE_TONE_IDS=Object.freeze(Object.keys(VOICE_TONES));
/** How often the character speaks up. normal is today's behaviour. */
export const VOICE_PROACTIVE=Object.freeze({
 quiet:{name:'静か',text:'確認が必要なことと、仕事の結果だけ話します。あいさつや天気のひとことは出しません。',style:'こちらから雑談や声かけはしない。'},
 normal:{name:'ふつう',text:'時間帯のあいさつと、雨・暑さ・寒さなど行動が変わる日のひとこと。',style:''},
 chatty:{name:'おしゃべり',text:'あいさつに、季節の話題を添えます。',style:'ときどき、季節や休憩の話題を一言添える。'}
});
export const VOICE_PROACTIVE_IDS=Object.freeze(Object.keys(VOICE_PROACTIVE));
export const VOICE_DEFAULT=Object.freeze({tone:'polite',callName:'',proactive:'normal',lines:Object.freeze({})});
export const defaultVoice=()=>({tone:'polite',callName:'',proactive:'normal',lines:{}});

const voiceClean=(value,max)=>String(value).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);

/** Merge a patch into a voice and check it. `lines` is replaced as a whole (send only the lines that differ from the pack). */
export function validateVoice(raw,previous=VOICE_DEFAULT){
 voiceCheck(voicePlain(raw),'Invalid voice');
 for(const key of Object.keys(raw))voiceCheck(['tone','callName','proactive','lines'].includes(key),`Voice cannot change ${key}`);
 const next={tone:previous.tone,callName:previous.callName,proactive:previous.proactive,lines:{...previous.lines}};
 if(raw.tone!==undefined){voiceCheck(typeof raw.tone==='string'&&Object.hasOwn(VOICE_TONES,raw.tone),'Invalid tone');next.tone=raw.tone;}
 if(raw.callName!==undefined){voiceCheck(typeof raw.callName==='string'&&raw.callName.length<=48,'Invalid call name');next.callName=voiceClean(raw.callName,24);}
 if(raw.proactive!==undefined){voiceCheck(typeof raw.proactive==='string'&&Object.hasOwn(VOICE_PROACTIVE,raw.proactive),'Invalid speaking frequency');next.proactive=raw.proactive;}
 if(raw.lines!==undefined){
  voiceCheck(voicePlain(raw.lines),'Invalid lines');
  const lines={};
  for(const [key,value] of Object.entries(raw.lines)){
   voiceCheck(VOICE_KEYS.includes(key),`Unknown line ${key}`);
   voiceCheck(typeof value==='string'&&value.length<=200,'Lines must be short text');
   lines[key]=voiceClean(value,100);
  }
  next.lines=lines;
 }
 return next;
}

/** Fill a line's values. Only these four are replaced; anything else stays as typed. */
const voiceFill=(text,vars)=>String(text).replace(/\{(n|t|label|kou)\}/g,(m,k)=>vars[k]!==undefined?String(vars[k]):m);
/** One line in this voice: the person's own wording first, then the tone pack. */
export function voiceLine(voice,key,vars={}){
 const tone=VOICE_TONES[voice?.tone]||VOICE_TONES.polite;
 const own=voice?.lines&&Object.hasOwn(voice.lines,key)?voice.lines[key]:undefined;
 return voiceFill(own!==undefined?own:tone.lines[key]??'',vars);
}
/** "ミカさん、" when a call name is set, otherwise nothing. */
export function voiceAddress(voice){
 const name=voiceClean(voice?.callName||'',24);if(!name)return '';
 return `${name}${(VOICE_TONES[voice?.tone]||VOICE_TONES.polite).suffix}、`;
}
/** Does this voice speak this kind of line unprompted? quiet keeps only what needs the person. */
export function voiceSpeaks(voice,kind){
 if(voice?.proactive!=='quiet')return true;
 return ['back','waiting','reply'].includes(kind);
}
/** What the model is told about the voice: enumerations and a call name, never the screen-only lines. */
export function voiceStyleForPrompt(voice){
 const v=voice||VOICE_DEFAULT,tone=VOICE_TONES[v.tone]||VOICE_TONES.polite,pro=VOICE_PROACTIVE[v.proactive]||VOICE_PROACTIVE.normal;
 const out={tone:v.tone,toneStyle:tone.style};
 const name=voiceClean(v.callName||'',24);
 if(name)out.callName=`${name}${tone.suffix}`;
 if(pro.style)out.speakingFrequency=pro.style;
 return out;
}
