import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeck,ambientCards,renderPinnedCards} from '../web/ambient.mjs';

function deckFixture(run){
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 let id=0,now=0,writes=0,html='';const timers=new Map(),events={},changes=[];
 globalThis.setTimeout=(callback,delay)=>{const key=++id;timers.set(key,{callback,due:now+delay});return key;};
 globalThis.clearTimeout=key=>timers.delete(key);
 const host={get innerHTML(){return html;},set innerHTML(value){html=value;writes++;},addEventListener(name,callback){events[name]=callback;}};
 const deck=createDeck(host,{interval:8000,onChange:value=>{if(changes.at(-1)!==value)changes.push(value);}});
 const advance=ms=>{now+=ms;for(const [key,timer] of [...timers])if(timer.due<=now){timers.delete(key);timer.callback();}};
 try{run({deck,host,events,advance,changes,writes:()=>writes});}finally{deck.stop();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
}
const cards=()=>[{id:'news',title:'News',html:'unchanged news'},{id:'focus',title:'Focus',html:'25:00'}];

test('per-second data updates do not postpone automatic deck rotation',()=>deckFixture(({deck,advance,changes})=>{
 deck.set(cards());
 for(let second=1;second<=20;second++){advance(1000);deck.set(cards().map(c=>c.id==='focus'?{...c,html:String(1500-second)}:c));}
 assert.deepEqual(changes,['news','focus','news']);
}));
test('updating an offscreen card preserves the displayed card DOM',()=>deckFixture(({deck,writes})=>{
 deck.set(cards());const before=writes();
 deck.set(cards().map(c=>c.id==='focus'?{...c,html:'24:59'}:c));
 assert.equal(writes(),before);
}));
test('hover and keyboard focus pause rotation; leaving resumes it and stop cancels it',()=>deckFixture(({deck,events,advance})=>{
 deck.set(cards());events.pointerenter();advance(9000);assert.equal(deck.current(),'news');
 events.pointerleave();advance(8000);assert.equal(deck.current(),'focus');
 events.focusin();advance(9000);assert.equal(deck.current(),'focus');
 events.focusout({relatedTarget:null});advance(8000);assert.equal(deck.current(),'news');
 deck.stop();deck.set(cards());advance(9000);assert.equal(deck.current(),'news');
}));
test('pointer exit does not resume rotation while keyboard focus remains inside',()=>deckFixture(({deck,events,advance})=>{
 deck.set(cards());events.focusin();events.pointerenter();events.pointerleave();advance(16000);
 assert.equal(deck.current(),'news');events.focusout({relatedTarget:null});advance(8000);assert.equal(deck.current(),'focus');
}));
test('a deck recovers rotation when a second card arrives after an empty or single-card update',()=>deckFixture(({deck,advance})=>{
 deck.set([]);advance(8000);deck.set(cards().slice(0,1));advance(8000);assert.equal(deck.current(),'news');
 deck.set(cards());advance(8000);assert.equal(deck.current(),'focus');
 deck.set([]);advance(16000);assert.equal(deck.current(),null);
}));
test('a pinned generated image uses the display widget ID, not its carousel card ID',()=>{
 const html=renderPinnedCards(ambientCards({widgets:['artifact'],images:[{src:'/synthetic.png',title:'Synthetic'}]}));
 assert.match(html,/data-widget="artifact"/);assert.doesNotMatch(html,/data-widget="photos"/);
});
