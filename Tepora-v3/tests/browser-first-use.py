"""Frontend regression using the explicit offline preview. No model capability is simulated.
Real setup/download/model protocol requests are tested separately in setup-journey.test.mjs.
"""
from pathlib import Path
import json,sys,shutil,os
from playwright.sync_api import sync_playwright
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
errors=[];checks=[]
with sync_playwright() as p:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
 browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1000},color_scheme='light',timezone_id='Asia/Tokyo')
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content((root/'tepora-v3-preview.html').read_text(),wait_until='load')
 page.locator('#clock-display').wait_for()
 assert page.locator('.artifact-panel').count()==0
 page.screenshot(path=str(out/'01-home.png'))
 page.locator('#composer-input').fill('添えたメモを使って、確認事項を整理して')
 page.locator('[data-action=onboard]').click()
 assert page.get_by_role('button',name='このPCのAIを探す',exact=True).is_visible()
 page.get_by_role('button',name='このPCのAIを探す',exact=True).click()
 page.locator('#setup-error:not([hidden])').wait_for()
 assert 'プレビュー' in page.locator('#setup-error').inner_text()
 assert page.get_by_role('button',name='今は時計として使う',exact=True).is_visible()
 page.screenshot(path=str(out/'02-start-here.png'))
 page.get_by_role('button',name='今は時計として使う',exact=True).click()
 assert page.locator('#composer-input').input_value()=='添えたメモを使って、確認事項を整理して'
 checks.append('setup can be opened/closed without losing the draft; preview never invents a model connection')
 with page.expect_file_chooser() as chooser:page.get_by_role('button',name='ファイルを添える',exact=True).click()
 chooser.value.set_files({'name':'meeting.md','mimeType':'text/markdown','buffer':'10月4日14時。見積もりは承認前。'.encode()})
 page.locator('#input-files').get_by_text('meeting.md',exact=True).wait_for()
 page.screenshot(path=str(out/'03-selected-file.png'))
 assert 'まだAIへ送信' in page.locator('#toast').inner_text()
 checks.append('a user-picked text file is attached with an explicit not-yet-sent state')
 page.get_by_role('button',name='送信',exact=True).click()
 page.wait_for_function("document.querySelector('#request-status').textContent.includes('プレビュー')")
 assert page.locator('#composer-input').input_value()=='添えたメモを使って、確認事項を整理して'
 assert 'meeting.md' in page.locator('#input-files').inner_text()
 checks.append('failed/unsupported submission retains both text and the selected file')
 page.get_by_role('button',name='共有表示に切り替える',exact=True).click()
 assert not page.locator('#input-files').is_visible()
 assert not page.locator('#composer-input').is_visible()
 assert not page.locator('#request-status').is_visible()
 page.get_by_role('button',name='共有表示に切り替える',exact=True).click()
 assert 'meeting.md' in page.locator('#input-files').inner_text()
 checks.append('shared presentation hides filenames, errors and drafts, restoring them afterward')
 page.get_by_role('button',name='meeting.mdを下書きから外す',exact=True).click()
 assert page.locator('#input-files').inner_text()==''
 checks.append('the selected source can be removed without modifying its original file')
 page.set_viewport_size({'width':390,'height':844})
 page.locator('[data-action=onboard]').click()
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
 page.wait_for_function("getComputedStyle(document.querySelector('#toast')).opacity==='0'")
 assert page.get_by_role('button',name='今は時計として使う',exact=True).is_visible()
 page.screenshot(path=str(out/'04-mobile-setup.png'))
 page.keyboard.press('Escape')
 page.get_by_role('button',name='表示をカスタマイズ',exact=True).click()
 page.locator('[name=textScale]').fill('1.8')
 page.get_by_role('button',name='表示に反映する',exact=True).click()
 page.wait_for_timeout(150)
 assert page.get_by_role('button',name='すべて停止',exact=True).is_visible()
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
 checks.append('390px layout and 180% text scale retain the stop control without horizontal overflow')
 assert not errors,errors
 browser.close()
report={'mode':'offline UI preview','checks':checks,'errors':errors,'realModel':False,'liveHTTPTest':'tests/setup-journey.test.mjs',
 'browser':'Playwright/system Chromium (Browser plugin not available)','viewports':[[1440,1000],[390,844]],'timezone':'Asia/Tokyo'}
(out/'first-use-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
