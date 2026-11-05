/** X11 + AT-SPI end-to-end smoke test: the computer tool drives gtk-fixture through Desktop and the real
 * tepora-desktop-helper. Run through run-x11-smoke.sh, which provides Xvfb, the accessibility bus and the app. */
import assert from 'node:assert/strict';
import {Desktop} from '../../core/computer/desktop.mjs';
import {computerTool,COMPUTER_DEFAULT} from '../../core/computer/index.mjs';
const desktop=new Desktop({binDir:process.env.TMPDIR||'/tmp',command:process.argv[2]?[process.argv[2]]:null});
desktop.settle=()=>new Promise(r=>setTimeout(r,300));
const tool=computerTool({config:()=>({...COMPUTER_DEFAULT}),desktopClient:()=>desktop,chooser:()=>null});
const run=a=>tool.run({target:'desktop',...a},{session:{id:'x11-smoke'}});
const row=(text,re)=>text.split('\n').find(l=>re.test(l))||'';
try{
 const status=await desktop.status();
 assert.deepEqual([status.backend,status.accessibility,status.input,status.capture,status.problem],['linux-x11',true,true,true,null]);
 assert.match((await run({action:'windows'})).text,/"Tepora Test"/);
 const o=(await run({action:'observe',app:'gtk-fixture'})).text;
 for(const re of [/ button "Press me"/,/ textbox /,/ password .*value="••••"/,/ checkbox "Remember" \[unchecked\]/,/ combobox "One"/,/Ready/])assert.match(o,re);
 assert.doesNotMatch(o,/hunter2/,'password values are never read');
 const ref=re=>row(o,re).split(' ')[0];
 const [entry,check,combo,button]=[/ textbox /,/ checkbox /,/ combobox /,/ button "Press me"/].map(ref);
 assert.match(row((await run({action:'type',ref:entry,text:'via AT-SPI'})).text,new RegExp('^(?:[~+] )?'+entry+' ')),/value="via AT-SPI"/);
 assert.match(row((await run({action:'click',ref:check})).text,new RegExp('^(?:[~+] )?'+check+' ')),/\[checked\]/);
 assert.match(row((await run({action:'select',ref:combo,option:'Three'})).text,new RegExp('^(?:[~+] )?'+combo+' ')),/value="Three"/);
 assert.match((await run({action:'click',ref:button})).text,/Clicked 1/);
 // XTest: select all in the focused entry and type over it, including a character with no keycode.
 await run({action:'click',ref:entry});await run({action:'key',keys:'Mod+A'});
 assert.match(row((await run({action:'type',text:'Typed ü!'})).text,new RegExp('^(?:[~+] )?'+entry+' ')),/value="Typed ü!"/);
 // Action results show what changed; horizontal scroll and drag reach XTest.
 await run({action:'scroll',dx:120});await run({action:'drag',x:20,y:20,to_x:60,to_y:20});
 const shot=await run({action:'screenshot'});
 assert.equal(shot.images[0].mime,'image/jpeg');assert.ok(shot.images[0].base64.length>1000);
 console.log('X11 AT-SPI smoke test passed.');
}finally{desktop.close();}
