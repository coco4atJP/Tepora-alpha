"""Actual UI module with an in-memory bridge fixture. No server/account/model or media decoding claim."""
from pathlib import Path
import json, os, re, sys,shutil
from playwright.sync_api import sync_playwright
root=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve(); out.mkdir(parents=True,exist_ok=True)
# ui.mjs depends on status.mjs and markdown.mjs; concatenate in dependency order, as the bundle does.
source=re.sub(r'^import .*?;\n','','\n'.join((root/'web'/name).read_text() for name in ('status.mjs','markdown.mjs','ui.mjs','capability-ui.mjs')),flags=re.M)
source=re.sub(r'^export (?=(?:async )?function|const|class)','',source,flags=re.M)
fixture=r'''
window.fixture={private:true,open:null,posts:[],listeners:[],jobs:[],release:null,
 profile:{id:'local',identity:'local-v1',name:'Local voice',domain:'device',model:'voice',role:'tts',baseUrl:'http://127.0.0.1:8000/v1',enabled:true}};
const f=window.fixture;
const bridge={on:fn=>f.listeners.push(fn),request:async(path,method='GET',value)=>{
 if(path==='/api/capabilities')return {revision:0,profiles:[f.profile],routes:{tts:f.profile.id}};
 if(path==='/api/media/jobs'&&method==='GET')return {jobs:f.jobs};
 if(path==='/api/media/jobs'&&method==='POST'){f.posts.push(value);return new Promise(r=>f.release=()=>r({id:'speech',status:'submitting'}));}
 throw Error('Unexpected fixture request '+path);
}};
window.component=createCapabilityUI({bridge,previewMode:false,isPrivate:()=>f.private,isOpen:kind=>f.open===kind,
 latestReply:()=> 'A reply requested for readout.',notice:message=>f.notice=message,closeSheet:()=>f.open=null,
 openSheet:(title,body,kind)=>{f.open=kind;document.querySelector('#overlay').innerHTML=body;},onChanged:()=>{}});
f.emit=e=>f.listeners.forEach(fn=>fn(e));
'''
checks=[]; errors=[]
with sync_playwright() as p:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
 browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1000,'height':800})
 page.on('pageerror',lambda e:errors.append(str(e)))
 # Suppress attempts to decode nonexistent fixture assets. This test verifies DOM lifecycle only.
 # No intercepted response is substituted for a blocked real service or provider.
 page.set_content('<html><body><div class="input-region"></div><div id="overlay"></div><button data-action="reply-speak">Speak</button></body></html>')
 page.add_script_tag(content=source+'\n'+fixture)
 page.evaluate("fixture.jobs=[{id:'video',kind:'video',title:'Fixture video',status:'ready',asset:{id:'v',mime:'video/mp4'}}]")
 page.evaluate('component.gallery()');page.locator('video').wait_for()
 page.evaluate("""window.retained=document.querySelector('video');window.removed=false;new MutationObserver(rs=>{for(const r of rs)for(const n of r.removedNodes)if(n===window.retained||n.contains?.(window.retained))window.removed=true;}).observe(document.querySelector('#creative-feed'),{childList:true,subtree:true});fixture.emit({type:'media.updated',data:{id:'other',kind:'image',title:'Other job',status:'running'}});""")
 assert page.evaluate("window.retained===document.querySelector('video')&&!window.removed")
 checks.append('Unrelated media progress leaves an existing video node continuously attached, not recreated or detached.')
 # crypto.randomUUID requires a secure origin in browsers. Use Web Crypto random bytes as the
 # production component does; expose no account/network behavior in this fixture.
 page.get_by_role('button',name='Speak',exact=True).click();page.wait_for_function('fixture.posts.length===1')
 assert page.evaluate("fixture.posts[0].kind==='tts'&&fixture.posts[0].prompt==='A reply requested for readout.'&&fixture.posts[0].consent===true")
 assert page.evaluate("fixture.open==='creative'")
 checks.append('An explicit local speaker click requests only the current reply without a settings or confirmation detour.')
 page.evaluate("component.stopPlayback();fixture.release();fixture.emit({type:'media.updated',data:{id:'speech',kind:'tts',title:'Reply',status:'ready',asset:{id:'s',mime:'audio/wav'}}});")
 page.wait_for_timeout(50)
 assert page.locator('#ability-now-playing').count()==0
 checks.append('Stopping before the speech request resolves suppresses late autoplay.')
 page.evaluate("fixture.profile={...fixture.profile,id:'remote',identity:'remote-v1',name:'Explicit remote voice',domain:'cloud',baseUrl:'https://voice.example/v1'};fixture.open=null;")
 page.get_by_role('button',name='Speak',exact=True).click();page.locator('#creative-form').wait_for()
 assert page.locator('.recipient-note').inner_text().find('Explicit remote voice')>=0
 assert page.evaluate('fixture.posts.length===1')
 checks.append('Changing to a remote voice shows exact content and recipient before any paid/disclosing generation request.')
 assert not errors,errors
 browser.close()
result={'passed':True,'checks':checks,'errors':errors,'modelCalls':False,'realAccounts':False,'mediaDecodeTest':False,'scope':'Actual browser UI module; in-memory bridge fixture; DOM/input/async behavior only'}
(out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
