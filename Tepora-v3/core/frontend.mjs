/** A deterministic browser bundle for the fixed in-repository modules.
 * No eval, third-party transpiler or runtime network dependency. Source modules stay separate.
 * The async entry runs inside a classic script, avoiding WebView module-loader/TLA differences.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
export async function browserBundle(webDir,{preview=false}={}) {
  const parts=[];
  for(const name of ['ui','demo','display-model','bridge','draft','companion-state','voice','realtime-voice','onboarding','provider-settings','capability-ui','app']) {
    const source=await readFile(path.join(webDir,`${name}.mjs`),'utf8');
    const transformed=source.replace(/^import .+ from '.+?';\r?\n/gm,'').replace(/^export (?=(?:async )?function\s|class\s|const\s|let\s)/gm,'');
    if(/^\s*(?:import\s|export\s)/m.test(transformed))throw new Error(`Unsupported module declaration in ${name}; update the bundle contract explicitly.`);
    parts.push(transformed);
  }
  return `window.__TEPORA_PREVIEW__=${preview};\n(function(){\n'use strict';\nfunction fail(error){\n const root=document.getElementById('app');if(!root||root.childElementCount)return;\n const panel=document.createElement('div');panel.className='fatal';\n const title=document.createElement('h1');title.textContent='tepora';\n const heading=document.createElement('h2');heading.textContent='画面を起動できませんでした。';\n const details=document.createElement('p');details.textContent=String(error&&error.message||error||'Unknown startup error').replace(/Bearer\\s+\\S+/gi,'Bearer [redacted]').replace(/sk-[\\w-]+/g,'[redacted]').slice(0,500);\n panel.append(title,heading,details);root.replaceChildren(panel);\n}\nwindow.addEventListener('error',function(e){fail(e.error||e.message);});\nwindow.addEventListener('unhandledrejection',function(e){fail(e.reason);});\nconst timer=setTimeout(function(){fail('接続が完了しませんでした。アプリを起動し直してください。');},20000);\n(async function(){\n${parts.join('\n')}\n})().catch(fail).finally(function(){clearTimeout(timer);});\n})();\n`;
}
