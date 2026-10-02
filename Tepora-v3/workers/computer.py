"""Owned Computer Use worker: Playwright browser or an explicitly selected Windows UIA window.
No arbitrary Python execution, inherited user browser profiles, filesystem reads, or auto-installs.
Browser requests are fulfilled by the Node network broker; WebSockets/service workers are denied.
This is not a sandbox for arbitrary native desktop apps. Native actions require online app mode.
"""
import base64
import hashlib
import json
import os
import shutil
import sys
import time
from collections import deque

MAX_WIRE = 6_000_000
pending = deque()
network_counter = 0

def send(message):
    data = json.dumps(message, ensure_ascii=False, allow_nan=False)
    if len(data.encode()) > MAX_WIRE:
        raise ValueError('Worker response exceeds budget')
    sys.stdout.write(data + '\n')
    sys.stdout.flush()

def read_message():
    line = sys.stdin.readline(MAX_WIRE + 1)
    if not line:
        raise EOFError('Parent disconnected')
    if len(line) > MAX_WIRE or not line.endswith('\n'):
        raise ValueError('RPC frame exceeds budget')
    return json.loads(line)

def broker(request):
    global network_counter
    network_counter += 1
    key = 'net_' + str(network_counter)
    send({'id':key, 'method':'network.request', 'params':request})
    while True:
        message = read_message()
        if message.get('id') == key and 'method' not in message:
            if message.get('error'):
                raise ValueError('Network broker refused request')
            return message['result']
        # Parent can send a tool while a browser resource is being fetched; do not lose it.
        if len(pending) >= 8:
            raise ValueError('Worker input queue is full')
        pending.append(message)

