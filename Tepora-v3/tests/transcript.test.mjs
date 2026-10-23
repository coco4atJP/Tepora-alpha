import test from 'node:test';
import assert from 'node:assert/strict';
import {createFramePainter,dialogueTimestamp} from '../web/transcript.mjs';

function frames(){
 let id=0;const pending=new Map();
 return {request:fn=>{pending.set(++id,fn);return id;},cancel:id=>pending.delete(id),count:()=>pending.size,flush(){const callbacks=[...pending.values()];pending.clear();for(const fn of callbacks)fn();}};
}
test('a burst paints the latest stream once; the next frame accepts more output',()=>{
 const clock=frames(),paints=[];let text='';
 const painter=createFramePainter(()=>paints.push(text),clock);
 for(let i=0;i<120;i++){text=`chunk ${i}`;painter.schedule();}
 assert.equal(clock.count(),1);assert.deepEqual(paints,[]);
 clock.flush();assert.deepEqual(paints,['chunk 119']);
 text='next frame';painter.schedule();clock.flush();assert.deepEqual(paints,['chunk 119','next frame']);
});
test('a committed, stopped or hidden conversation cancels its pending draft',()=>{
 const clock=frames();let paints=0;
 const painter=createFramePainter(()=>paints++,clock);
 painter.schedule();painter.cancel();painter.cancel();clock.flush();assert.equal(paints,0);
 painter.schedule();clock.flush();assert.equal(paints,1);
});
test('invalid transcript dates remain inert and valid labels preserve Japanese formatting',()=>{
 assert.deepEqual(dialogueTimestamp('invalid'),{time:null,stamp:'',label:''});
 const value=dialogueTimestamp('2026-10-23T09:00:00Z');
 assert.equal(value.time,Date.parse('2026-10-23T09:00:00Z'));
 assert.match(value.stamp,/\d{2}:\d{2}/);assert.match(value.label,/10月23日/);
});
