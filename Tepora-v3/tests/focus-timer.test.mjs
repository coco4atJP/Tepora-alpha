import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusTimer} from '../web/focus-timer.mjs';

test('repeated renders at the same instant do not consume focus time',()=>{
 let now=1000;const timer=createFocusTimer({now:()=>now});timer.toggle();
 for(let i=0;i<100;i++)timer.tick();
 assert.equal(timer.snapshot().remainingSeconds,1500);
 now+=3200;timer.tick();assert.equal(timer.snapshot().remainingSeconds,1497);
 now+=60000;timer.tick();assert.equal(timer.snapshot().remainingSeconds,1437);
});
test('pause preserves fractional time and resume excludes time spent paused',()=>{
 let now=0;const timer=createFocusTimer({now:()=>now});timer.toggle();now=1250;timer.toggle();
 assert.equal(timer.snapshot().running,false);assert.equal(timer.snapshot().remainingSeconds,1499);
 now=60000;timer.tick();assert.equal(timer.snapshot().remainingSeconds,1499);
 timer.toggle();now+=750;timer.tick();assert.equal(timer.snapshot().remainingSeconds,1498);
});
test('suspended callbacks complete once, stop and prepare a fresh interval without auto-restarting',()=>{
 let now=0;const timer=createFocusTimer({minutes:5,now:()=>now});timer.toggle();now=600000;
 assert.equal(timer.tick(),true);assert.equal(timer.tick(),false);
 assert.deepEqual(timer.snapshot(),{minutes:5,remainingSeconds:300,running:false,completed:1});
 timer.toggle();now+=300000;assert.equal(timer.tick(),true);assert.equal(timer.snapshot().completed,2);
 timer.reset();assert.equal(timer.snapshot().completed,2);
});
test('explicit presets reset the interval and saved preferences do not reset an active timer',()=>{
 let now=0;const timer=createFocusTimer({now:()=>now});timer.toggle();now=10000;timer.sync(45);timer.tick();
 assert.equal(timer.snapshot().minutes,25);assert.equal(timer.snapshot().remainingSeconds,1490);
 timer.toggle();timer.sync(45);assert.equal(timer.snapshot().remainingSeconds,2700);
 timer.setMinutes(15);assert.equal(timer.snapshot().remainingSeconds,900);assert.equal(timer.snapshot().running,false);
 assert.throws(()=>timer.setMinutes(0),/Invalid focus/);assert.throws(()=>timer.setMinutes(91),/Invalid focus/);
});
