import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createDeck} from '../web/ambient.mjs';
import {renderMarkdown} from '../web/markdown.mjs';
import {AVATAR_BODY_KITSUNE} from '../web/avatar/body-kitsune.mjs';
import {defaultAvatar,validateAvatar} from '../web/avatar/model.mjs';
import {part} from './helpers/dialogue-ui-fixture.mjs';

function deckFixture(){
 let html='',writes=0;
 const host={addEventListener(){},get innerHTML(){return html;},set innerHTML(value){html=value;writes++;}};
 const changes=[],deck=createDeck(host,{reducedMotion:true,onChange:id=>changes.push(id)});
 return {deck,host,changes,writes:()=>writes};
}
const card=(id,title=id,html='<p>見出し</p>')=>({id,title,html});
test('unchanged deck snapshots preserve the card DOM, but changed content and ordering repaint',()=>{
 const f=deckFixture();f.deck.set([card('news'),card('photos')]);assert.equal(f.writes(),1);
 f.deck.set([card('news'),card('photos')]);assert.equal(f.writes(),1);
 f.deck.set([card('news','更新したニュース'),card('photos')]);assert.equal(f.writes(),2);assert.match(f.host.innerHTML,/更新したニュース/);
 f.deck.set([card('photos'),card('news','更新したニュース')]);assert.equal(f.deck.current(),'news');assert.equal(f.writes(),3);
 f.deck.next();assert.equal(f.deck.current(),'photos');assert.equal(f.writes(),4);
 f.deck.set([]);assert.equal(f.host.innerHTML,'');assert.equal(f.changes.at(-1),null);
 f.deck.set([]);assert.equal(f.writes(),5);
 f.deck.set([card('news')]);assert.equal(f.writes(),6);
 f.deck.stop();
});

function speechFixture(){
 let html='',writes=0,clipped=false,narrow=false;
 const body={scrollHeight:90,clientHeight:100};
 const el={hidden:true,dataset:{},classList:{toggle(name,on){if(name==='is-clipped')clipped=on;}},querySelector:()=>body,
  get innerHTML(){return html;},set innerHTML(value){html=value;writes++;}};
 const state={dialogue:{messages:[{role:'assistant',at:new Date().toISOString(),content:'幅が変わっても、同じ会話を表示します。'}]}};
 const ctx=vm.createContext({state,$:()=>el,sharedView:false,widgetsVisible:()=>['companion'],talkOpen:false,narrow:()=>narrow,ambientMode:false,backdropNow:()=> 'room',inboxList:()=>[],characterVoice:()=>({}),recapUntil:0,characterName:()=> 'Tepora',renderMarkdown,Date});
 vm.runInContext(part('function paintSpeech(){','/** Below the stage:'),ctx);
 return {body,el,ctx,paint:()=>vm.runInContext('paintSpeech()',ctx),writes:()=>writes,clipped:()=>clipped,setNarrow:value=>{narrow=value;}};
}
test('cached speech preserves its DOM but recomputes clipping in both directions after layout changes',()=>{
 const f=speechFixture();f.paint();assert.equal(f.writes(),1);assert.equal(f.clipped(),false);
 f.body.scrollHeight=180;f.paint();assert.equal(f.writes(),1);assert.equal(f.clipped(),true);
 f.body.scrollHeight=80;f.paint();assert.equal(f.writes(),1);assert.equal(f.clipped(),false);
 f.setNarrow(true);f.paint();assert.equal(f.writes(),2);assert.match(f.el.innerHTML,/data-action="view"/);
});
test('hidden speech can return without retaining an invalid cache key',()=>{
 const f=speechFixture();f.paint();f.ctx.sharedView=true;f.paint();assert.equal(f.el.hidden,true);
 f.ctx.sharedView=false;f.paint();assert.equal(f.el.hidden,false);assert.equal(f.writes(),2);
});
test('the kitsune renderer follows the validated earLength slot from the avatar studio',()=>{
 const base=defaultAvatar('kitsune'),standard=validateAvatar({slots:{earLength:'std'}},base),long=validateAvatar({slots:{earLength:'long'}},base);
 const render=spec=>AVATAR_BODY_KITSUNE.svg(spec,'ear-fixture');
 assert.notEqual(render(standard),render(long));
 assert.equal((render(long).match(/scale\(\.96 1\.22\)/g)||[]).length,2,'both ears use the long shape');
 assert.doesNotMatch(render(standard),/scale\(\.96 1\.22\)/);
});
