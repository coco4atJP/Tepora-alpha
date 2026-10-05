/** The avatar spec, the colours every renderer shares, and the mood→pose contract. Pure, no service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {AVATAR_BODIES,AVATAR_BODY_IDS,AVATAR_DEFAULT,AVATAR_LAMPS,AVATAR_PALETTES,AVATAR_PALETTE_IDS,avatarContrast,avatarNeeds,customAvatarPalette,defaultAvatar,exportAvatar,importAvatarPreset,resolveAvatarColors,validateAvatar} from '../web/avatar/model.mjs';
import {AVATAR_MOODS,POSE_KEYS,companionMood,moodPose} from '../web/avatar/pose.mjs';

const fresh=(body='shiro')=>({...defaultAvatar(body),revision:0});
const refused=(patch,previous,pattern)=>assert.throws(()=>validateAvatar(patch,previous||fresh()),pattern||/./);

test('the default avatar is しろ・改 and every body starts from a spec that checks out',()=>{
 assert.equal(AVATAR_DEFAULT.body,'shiro');assert.equal(AVATAR_DEFAULT.render,'flat');assert.equal(AVATAR_DEFAULT.asset,null);
 for(const id of AVATAR_BODY_IDS){
  const spec=fresh(id),checked=validateAvatar({},spec);
  assert.equal(checked.body,id);assert.deepEqual({...checked,revision:0},spec,`${id} is stable under an empty patch`);
 }
 assert.deepEqual(AVATAR_BODY_IDS,['shiro','andon','ensou','kobako','kitsune','hotaru','kokedama','image','imageset','vrm','mesh']);
 assert.deepEqual(AVATAR_BODIES.filter(b=>b.needs).map(b=>[b.id,b.needs]),[['image','image'],['imageset','imageset'],['vrm','vrm'],['mesh','mesh']]);
});

test('a patch changes only what it names, and every body keeps its own defaults',()=>{
 const a=validateAvatar({palette:'sakura',lamp:{hue:'indigo'},props:{hobby:'cup'},slots:{shape:'mochi'}},fresh());
 assert.equal(a.palette,'sakura');assert.equal(a.lamp.hue,'indigo');assert.equal(a.lamp.shape,'bead');assert.equal(a.props.hobby,'cup');assert.equal(a.props.season,'off');assert.deepEqual(a.slots,{shape:'mochi'});
 assert.equal(defaultAvatar('kitsune').lamp.shape,'flame');assert.equal(defaultAvatar('kokedama').lamp.shape,'bud');assert.equal(defaultAvatar('kokedama').palette,'moss');assert.equal(defaultAvatar('hotaru').face.eyes,'dot');
});

test('switching body keeps what is personal and resets what belongs to the old body',()=>{
 const mine=validateAvatar({palette:'sora',hue:200,lamp:{hue:'plum',shape:'bulb'},props:{season:'auto',hobby:'glasses'},motion:'calm',size:1.2,face:{cheeks:false},slots:{shape:'tall'},parts:{ears:'cat'},face:{eyes:'big',cheeks:false}},fresh());
 const next=validateAvatar({body:'kitsune'},mine);
 assert.equal(next.body,'kitsune');assert.equal(next.palette,'sora','a chosen material carries over');assert.equal(next.lamp.hue,'plum');assert.equal(next.lamp.shape,'bulb','a chosen lamp shape carries over');
 assert.equal(next.props.hobby,'glasses');assert.equal(next.motion,'calm');assert.equal(next.size,1.2);assert.equal(next.face.cheeks,false);
 assert.deepEqual(next.slots,{});assert.equal(next.parts.ears,'none');assert.equal(next.face.eyes,'capsule','body-specific choices start over');
 // an untouched look takes the new body's own defaults
 const plain=validateAvatar({body:'kokedama'},fresh('shiro'));
 assert.equal(plain.palette,'moss');assert.equal(plain.lamp.shape,'bud');assert.equal(plain.face.eyes,'dot');
 // leaving a body that wore a file clears the file; a 'none' lamp does not follow a drawn body
 const worn=validateAvatar({body:'vrm',asset:'11111111-1111-4111-8111-111111111111',lamp:{shape:'none'}},fresh());
 const back=validateAvatar({body:'shiro'},worn);assert.equal(back.asset,null);assert.notEqual(back.lamp.shape,'none');
});

test('the colour of waiting for you, free text, markup and permissions cannot be put in a spec',()=>{
 refused({lamp:{hue:'amber'}},null,/lamp colour/);refused({lamp:{hue:'#e2a12a'}},null,/lamp colour/);
 refused({lamp:{shape:'none'}},null,/lamp shape/);   // drawn bodies always have their lamp
 assert.doesNotThrow(()=>validateAvatar({body:'vrm',lamp:{shape:'none'}},fresh()));
 for(const key of ['onclick','endpoint','permissions','allowCloud','url','style','html','capabilities','revision','schema'])refused({[key]:'x'},null,/cannot change/);
 refused({lamp:{onclick:'x'}},null,/cannot change/);refused({face:{src:'x'}},null,/cannot change/);refused({slots:{payload:'<script>'}},null,/no payload/);
 refused(JSON.parse('{"__proto__":{"polluted":true}}'),null,/cannot change/);refused({slots:JSON.parse('{"__proto__":"x"}')},null,/no __proto__/);
 refused({palette:'url(javascript:alert(1))'},null,/palette/);refused({hue:361},null,/hue/);refused({hue:'30'},null,/hue/);refused({hue:NaN},null,/hue/);
 refused({size:0.5},null,/size/);refused({size:2},null,/size/);refused({size:'1'},null,/size/);refused({size:Infinity},null,/size/);
 refused({motion:'wild'},null,/motion/);refused({face:{eyes:'laser'}},null,/eyes/);refused({face:{cheeks:'yes'}},null,/face/);refused({props:{season:'../../etc'}},null,/season/);
 refused({slots:{shape:'cube'}},null,/shape/);refused({body:'door'},null,/body/);refused({body:7},null,/body/);refused('shiro',null,/Invalid/);refused([],null,/Invalid/);refused(null,null,/Invalid/);
 refused({lamp:'vermilion'},null,/lamp/);refused({slots:[]},null,/slots/);
});

test('ears belong to bodies that have ears; files belong to bodies that wear them',()=>{
 assert.equal(validateAvatar({parts:{ears:'rabbit'}},fresh('shiro')).parts.ears,'rabbit');
 refused({parts:{ears:'cat'}},fresh('ensou'),/ears/);
 refused({asset:'11111111-1111-4111-8111-111111111111'},fresh('shiro'),/uploaded file/);
 refused({body:'vrm',asset:'../../secret'},fresh(),/asset/);refused({body:'vrm',asset:'x'.repeat(36)},fresh(),/asset/);refused({body:'vrm',asset:{id:1}},fresh(),/asset/);
 assert.equal(validateAvatar({body:'vrm',asset:'11111111-1111-4111-8111-111111111111'},fresh()).asset,'11111111-1111-4111-8111-111111111111');
 assert.equal(avatarNeeds(fresh('vrm')),'vrm');assert.equal(avatarNeeds(fresh('shiro')),null);
 refused({render:'solid'},fresh('andon'),/render/);
 assert.equal(validateAvatar({render:'solid'},fresh('shiro')).render,'solid');assert.equal(validateAvatar({body:'andon'},{...fresh('shiro'),render:'solid'}).render,'flat');
});

test('a preset carries the look and nothing else',()=>{
 const spec={...validateAvatar({palette:'sakura',props:{hobby:'cup'}},fresh()),revision:9};
 const out=exportAvatar(spec);assert.equal(out.format,'tepora-avatar');assert.equal(out.version,1);
 assert.ok(!('asset' in out.settings)&&!('revision' in out.settings)&&!('schema' in out.settings));
 const back=validateAvatar(importAvatarPreset(JSON.parse(JSON.stringify(out))),fresh());assert.equal(back.palette,'sakura');assert.equal(back.props.hobby,'cup');
 assert.throws(()=>importAvatarPreset({format:'tepora-avatar',version:1,settings:{},capabilities:{}}),/capabilities/);
 assert.throws(()=>importAvatarPreset({format:'tepora-display',version:1,settings:{}}),/Unsupported/);
 assert.throws(()=>importAvatarPreset({format:'tepora-avatar',version:2,settings:{}}),/Unsupported/);
 assert.throws(()=>importAvatarPreset({format:'tepora-avatar',version:1,settings:{asset:'11111111-1111-4111-8111-111111111111'}}),/uploaded file/);
});

test('every material keeps the face readable, and the lamp is never the colour of waiting',()=>{
 const amber='#e2a12a';
 const hue=hex=>{const n=parseInt(hex.slice(1),16),[r,g,b]=[n>>16&255,n>>8&255,n&255].map(v=>v/255),mx=Math.max(r,g,b),d=mx-Math.min(r,g,b);if(!d)return 0;const h=mx===r?((g-b)/d)%6:mx===g?(b-r)/d+2:(r-g)/d+4;return (h*60+360)%360;};
 for(const id of AVATAR_PALETTE_IDS){
  for(const theme of ['light','dark','lamp']){
   const c=resolveAvatarColors({...fresh(),palette:id,hue:30},theme);
   assert.ok(avatarContrast(c.ink,c.body)>=4.5,`${id}/${theme}: eyes read on the body`);
  }
 }
 for(let h=0;h<=360;h+=10){const p=customAvatarPalette(h);assert.ok(avatarContrast(p.ink,p.body)>=7,`custom ${h}`);assert.ok(avatarContrast(p.ink,p.shade)>=4.5,`custom shade ${h}`);}
 for(const [name,lamp] of Object.entries(AVATAR_LAMPS)){
  if(name==='snow')continue;   // a warm white: it has no hue to confuse with amber
  const d=Math.abs(hue(lamp.day)-hue(amber)),gap=Math.min(d,360-d);assert.ok(gap>=25,`${name} is ${gap.toFixed(0)}° from amber`);
 }
 assert.ok(!('amber' in AVATAR_LAMPS)&&!('gold' in AVATAR_LAMPS));
 assert.equal(Object.keys(AVATAR_PALETTES).length,8);
 const night=resolveAvatarColors({...fresh(),lamp:{hue:'indigo',shape:'bead'}},'lamp'),day=resolveAvatarColors({...fresh(),lamp:{hue:'indigo',shape:'bead'}},'light');
 assert.notEqual(night.lamp,day.lamp,'the lamp is lighter on a dark ground');assert.equal(night.lampRgb,day.lampRgb);
});

test('every mood becomes the same small pose vector for any body',()=>{
 assert.deepEqual([...AVATAR_MOODS],['idle','listening','thinking','talking','happy','attention','concerned','sleepy']);
 for(const mood of AVATAR_MOODS){
  const p=moodPose(mood);assert.deepEqual(Object.keys(p).sort(),[...POSE_KEYS].sort());
  for(const k of POSE_KEYS){assert.ok(Number.isFinite(p[k]));assert.ok(p[k]<=1&&p[k]>=(k==='valence'?-1:0),`${mood}.${k}`);}
 }
 assert.deepEqual(moodPose('nothing'),moodPose('idle'));
 assert.ok(moodPose('talking',.9).speech>moodPose('talking',0).speech);assert.equal(moodPose('idle',1).speech,0,'only talking speaks');
 assert.ok(moodPose('happy').valence>0&&moodPose('concerned').valence<0);assert.ok(moodPose('sleepy').energy<moodPose('idle').energy);
});

test('the mood follows what is really happening, in a fixed order of importance',()=>{
 assert.equal(companionMood(),'idle');
 assert.equal(companionMood({talking:true,recording:true,sending:true}),'talking');
 assert.equal(companionMood({recording:true,sending:true}),'listening');
 assert.equal(companionMood({sending:true,celebrate:true}),'thinking');assert.equal(companionMood({awaitingReply:true}),'thinking');
 assert.equal(companionMood({celebrate:true,typing:true,failures:1}),'happy');
 assert.equal(companionMood({typing:true,failures:1}),'listening');
 assert.equal(companionMood({failures:2,attention:1}),'concerned');
 assert.equal(companionMood({attention:1,sleepy:true}),'attention');
 assert.equal(companionMood({sleepy:true}),'sleepy');
});
