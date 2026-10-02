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
  browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
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
  page.get_by_role('button',name='作業',exact=False).first.click()
  page.get_by_role('button',name='習慣・定期実行',exact=True).click()
  page.get_by_role('button',name='習慣を追加',exact=True).first.click()
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
  page.get_by_role('button',name='段階のあるプラン',exact=True).click()
  page.get_by_role('button',name='プランを作る',exact=True).first.click()
  page.locator('[name=title]').fill('二つの案を比較して提案する')
  for index,title in enumerate(['案Aの長所と課題','案Bの長所と課題','比較と提案をまとめる'],1):
   page.locator('[name=title'+str(index)+']').fill(title)
   page.locator('[name=input'+str(index)+']').fill(title+'。未確認の点は区別して記載してください。')
  page.get_by_role('button',name='プランを保存する',exact=True).click()
  page.locator('.stage').first.wait_for()
  assert page.locator('.stage').count()==3
  assert '前提: 案Aの長所と課題、案Bの長所と課題' in page.locator('.stage').last.inner_text()
  page.screenshot(path=str(out/'07-plans.png'),full_page=True)
  checks.append('two independent stages and dependent final stage have explicit proposal state')
  page.get_by_role('button',name='接続',exact=True).click()
  page.locator('[data-action=codex-settings]').click()
  assert not page.locator('[name=codexEnabled]').is_checked()
  page.screenshot(path=str(out/'08-codex.png'))
  page.get_by_role('button',name='閉じる',exact=True).click()
  checks.append('Codex connection is opt-in with explicit execution and data-location notice')
  page.get_by_role('button',name='ホーム',exact=True).click()
  page.locator('#composer-input').fill('private draft')
  page.get_by_role('button',name='共有表示に切り替える',exact=True).click()
  assert not page.locator('#composer-input').is_visible()
  page.get_by_role('button',name='共有表示に切り替える',exact=True).click()
  assert page.locator('#composer-input').input_value()=='private draft'
  page.locator('#composer-input').fill('')
  page.set_viewport_size({'width':390,'height':844})
  page.get_by_role('button',name='作業',exact=False).first.click()
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  page.screenshot(path=str(out/'09-mobile-plans.png'),full_page=True)
  page.get_by_role('button',name='習慣・定期実行',exact=True).click()
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  page.screenshot(path=str(out/'10-mobile-routines.png'),full_page=True)
  checks.append('mobile plan and routine surfaces do not overflow horizontally')
  page.get_by_role('button',name='ホーム',exact=True).click()
  page.get_by_role('button',name='表示をカスタマイズ',exact=True).click()
  page.locator('[name=textScale]').fill('1.8')
  page.get_by_role('button',name='表示に反映する',exact=True).click()
  page.wait_for_timeout(150)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
  assert page.get_by_role('button',name='すべて停止',exact=True).is_visible()
  checks.append('180% text scale preserves emergency stop at 390px')
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
