
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,sys,shutil,os
root=Path(sys.argv[1]);out=Path(sys.argv[2])
checks=[];errors=[]
with sync_playwright() as pw:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
 browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={"width":1440,"height":1000},color_scheme="light")
 page.on("pageerror",lambda error:errors.append(str(error)))
 page.set_content((root/"tepora-v3-preview.html").read_text(),wait_until="load")
 page.locator("#clock-display").wait_for()
 def nav(view):page.locator(f".nav [data-view={view}]").click()
 page.screenshot(path=str(out/"01-home.png"),full_page=True)
 assert page.locator("#composer-input").is_visible()
 assert page.locator(".artifact-panel").count()==0
 assert page.locator("#talk-rail").is_hidden()
 checks.append("quiet default home: character, clock and one card; the message box sits under the character")
 nav("settings")
 page.get_by_role("button",name="暗い",exact=True).click()
 page.wait_for_function("document.body.dataset.theme==='dark'")
 page.locator('[data-action=widget-toggle][value=news]').uncheck()
 page.wait_for_function("!document.querySelector('[data-action=widget-toggle][value=news]').checked")
 page.screenshot(path=str(out/"02-customize.png"))
 nav("home")
 # Weather is one line under the date and work is shown as lights, so with the news card hidden the deck is empty.
 assert page.locator(".deck-card").count()==0
 assert page.get_by_role("button",name="ホームのカードを設定",exact=True).is_visible()
 assert "晴れ" in page.locator("#clock-sub").inner_text()
 nav("settings")
 page.get_by_role("button",name="前の表示に戻す",exact=True).click()
 page.wait_for_function("document.querySelector('[data-action=widget-toggle][value=news]')?.checked===true")
 page.get_by_role("button",name="前の表示に戻す",exact=True).click()
 page.wait_for_function("document.body.dataset.theme==='system'")
 checks.append("customization applies immediately, a hidden card leaves the monitor, and undo restores each change")
 nav("home")
 page.locator("#composer-input").fill("非公開の下書き")
 page.get_by_role("button",name="画面の表示",exact=True).click()
 page.get_by_role("button",name="共有表示（個人の内容を隠す）",exact=True).click()
 assert not page.locator("#composer-input").is_visible()
 page.get_by_role("button",name="共有表示を終える",exact=True).click()
 assert page.locator("#composer-input").input_value()=="非公開の下書き"
 page.locator("#composer-input").fill("")
 checks.append("shared presentation hides and restores draft")
 nav("workspace")
 page.get_by_role("button",name="画面サンプルを試す",exact=True).click()
 page.wait_for_function("document.querySelector('.version-button')?.textContent.includes('3')")
 frame=page.locator("#artifact-preview iframe").content_frame
 frame.locator("body").evaluate("(el)=>{window.__tepora_reading_marker='keep';}")
 page.get_by_role("button",name="この版で固定する",exact=True).click()
 page.wait_for_timeout(1200)
 assert frame.locator("body").evaluate("(el)=>window.__tepora_reading_marker")=="keep"
 checks.append("pinning a revision and task completion do not recreate the iframe")
 page.screenshot(path=str(out/"03-artifact.png"),full_page=True)
 assert page.locator("#artifact-preview iframe").count()==1
 checks.append("no-AI sample produces three visible artifact revisions")
 page.set_viewport_size({"width":390,"height":844})
 nav("home")
 page.screenshot(path=str(out/"04-mobile-home.png"),full_page=True)
 assert page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1")
 nav("workspace")
 page.screenshot(path=str(out/"05-mobile-artifact.png"),full_page=True)
 assert page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1")
 checks.append("390px home and artifact views have no horizontal overflow")
 assert not errors,errors
 browser.close()
result={"checks":checks,"errors":errors,"viewports":[[1440,1000],[390,844]],"realModels":False,
 "method":"System Chromium + Playwright; self-contained HTML via set_content",
 "limitation":"Live loopback navigation is blocked by browser administrator policy. Policy was not changed. Backend HTTP tests are separate."}
(out/"browser-results.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
