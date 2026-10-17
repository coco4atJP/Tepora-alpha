import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Display} from '../core/display.mjs';
import {AMBIENT_DEFAULT,DISPLAY_DEFAULT,MONITOR_DEFAULT,monitorConfig} from '../web/display-model.mjs';

function fixture(initial={}){
 const values=structuredClone(initial),events=[];
 const store={
  value(key,value){
   if(arguments.length>1)values[key]=structuredClone(value);
   return structuredClone(values[key]??null);
  },
  emit(type,data){events.push({type,data:structuredClone(data)});}
 };
 return {display:new Display(store),values,events};
}
const atRevision=(settings,revision)=>({...structuredClone(settings),revision});
const customized={
 theme:'dark',textScale:1.4,widgets:['focus','schedule','memo','system'],hiddenUntil:{memo:'2030-01-01T00:00:00Z'},
 ambient:{...AMBIENT_DEFAULT,idleMinutes:30,rotateSeconds:60,nightDim:false,wallpaper:'stars',keepAwake:true,
  frameSeconds:300,frameShuffle:false,frameFit:'mat',frameMotion:false,frameClock:'large',frameCreated:false},
 scene:'work',layout:'dashboard-bento',clockStyle:'mono',clockSize:'hero',clockSeconds:true,
 pinnedWidgets:['focus','work','schedule','system'],weatherMode:'always',workCard:true,focusMinutes:90,pinnedNote:'レビューする'
};

test('display defaults contain every monitor preference and exactly match the native host',async()=>{
 const expected={scene:'standard',layout:'companion-split',clockStyle:'editorial',clockSize:'medium',clockSeconds:false,
  pinnedWidgets:[],weatherMode:'notable',workCard:false,focusMinutes:25,pinnedNote:''};
 assert.deepEqual(MONITOR_DEFAULT,expected);
 for(const [key,value] of Object.entries(expected)){
  assert.ok(Object.hasOwn(DISPLAY_DEFAULT,key),key);
  assert.deepEqual(DISPLAY_DEFAULT[key],value,key);
 }
 assert.deepEqual(monitorConfig(DISPLAY_DEFAULT),expected);
 const native=JSON.parse(await readFile(new URL('../native-service/src/workspace/display_avatar/constants.json',import.meta.url),'utf8'));
 assert.deepEqual(native.displayDefault,DISPLAY_DEFAULT);
});

test('reset restores all display and monitor defaults, checks revisions, records history and can be undone',()=>{
 const {display,values,events}=fixture();
 const original=display.get(),changed=display.change(customized,0);
 assert.equal(changed.revision,1);
 const before=structuredClone({values,events});
 assert.throws(()=>display.reset(0),error=>error.status===409);
 assert.deepEqual({values,events},before);
 const reset=display.reset(1);
 assert.deepEqual(reset,atRevision(DISPLAY_DEFAULT,2));
 assert.deepEqual(values.display,reset);
 assert.deepEqual(values['display-history'],[original,changed]);
 assert.deepEqual(events,[{type:'display.updated',data:changed},{type:'display.updated',data:reset}]);
 const undone=display.undo(2);
 assert.deepEqual(undone,atRevision(changed,3));
 assert.deepEqual(values['display-history'],[original]);
 assert.deepEqual(events.at(-1),{type:'display.updated',data:undone});
 assert.deepEqual(DISPLAY_DEFAULT.pinnedWidgets,[]);
 assert.deepEqual(MONITOR_DEFAULT.pinnedWidgets,[]);
});

test('legacy preferences stay readable and editable, and reset undo restores their exact saved shape',()=>{
 const legacy={schema:1,revision:7,theme:'light',textScale:1.2,widgets:['work'],hiddenUntil:{},
  ambient:{idleMinutes:10,rotateSeconds:20,nightDim:false}};
 const {display,values}=fixture({display:legacy});
 assert.deepEqual(display.get(),legacy);
 assert.deepEqual(monitorConfig(display.get()),MONITOR_DEFAULT);
 const edited=display.change({theme:'dark'},7);
 assert.deepEqual(edited.ambient,{...AMBIENT_DEFAULT,...legacy.ambient});
 for(const key of Object.keys(MONITOR_DEFAULT))assert.ok(!Object.hasOwn(edited,key),key);
 assert.deepEqual(display.reset(8),atRevision(DISPLAY_DEFAULT,9));
 assert.deepEqual(display.undo(9),atRevision(edited,10));
 assert.deepEqual(display.undo(10),atRevision(legacy,11));
 assert.deepEqual(values['display-history'],[]);
});

test('repeated resets keep the same bounded revision history as other display changes',()=>{
 const {display,values}=fixture();
 for(let revision=0;revision<23;revision++)assert.deepEqual(display.reset(revision),atRevision(DISPLAY_DEFAULT,revision+1));
 assert.deepEqual(values['display-history'],Array.from({length:20},(_,i)=>atRevision(DISPLAY_DEFAULT,i+3)));
 assert.deepEqual(display.undo(23),atRevision(DISPLAY_DEFAULT,24));
 assert.equal(values['display-history'].length,19);
});
