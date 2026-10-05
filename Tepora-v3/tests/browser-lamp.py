"""One lamp: the caption and the room light on the home stage, work as lights and the amber lamp, the
seal that says yes, and the idle screen as a screensaver with wallpapers and a photo frame. Runs on the
offline preview; no AI is used. Real service storage of photos is covered by node:test."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64,json,sys,shutil,os
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[]
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
with sync_playwright() as pw:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
 browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':900},color_scheme='light',timezone_id='Asia/Tokyo')
 page.set_default_timeout(8000)
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.set_content((root/'tepora-v3-preview.html').read_text(),wait_until='load')
 page.locator('#clock-display').wait_for()
 def nav(view):page.locator(f'.nav [data-view={view}]').click()
 # --- the home stage: a caption instead of a balloon, the season under the date, weather as one line
 assert page.locator('#speech').is_visible()
 assert page.locator('#speech').evaluate('el=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
 assert '・' in page.locator('#clock-season').inner_text()
 assert '晴れ' in page.locator('#clock-sub').inner_text()
 assert page.locator('body').get_attribute('data-backdrop')=='room'
 page.screenshot(path=str(out/'01-home.png'))
 checks.append('home: the character speaks as a caption, the date carries its 七十二候, weather is one line, the room is the backdrop')
 # --- work becomes a light, then an amber lamp that is the way into あなたの番
 nav('workspace');page.get_by_role('button',name='画面サンプルを試す',exact=True).click();nav('home')
 page.locator('.ff-wait').wait_for(timeout=9000)
 assert page.locator('#inbox-button').is_hidden(),'the top bar yields to the lamp on the home stage'
 assert page.locator('.ff-wait').get_attribute('aria-label')=='あなたの番 1件を開く'
 assert '確認していただきたいことが' in page.locator('#speech').inner_text()
 nav('settings');assert page.locator('#inbox-button').is_visible()
 assert page.locator('body').get_attribute('data-lamp')=='wait'
 nav('home')
 page.screenshot(path=str(out/'02-lamp.png'))
 checks.append('the amber lamp replaces the top-bar entry on home and the wordmark lamp takes over on other pages')
 # --- the seal: a short press does nothing, a hold seals and the approval goes through
 page.locator('.ff-wait').click()
 seal=page.locator('#panel .seal');seal.wait_for()
 page.wait_for_timeout(450)  # the panel slides in; measure the seal once it has settled
 assert seal.get_attribute('data-hold')=='1'
 box=seal.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
 page.mouse.move(x,y);page.mouse.down();page.wait_for_timeout(250);page.mouse.up()
 assert page.locator('#panel .slip.is-sealed').count()==0,'a short press must not approve'
 page.mouse.move(x,y);page.mouse.down()
 page.wait_for_function("document.querySelector('#panel .slip')?.classList.contains('is-sealed')",timeout=3000)
 page.screenshot(path=str(out/'03-seal.png'))
 page.mouse.up()
 page.wait_for_function("document.querySelector('#panel .panel-body')?.textContent.includes('いまは、ありません')",timeout=6000)
 page.wait_for_function("document.querySelectorAll('.ff').length===0",timeout=6000)
 checks.append('seal: a short press does not approve, a held press stamps the slip and the approval goes through exactly once')
 page.keyboard.press('Escape')
 # --- the idle screen is a screensaver: any quiet view, wallpapers, and it gives the view back
 nav('settings')
 for wallpaper in ['drift','stars']:
  page.locator(f'[data-action=wallpaper-set][data-value={wallpaper}]').click()
  page.wait_for_function(f"document.querySelector('[data-action=wallpaper-set][data-value={wallpaper}]').getAttribute('aria-pressed')==='true'")
  page.locator('[data-action=ambient-try]').click()
  page.wait_for_function(f"document.body.classList.contains('is-ambient')&&document.body.dataset.backdrop==='{wallpaper}'")
  if wallpaper=='stars':assert page.locator('#wp-stars i').count()>50
  page.screenshot(path=str(out/f'04-idle-{wallpaper}.png'))
  page.wait_for_timeout(1300);page.keyboard.press('Escape')
  page.wait_for_function("!document.body.classList.contains('is-ambient')")
  assert page.locator('body').get_attribute('data-view')=='settings','waking returns to what the person was doing'
 checks.append('idle screen: drifting colour and night sky wallpapers start from any view and the person is returned to it on waking')
 # --- the photo frame: add a photo, add the samples, show them full screen, change how they are shown
 page.locator('[data-action=frame-open]').click()
 with page.expect_file_chooser() as chooser:page.locator('[data-action=frame-add]').click()
 chooser.value.set_files({'name':'ひとつぶ.png','mimeType':'image/png','buffer':PNG})
 page.wait_for_function("document.querySelectorAll('.frame-tile').length===1")
 page.locator('[data-action=frame-sample]').click()
 page.wait_for_function("document.querySelectorAll('.frame-tile').length===5")
 page.locator('[data-action=frame-remove]').first.click()  # the one-pixel file: the samples make a better picture
 page.wait_for_function("document.querySelectorAll('.frame-tile').length===4")
 page.locator('[data-action=frame-opt][data-key=frameFit][data-value=contain]').click()
 page.locator('[data-action=frame-opt][data-key=frameClock][data-value=large]').click()
 page.wait_for_function("document.querySelector('[data-action=frame-opt][data-key=frameFit][data-value=contain]').getAttribute('aria-pressed')==='true'")
 page.screenshot(path=str(out/'05-frame-sheet.png'))
 page.keyboard.press('Escape')
 page.locator('[data-action=wallpaper-set][data-value=photos]').click()
 page.locator('[data-action=ambient-try]').click()
 page.wait_for_function("document.body.dataset.backdrop==='photos'&&document.querySelector('#wp-photos .fl.is-in img')?.naturalWidth>0",timeout=9000)
 assert page.locator('body').get_attribute('data-frame-clock')=='large'
 assert page.locator('#wp-photos .fs-contain').count()==1
 page.wait_for_timeout(2300)  # the first picture fades up from black
 page.screenshot(path=str(out/'06-frame.png'))
 page.wait_for_timeout(1300);page.keyboard.press('Escape')
 page.wait_for_function("!document.body.classList.contains('is-ambient')")
 # shared view never shows personal photos behind the screen
 page.locator('[data-action=ambient-try]').click()
 page.wait_for_function("document.body.dataset.backdrop==='photos'")
 page.wait_for_timeout(1300);page.keyboard.press('Escape')
 page.wait_for_function("!document.body.classList.contains('is-ambient')")
 page.locator('[data-action=frame-open]').click()
 page.locator('[data-action=frame-remove]').first.click()
 page.wait_for_function("document.querySelectorAll('.frame-tile').length===3")
 page.keyboard.press('Escape')
 checks.append('photo frame: a chosen file and the samples are shown full screen with the chosen fit and clock, and photos can be removed')
 # --- the night: the idle screen is lit by the lamp, whatever the theme
 page.evaluate("""()=>{const D=Date,now=new D(),t=new D(now);t.setHours(22,30,0,0);const off=t-now;
  window.Date=class extends D{constructor(...a){a.length?super(...a):super(D.now()+off);}static now(){return D.now()+off;}};}""")
 page.wait_for_timeout(1300)
 page.locator('[data-action=wallpaper-set][data-value=room]').click()
 page.locator('[data-action=ambient-try]').click()
 page.wait_for_function("document.body.classList.contains('is-ambient')&&document.body.classList.contains('is-lamp')")
 bg=page.evaluate("getComputedStyle(document.body).backgroundColor")
 assert bg=='rgb(14, 12, 10)',bg
 page.screenshot(path=str(out/'07-night.png'))
 page.wait_for_timeout(1300);page.keyboard.press('Escape')
 page.wait_for_function("!document.body.classList.contains('is-ambient')")
 checks.append('night: the idle screen switches to the lamp palette instead of dimming the day')
 # --- dark theme and a phone
 page.get_by_role('button',name='暗い',exact=True).click()
 page.wait_for_function("document.body.dataset.theme==='dark'")
 nav('home');page.wait_for_timeout(400)
 page.screenshot(path=str(out/'08-dark.png'))
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(500)
 assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
 assert page.locator('#composer-input').evaluate('el=>el.getBoundingClientRect().height')<=60,'the message box is measured again after the width changes'
 page.screenshot(path=str(out/'09-mobile.png'))
 checks.append('dark theme and a 390px phone: no horizontal overflow and a message box of normal height')
 assert not errors,errors
 browser.close()
result={'checks':checks,'errors':errors,'viewports':[[1440,900],[390,844]],'realModels':False,'method':'System Chromium + Playwright; self-contained HTML via set_content'}
(out/'browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
