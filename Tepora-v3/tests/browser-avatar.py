"""The avatar on the real service: しろ・改 by default, the studio (bodies, materials, lamp, undo, presets), the solid 3D
body, and bringing a character you already have: a VRM, a mesh-avatar-studio project, one picture, a set of pictures.
The things brought are made by tests/fixtures/avatar-fixtures.mjs (nobody's artwork). WebGL parts are skipped, and
reported as skipped, when this browser has no WebGL. No AI is used."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,os,shutil,subprocess,sys,tempfile
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];bad=[];skipped=[]
fixtures=out/'fixtures'
subprocess.run(['node','tests/fixtures/avatar-fixtures.mjs',str(fixtures)],cwd=root,check=True,stdout=subprocess.DEVNULL)
data=tempfile.mkdtemp(prefix='tepora-avatar-ui-')
service=subprocess.Popen(['node','core/server.mjs'],cwd=root,env={**os.environ,'TEPORA_DATA_DIR':data},stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
 ready=json.loads(service.stdout.readline())
 with sync_playwright() as pw:
  executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
  browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
  context=browser.new_context(viewport={'width':1280,'height':860},color_scheme='light',timezone_id='Asia/Tokyo',accept_downloads=True)
  page=context.new_page();page.set_default_timeout(9000)
  # engine notes that are expected: a mesh project without eye/mouth sprites says so once, and the GL driver chats
  page.on('console',lambda m:errors.append(m.text[:200]) if m.type in ('error','warning') and 'GL Driver' not in m.text and 'sprites not loaded' not in m.text else None)
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('response',lambda r:bad.append(f'{r.status} {r.url}') if r.status>=400 else None)
  page.goto(ready['url'],wait_until='domcontentloaded');page.locator('#clock-display').wait_for()
  page.get_by_role('button',name='今は時計として使う',exact=True).wait_for(timeout=8000);page.get_by_role('button',name='今は時計として使う',exact=True).click()
  page.locator('.modal-backdrop').wait_for(state='detached')
  webgl=page.evaluate("!!document.createElement('canvas').getContext('webgl2')")
  def api(path,method='GET',body=None):
   return page.evaluate("""async([p,m,b])=>{const boot=await (await fetch('/api/bootstrap')).json();const r=await fetch(p,{method:m,headers:{'Content-Type':'application/json','X-Tepora-CSRF':boot.csrf},body:b?JSON.stringify(b):undefined});return {status:r.status,body:await r.json().catch(()=>null)};}""",[path,method,body])
  avatar=lambda:api('/api/avatar')['body']
  def settle(ms=900):page.wait_for_timeout(ms)
  def studio():
   page.locator('.nav [data-view=settings]').click();page.get_by_role('button',name='姿を作る',exact=True).first.click();page.locator('#avatar-sheet').wait_for();settle(500)
  def home():
   if page.locator('.modal-backdrop').count():page.keyboard.press('Escape');page.locator('.modal-backdrop').wait_for(state='detached')
   page.locator('.nav [data-view=home]').click();settle(600)
  def chip(key,value):page.locator(f'#av-controls [data-action=av-set][data-key="{key}"][data-value="{value}"]').click();settle(500)
  def bring(kind,files):
   with page.expect_file_chooser() as chooser:page.locator(f'[data-action=av-add][data-kind={kind}]').click()
   chooser.value.set_files(files);settle(1800)
  # --- the default: しろ・改, drawn flat, and the persona is a separate thing
  home();page.screenshot(path=str(out/'01-home.png'))
  start=avatar()
  assert start['body']=='shiro' and start['render']=='flat' and start['asset'] is None and start['revision']==0,start
  assert page.locator('.character-host svg.cx.cx-shiro').count()==1
  assert page.locator('#av-preview').count()==0
  checks.append('the avatar starts as しろ・改, drawn flat, with no file')
  # --- the studio: bodies, materials, the lamp, undo and reset
  studio();page.screenshot(path=str(out/'02-studio.png'))
  assert page.locator('#av-preview svg.cx-shiro').count()==1
  for mood in ['happy','sleepy','thinking']:
   page.locator(f'[data-action=av-mood][data-value={mood}]').click()
   assert page.locator(f'#av-preview svg[data-mood={mood}]').count()==1,mood
  page.locator('[data-action=av-mood][data-value=idle]').click()
  for body in ['shiro','andon','ensou','kobako','kitsune','hotaru','kokedama']:
   chip('body',body);assert avatar()['body']==body and page.locator(f'#av-preview svg.cx-{body}').count()==1,body
   for mood in ['idle','listening','thinking','talking','happy','attention','concerned','sleepy']:
    page.locator(f'[data-action=av-mood][data-value={mood}]').click();assert page.locator(f'#av-preview svg.cx-{body}[data-mood={mood}]').count()==1,(body,mood)
   assert page.locator('#av-preview svg path[d*=NaN],#av-preview svg [transform*=NaN]').count()==0,f'{body} draws no NaN'
  page.locator('[data-action=av-mood][data-value=idle]').click()
  chip('body','shiro')
  chip('palette','sakura');chip('lamp.hue','indigo');chip('face.eyes','big');chip('parts.ears','rabbit');chip('props.hobby','glasses');chip('slot.shape','mochi')
  spec=avatar()
  assert spec['palette']=='sakura' and spec['lamp']['hue']=='indigo' and spec['face']['eyes']=='big' and spec['parts']['ears']=='rabbit' and spec['props']['hobby']=='glasses' and spec['slots']['shape']=='mochi',spec
  assert page.locator('#av-controls .av-sw.is-locked[disabled]').count()==1,'amber is shown but cannot be chosen'
  assert page.locator('#av-controls [data-key="lamp.hue"][data-value=amber]').count()==0
  page.screenshot(path=str(out/'03-customised.png'))
  before=avatar()['revision'];page.locator('[data-action=av-undo]').click();settle(500)
  assert avatar()['slots'].get('shape')!='mochi' and avatar()['revision']>before,'undo is a new revision that restores the previous look'
  page.locator('[data-action=av-dice]').click();settle(600);assert avatar()['body'] in ['shiro','andon','ensou','kobako','kitsune','hotaru','kokedama']
  page.locator('[data-action=av-reset]').click();settle(500);assert avatar()['body']=='shiro' and avatar()['palette']=='washi'
  checks.append('studio: all seven drawn bodies show every mood, every chip is saved at once, amber is locked, undo, dice and reset work')
  # --- a preset leaves the PC as plain text and comes back
  chip('palette','felt');chip('lamp.hue','matcha')
  with page.expect_download() as download:page.locator('[data-action=av-export]').click()
  exported=json.loads(Path(download.value.path()).read_text())
  assert exported['format']=='tepora-avatar' and exported['settings']['palette']=='felt' and 'asset' not in exported['settings'] and 'revision' not in exported['settings'],exported
  page.locator('[data-action=av-reset]').click();settle(500)
  preset=out/'preset.json';preset.write_text(json.dumps(exported))
  with page.expect_file_chooser() as chooser:page.locator('[data-action=av-import]').click()
  chooser.value.set_files(str(preset));settle(800)
  assert avatar()['palette']=='felt' and avatar()['lamp']['hue']=='matcha'
  checks.append('a preset is exported without files or revisions, and imported back as the same look')
  page.locator('[data-action=av-reset]').click();settle(400)
  # --- the persona (words) and the avatar (looks) are saved apart
  page.keyboard.press('Escape');page.locator('.modal-backdrop').wait_for(state='detached')
  look=avatar()['revision']
  page.locator('.nav [data-view=settings]').click();page.get_by_role('button',name='人格と口調を編集',exact=True).click();page.locator('#personas-form').wait_for()
  page.locator('[name=voiceTone]').select_option('casual');page.locator('[name=voiceCallName]').fill('ミカ')
  page.get_by_role('button',name='人格を保存する',exact=True).click();page.locator('#personas-form').wait_for(state='detached')
  personas=api('/api/dialogue/personas')['body']
  assert personas['character']['voice']['tone']=='casual' and personas['character']['voice']['callName']=='ミカ',personas['character']
  assert avatar()['revision']==look,'changing how it speaks does not touch how it looks'
  checks.append('persona and avatar are separate: the tone and call name are saved without a new avatar revision')
  # --- the solid body (3D)
  if webgl:
   studio();chip('render','solid');settle(1500)
   assert page.locator('#av-preview canvas.solid-canvas').count()==1 and avatar()['render']=='solid'
   for mood in ['talking','happy','attention','concerned','sleepy']:
    page.locator(f'[data-action=av-mood][data-value={mood}]').click();settle(400)
   chip('props.hobby','headphones');chip('parts.ears','cat');chip('lamp.shape','flame')
   page.screenshot(path=str(out/'04-solid-studio.png'))
   home();settle(1200)
   assert page.locator('.character-host canvas.solid-canvas').count()==1
   page.screenshot(path=str(out/'05-solid-home.png'))
   page.emulate_media(color_scheme='dark');settle(900);page.screenshot(path=str(out/'06-solid-dark.png'));page.emulate_media(color_scheme='light')
   checks.append('solid: the same spec drawn in 3D, every mood, dark theme, with the lamp as a real light')
  else:skipped.append('solid body: this browser has no WebGL')
  # --- what a person already has: a VRM, a mesh avatar, a picture, a set of pictures
  studio()
  bring('vrm',str(fixtures/'test.vrm'))
  assert avatar()['body']=='vrm' and avatar()['asset'],avatar()
  assert 'テスト用ヒューマノイド' in page.locator('#av-library').inner_text() and 'VRM 1.0' in page.locator('#av-library').inner_text()
  if webgl:
   assert page.locator('#av-preview canvas.vrm-canvas').count()==1
   page.locator('[data-action=av-mood][data-value=talking]').click();settle(500);page.screenshot(path=str(out/'07-vrm.png'))
   checks.append('VRM: loaded from this PC, drawn with the same mood pose, the lamp stays beside it')
  else:skipped.append('VRM: this browser has no WebGL')
  bring('mesh',str(fixtures/'mesh-project'))
  assert avatar()['body']=='mesh',avatar()
  if webgl:
   assert page.locator('#av-preview canvas.mesh-canvas').count()==1
   for mood in ['talking','happy','sleepy']:
    page.locator(f'[data-action=av-mood][data-value={mood}]').click();settle(700)
   page.screenshot(path=str(out/'08-mesh.png'))
   home();settle(1500);assert page.locator('.character-host canvas.mesh-canvas').count()==1;page.screenshot(path=str(out/'09-mesh-home.png'));studio()
   checks.append('mesh-avatar-studio project: moved by the pinned engine, mood becomes face, lips and gaze')
  else:skipped.append('mesh avatar: this browser has no WebGL')
  bring('image',str(fixtures/'picture.png'))
  assert avatar()['body']=='image' and page.locator('#av-preview svg.cx-image image.pic').count()==1
  with page.expect_file_chooser() as chooser:page.locator('[data-action=av-add][data-kind=imageset]').click()
  chooser.value.set_files([str(fixtures/'imageset'/n) for n in ['idle.png','happy.png','talk-open.png']]);settle(600)
  assert page.evaluate("[...document.querySelectorAll('[data-action=av-draft-mood]')].map(s=>s.value)")==['idle','happy','talkOpen'],'moods are guessed from the file names'
  page.locator('[data-action=av-draft-go]').click();settle(1500)
  assert avatar()['body']=='imageset' and page.locator('#av-preview svg.cx-image image.pic').count()==3
  page.locator('[data-action=av-mood][data-value=happy]').click();settle(500)
  assert page.locator('#av-preview image.pic[data-pic=happy]').get_attribute('visibility')=='visible'
  page.screenshot(path=str(out/'10-imageset.png'))
  checks.append('a picture and a set of pictures: the mood picks the picture, talking opens the mouth picture')
  # --- the library: files are kept, wearing one is a choice, removing the one in use puts the default back
  assert page.locator('#av-library .av-asset').count()>=3
  gone=page.locator('.av-asset.is-on [data-action=av-remove]');gone.click();settle(900)
  assert avatar()['body']=='shiro' and avatar()['asset'] is None,'removing the file in use returns to しろ・改'
  checks.append('removing the file in use returns the avatar to しろ・改')
  # --- reduced motion follows the OS setting, live
  page.keyboard.press('Escape');page.locator('.modal-backdrop').wait_for(state='detached');home()
  page.emulate_media(reduced_motion='reduce');settle(600)
  api('/api/avatar','PATCH',{'patch':{'palette':'moss'},'expectedRevision':avatar()['revision']});settle(1200)
  assert page.locator('.character-host svg.cx-shiro.cx-still').count()==1,'a body drawn while reduced motion is on is still'
  page.emulate_media(reduced_motion='no-preference');settle(500)
  checks.append('reduced motion: the figure holds still and follows the setting while the page is open')
  # --- a narrow phone: the studio keeps the preview in view and does not overflow
  page.set_viewport_size({'width':390,'height':800});studio();settle(500)
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
  page.evaluate("document.querySelector('.modal-body').scrollTop=600");settle(300)
  top=page.locator('#av-preview').bounding_box()['y']
  assert top<200,f'the preview stays in view while the choices scroll ({top})'
  page.screenshot(path=str(out/'11-phone-studio.png'))
  checks.append('a 390px phone: no horizontal overflow and the preview stays in view while scrolling the choices')
  browser.close()
finally:
 service.terminate();shutil.rmtree(data,ignore_errors=True)
assert not errors,errors
assert not bad,bad
result={'checks':checks,'skipped':skipped,'errors':errors,'webgl':webgl,'method':'Real service on loopback + Playwright; avatar things generated by tests/fixtures/avatar-fixtures.mjs'}
(out/'browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
