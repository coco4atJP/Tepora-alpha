
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,sys
root=Path(sys.argv[1]);out=Path(sys.argv[2])
checks=[];errors=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path="/usr/bin/chromium",headless=True,args=["--no-sandbox"])
 page=browser.new_page(viewport={"width":1440,"height":1000},color_scheme="light")
 page.on("pageerror",lambda error:errors.append(str(error)))
 page.set_content((root/"tepora-v3-preview.html").read_text(),wait_until="load")
 page.locator("#clock-display").wait_for()
 page.screenshot(path=str(out/"01-home.png"),full_page=True)
 assert page.locator("#composer-input").is_visible()
 assert page.locator(".artifact-panel").count()==0
 checks.append("quiet default home, persistent input, explicit no-AI preview")
 page.get_by_role("button",name="表示をカスタマイズ",exact=True).click()
 page.locator('[name=theme]').select_option("dark")
 page.locator('[name=widget][value=media]').check()
 page.screenshot(path=str(out/"02-customize.png"))
 page.get_by_role("button",name="表示に反映する",exact=True).click()
 page.wait_for_function("document.body.dataset.theme==='dark'")
 assert page.locator(".media-glance").is_visible()
 page.get_by_role("button",name="表示をカスタマイズ",exact=True).click()
 assert page.locator('[name=widget][value=media]').is_checked()
 page.get_by_role("button",name="前の表示に戻す",exact=True).click()
 page.wait_for_function("document.body.dataset.theme==='system'")
 checks.append("customization, widget selection and undo")
 page.locator("#composer-input").fill("非公開の下書き")
 page.get_by_role("button",name="共有表示に切り替える",exact=True).click()
 assert not page.locator("#composer-input").is_visible()
 page.get_by_role("button",name="共有表示に切り替える",exact=True).click()
 assert page.locator("#composer-input").input_value()=="非公開の下書き"
 page.locator("#composer-input").fill("")
 checks.append("shared presentation hides and restores draft")
 page.get_by_role("button",name="作業",exact=False).first.click()
 page.get_by_role("button",name="画面サンプル",exact=True).click()
 page.wait_for_function("document.querySelector('.artifact-toolbar small')?.textContent.includes('3')")
 frame=page.locator("#artifact-preview iframe").content_frame
 frame.locator("body").evaluate("(el)=>{window.__tepora_reading_marker='keep';}")
 page.get_by_role("button",name="更新を固定する",exact=True).click()
 page.wait_for_timeout(1200)
 assert frame.locator("body").evaluate("(el)=>window.__tepora_reading_marker")=="keep"
 checks.append("pinning a revision and task completion do not recreate the iframe")
 page.screenshot(path=str(out/"03-artifact.png"),full_page=True)
 assert page.locator("#artifact-preview iframe").count()==1
 checks.append("no-AI sample produces three visible artifact revisions")
 page.set_viewport_size({"width":390,"height":844})
 page.get_by_role("button",name="ホーム",exact=True).click()
 page.screenshot(path=str(out/"04-mobile-home.png"),full_page=True)
 assert page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1")
 page.get_by_role("button",name="作業",exact=False).first.click()
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
