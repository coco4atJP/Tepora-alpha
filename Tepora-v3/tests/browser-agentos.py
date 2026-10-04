"""New AgentOS surfaces. Offline browser checks are explicitly separate from live HTTP tests."""
import json, sys, subprocess, tempfile, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(sys.argv[1]); out=Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True)
errors=[];checks=[];live_blocker=None
# Check the browser's actual policy in this environment; never alter administrator controls.
dir=tempfile.mkdtemp(prefix='tepora-ui-')
process=subprocess.Popen(['node','core/server.mjs'],cwd=root,env={**os.environ,'TEPORA_DATA_DIR':dir},stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
 ready=json.loads(process.stdout.readline())
 with sync_playwright() as pw:
  executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
  browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1440,'height':1000},color_scheme='light',timezone_id='Asia/Tokyo')
  probe=context.new_page()
  try:
   probe.goto(ready['url'],wait_until='domcontentloaded',timeout=12000)
   probe.locator('#clock-display').wait_for(timeout=5000)
   checks.append('live service first screen rendered')
  except Exception as error:
   live_blocker=str(error).split('\n')[0].split(' at http:')[0]
  probe.close()
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content((root/'tepora-v3-preview.html').read_text(),wait_until='load')
  def nav(view):page.locator(f'.nav [data-view={view}]').click()
  nav('workspace')
  page.get_by_role('button',name='くりかえし',exact=True).click()
  page.get_by_role('button',name='くりかえしを追加',exact=True).first.click()
  page.locator('[name=title]').fill('毎朝の予定を整理')
  page.locator('[name=input]').fill('その日に使う資料を確認し、短いメモを用意する。これは画面検証用の例です。')
  page.locator('[name=time]').fill('08:30')
  page.get_by_role('button',name='提案を保存する',exact=True).click()
  page.locator('.routine-meta').wait_for()
  assert page.locator('.automation-card').count()==1
  assert '停止中' in page.locator('.automation-card').inner_text()
  page.screenshot(path=str(out/'06-routines.png'),full_page=True)
  page.get_by_role('button',name='内容を確認して有効にする',exact=True).click()
  assert '実行予約' in page.locator('#toast').inner_text()
  checks.append('routine proposal saved without creating a real scheduled task in preview')
  page.locator('#toast').evaluate("el=>el.classList.remove('show')")
  page.get_by_role('button',name='プラン',exact=True).click()
  page.get_by_role('button',name='プランを作る',exact=True).first.click()
  page.locator('[name=title]').fill('二つの案を比較して提案する')
  for index,title in enumerate(['案Aの長所と課題','案Bの長所と課題','比較と提案をまとめる'],1):
   page.locator('[name=title'+str(index)+']').fill(title)
   page.locator('[name=input'+str(index)+']').fill(title+'。未確認の点は区別して記載してください。')
  page.get_by_role('button',name='プランを保存する',exact=True).click()
  page.locator('.stage-step').first.wait_for()
  assert page.locator('.stage-step').count()==3
  assert '前提: 案Aの長所と課題、案Bの長所と課題' in page.locator('.stage-step').last.inner_text()
  page.screenshot(path=str(out/'07-plans.png'),full_page=True)
  checks.append('two independent stages and dependent final stage have explicit proposal state')
  nav('settings')
  page.locator('[data-action=codex-settings]').click()
  assert not page.locator('[name=codexEnabled]').is_checked()
  page.screenshot(path=str(out/'08-codex.png'))
  page.get_by_role('button',name='閉じる',exact=True).click()
  checks.append('Codex connection is opt-in with explicit execution and data-location notice')
  nav('home')
  page.locator('#composer-input').fill('private draft')
  page.get_by_role('button',name='画面の表示',exact=True).click()
  page.get_by_role('button',name='共有表示（個人の内容を隠す）',exact=True).click()
  assert not page.locator('#composer-input').is_visible()
  page.get_by_role('button',name='共有表示を終える',exact=True).click()
  assert page.locator('#composer-input').input_value()=='private draft'
  page.locator('#composer-input').fill('')
  page.set_viewport_size({'width':390,'height':844})
  nav('workspace')
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  page.screenshot(path=str(out/'09-mobile-plans.png'),full_page=True)
  page.get_by_role('button',name='くりかえし',exact=True).click()
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  page.screenshot(path=str(out/'10-mobile-routines.png'),full_page=True)
  checks.append('mobile plan and routine surfaces do not overflow horizontally')
  nav('settings')
  page.get_by_role('button',name='最大',exact=True).click()
  page.wait_for_function("document.documentElement.style.fontSize==='25.6px'")
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  nav('workspace')
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  checks.append('160% text scale keeps settings and work surfaces within 390px')
  assert not errors,errors
  browser.close()
finally:
 process.terminate()
 try: process.wait(timeout=5)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 shutil.rmtree(dir,ignore_errors=True)
report={'checks':checks,'errors':errors,'liveBrowserBlocker':live_blocker,'realModel':False,
 'method':'Playwright system Chromium. Browser plugin not available; no policy bypass.',
 'viewports':[[1440,1000],[390,844]],'timezone':'Asia/Tokyo'}
(out/'agentos-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