def revision(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def browser_path():
    for name in ['chromium','chromium-browser','google-chrome','msedge']:
        p=shutil.which(name)
        if p:return p
    if sys.platform=='win32':
        for env in ['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA']:
            for suffix in ['Microsoft/Edge/Application/msedge.exe','Google/Chrome/Application/chrome.exe']:
                p=os.path.join(os.environ.get(env,''),suffix)
                if os.path.isfile(p):return p
    if sys.platform=='darwin':
        for p in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']:
            if os.path.isfile(p):return p
    return None

class BrowserDriver:
    def __init__(self, options):
        from playwright.sync_api import sync_playwright
        self.pw=self.browser=self.context=None
        self.local_document=bool(options.get('html') is not None)
        self.offline=options.get('mode')!='online' or self.local_document
        self.closed=False
        try:
            self.pw=sync_playwright().start()
            executable=options.get('browserExecutable') or browser_path()
            launch={'headless':options.get('headless',False),'args':['--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--disable-extensions','--js-flags=--max-old-space-size=64']}
            if executable:launch['executable_path']=executable
            self.browser=self.pw.chromium.launch(**launch)
            self.context=self.browser.new_context(viewport={'width':1280,'height':900},service_workers='block',accept_downloads=False)
            self.context.set_default_timeout(5000)
            self.context.set_default_navigation_timeout(20000)
            self.context.route('**/*',self.network)
            if not hasattr(self.context,'route_web_socket'):
                raise RuntimeError('A Playwright version with route_web_socket is required')
            self.context.route_web_socket('**/*',lambda ws:ws.close())
            self.context.set_offline(self.offline)
            self.page=self.context.new_page()
            self.context.on('page',lambda page:page.close() if page!=self.page else None)
            self.page.on('dialog',lambda dialog:dialog.dismiss())
            self.handles={}
            if options.get('html') is not None:
                html=options['html']
                if not isinstance(html,str) or len(html)>500000:raise ValueError('Local document is too large')
                self.page.set_content(html,wait_until='domcontentloaded')
            elif options.get('url'):
                if self.offline:raise ValueError('No external pages in restricted mode')
                self.page.goto(options['url'],wait_until='domcontentloaded')
        except Exception:
            self.close()
            raise
    def network(self,route):
        if self.offline:return route.abort('blockedbyclient')
        req=route.request
        try:
            raw=req.post_data_buffer or b''
            if len(raw)>1024*1024:raise ValueError('Browser request too large')
            result=broker({'url':req.url,'method':req.method,'headers':req.all_headers(),'body':base64.b64encode(raw).decode()})
            route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
        except Exception:route.abort('blockedbyclient')
    def observe(self):
        self.handles={}
        nodes=[]
        handles=self.page.locator('button,input,textarea,select,a[href],[role="button"],[role="checkbox"],[role="combobox"],[contenteditable="true"]').element_handles()[:200]
        for index,handle in enumerate(handles):
            try:
                if not handle.is_visible() or not handle.is_enabled():continue
                info=handle.evaluate('''el=>({role:el.getAttribute('role')||el.tagName.toLowerCase(),name:(el.getAttribute('aria-label')||Array.from(el.labels||[]).map(l=>l.innerText).join(' ')||el.getAttribute('placeholder')||el.innerText||el.getAttribute('title')||'').slice(0,300),type:el.getAttribute('type')||'',value:el.type==='password'?'[protected]':String(el.value||'').slice(0,300),checked:!!el.checked})''')
                identifier='el_'+str(index)
                info['id']=identifier
                info['actions']=['click']
                if info['type']=='password':info['actions']=[]
                elif info['role'] in ('input','textarea') or handle.get_attribute('contenteditable')=='true':info['actions']+=['fill','press']
                elif info['role']=='select':info['actions']+=['select']
                nodes.append(info);self.handles[identifier]=handle
            except Exception:continue
        state={'backend':'browser','title':self.page.title()[:300],'url':self.page.url,'text':self.page.locator('body').inner_text(timeout=5000)[:20000],'nodes':nodes,'scope':'owned browser only; no existing browser profile'}
        state['revision']=revision(state)
        return state
    def act(self,params):
        current=self.observe()
        if params.get('revision')!=current['revision']:raise ValueError('STALE_OBSERVATION: observe before acting')
        target=params.get('target');operation=params.get('operation');node=next((n for n in current['nodes'] if n['id']==target),None)
        if not node or operation not in node['actions']:raise ValueError('Unknown or unsupported target action')
        handle=self.handles[target]
        if operation=='click':handle.click(timeout=5000)
        elif operation=='fill':
            value=params.get('value')
            if not isinstance(value,str) or len(value)>16000:raise ValueError('Invalid input length')
            handle.fill(value,timeout=5000)
        elif operation=='select':handle.select_option(value=str(params.get('value',''))[:1000],timeout=5000)
        elif operation=='press':
            key=params.get('value')
            if key not in ['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End']:raise ValueError('Key is not allowed')
            handle.press(key,timeout=5000)
        return {'acted':True,'observation':self.observe()}
    def screenshot(self):
        image=self.page.screenshot(type='png',mask=[self.page.locator('input[type=password]')],timeout=5000)
        if len(image)>4*1024*1024:raise ValueError('Screenshot exceeds budget')
        return {'mime':'image/png','base64':base64.b64encode(image).decode()}
    def close(self):
        self.closed=True
        for thing in [getattr(self,'context',None),getattr(self,'browser',None)]:
            try:
                if thing:thing.close()
            except Exception:pass
        try:
            if self.pw:self.pw.stop()
        except Exception:pass

def compute(options):
    """JS runs in a disposable browser WebWorker with no network, host bridge or file handles.
    Wall deadline and a separate browser process are enforced; the V8 heap flag is not an OS RSS cap.
    """
    code=options.get('code');data=options.get('input');budget=options.get('timeoutMs',1500)
    if not isinstance(code,str) or not 0<len(code)<=32000 or not isinstance(budget,int) or not 100<=budget<=3000:raise ValueError('Invalid compute program/budget')
    if len(json.dumps(data))>100000:raise ValueError('Compute input exceeds budget')
    driver=BrowserDriver({'html':'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-eval\' \'unsafe-inline\' blob:; worker-src blob:; connect-src \'none\'"><body></body>','headless':True,'mode':'offline','browserExecutable':options.get('browserExecutable')})
    try:
        return driver.page.evaluate(r'''async ({code,input,timeoutMs})=>{
          const program=`self.onmessage=async e=>{try{self.Worker=undefined;self.SharedWorker=undefined;self.importScripts=undefined;const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const result=await (new AsyncFunction('input','"use strict";\\n'+e.data.code))(e.data.input);const payload=JSON.stringify(result===undefined?null:result);if(payload.length>64000)throw Error('Output exceeds budget');self.postMessage({ok:true,json:payload});}catch(err){self.postMessage({ok:false,error:String(err.message||err).slice(0,500)});}}`;
          const url=URL.createObjectURL(new Blob([program],{type:'text/javascript'}));const worker=new Worker(url);
          try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{worker.terminate();reject(Error('Compute deadline reached'));},timeoutMs);
            worker.onmessage=e=>{clearTimeout(timer);const value=e.data;if(value?.ok&&typeof value.json==='string'&&value.json.length<=64000)resolve({result:JSON.parse(value.json),network:false,hostAccess:false});else reject(Error(String(value?.error||'Invalid compute result')));};
            worker.onerror=e=>{clearTimeout(timer);reject(Error('Compute worker failed: '+String(e.message||'unknown').slice(0,300)));};worker.postMessage({code,input});});}
          finally{worker.terminate();URL.revokeObjectURL(url);}
        }''',{'code':code,'input':data,'timeoutMs':budget})
    finally:driver.close()

class WindowsDriver:
    def __init__(self,options):
        if sys.platform!='win32':raise RuntimeError('Windows UIA is available only on Windows')
        from pywinauto import Desktop
        import ctypes
        hwnd=options.get('windowHandle')
        if not isinstance(hwnd,int) or hwnd<=0:raise ValueError('Select a window handle first')
        self.desktop=Desktop(backend='uia');self.root=self.desktop.window(handle=hwnd).wrapper_object();self.hwnd=hwnd
        self.process=self.root.process_id();self.ctypes=ctypes;self.handles={}
    def observe(self):
        if not self.root.is_visible() or self.root.process_id()!=self.process:raise ValueError('Selected window no longer exists')
        nodes=[];self.handles={}
        for index,el in enumerate(self.root.descendants()[:200]):
            try:
                if not el.is_visible() or not el.is_enabled():continue
                role=el.element_info.control_type
                if role not in ('Button','Edit','CheckBox','RadioButton','ComboBox','ListItem','TabItem','MenuItem'):continue
                password=bool(getattr(el.element_info,'is_password',False))
                name=el.window_text()[:300] if not password else '[protected]'
                key='uia_'+str(index);actions=[] if password else ['click']
                if role=='Edit' and not password:actions=['fill']
                nodes.append({'id':key,'role':role,'name':name,'actions':actions});self.handles[key]=el
            except Exception:continue
        state={'backend':'windows-uia','title':self.root.window_text()[:300],'windowHandle':self.hwnd,'processId':self.process,'nodes':nodes,'text':'','scope':'only the explicitly selected native window'}
        state['revision']=revision(state);return state
    def act(self,params):
        state=self.observe()
        if state['revision']!=params.get('revision'):raise ValueError('STALE_OBSERVATION: observe before acting')
        if self.ctypes.windll.user32.GetForegroundWindow()!=self.hwnd:raise ValueError('Human/application took focus; no native action performed')
        node=next((n for n in state['nodes'] if n['id']==params.get('target')),None)
        if not node or params.get('operation') not in node['actions']:raise ValueError('Unsupported native action')
        el=self.handles[node['id']]
        if params['operation']=='fill':
            value=params.get('value');
            if not isinstance(value,str) or len(value)>16000:raise ValueError('Invalid input')
            el.set_edit_text(value)
        else:
            if hasattr(el,'invoke'):el.invoke()
            elif hasattr(el,'select'):el.select()
            elif hasattr(el,'toggle'):el.toggle()
            else:raise ValueError('UIA invoke/select/toggle unavailable; coordinate fallback is not used')
        return {'acted':True,'observation':self.observe()}
    def screenshot(self):
        raise ValueError('Native screenshots are not enabled in this beta; use accessibility observations')
    def close(self):pass

def windows():
    if sys.platform!='win32':raise ValueError('Window picker requires Windows')
    from pywinauto import Desktop
    result=[]
    for w in Desktop(backend='uia').windows():
        try:
            if w.is_visible() and w.window_text():result.append({'handle':w.handle,'title':w.window_text()[:160],'processId':w.process_id()})
        except Exception:pass
    return result[:100]

def main():
    driver=None
    try:
        while True:
            q=pending.popleft() if pending else read_message()
            if not isinstance(q,dict) or 'id' not in q or not isinstance(q.get('method'),str):raise ValueError('Invalid RPC')
            try:
                params=q.get('params') or {};method=q['method']
                if method=='start':
                    if driver:raise ValueError('Session is already started')
                    driver=WindowsDriver(params) if params.get('backend')=='windows-uia' else BrowserDriver(params)
                    value=driver.observe()
                elif method=='windows':value=windows()
                elif method=='compute':value=compute(params)
                elif method=='observe':value=driver.observe()
                elif method=='act':value=driver.act(params)
                elif method=='screenshot':value=driver.screenshot()
                elif method=='close':
                    if driver:driver.close();driver=None
                    value={'closed':True}
                else:raise ValueError('Unsupported worker method')
                send({'id':q['id'],'result':value})
            except Exception as e:
                # Errors are bounded diagnostics, not screenshots, process environments or logs.
                send({'id':q['id'],'error':{'code':-32000,'message':str(e)[:500]}})
    except EOFError:pass
    finally:
        if driver:driver.close()

if __name__=='__main__':main()
