/** A deterministic browser bundle for the fixed in-repository modules.
 * No eval, third-party transpiler or runtime network dependency. Source modules stay separate.
 * The async entry runs inside a classic script, avoiding WebView module-loader/TLA differences.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
/** Dependency order. Every module shares one scope in the bundle, so top-level names must be unique. */
export const BUNDLE_ORDER=['status','markdown','ui','demo','display-model','voice-lines','avatar/pose','avatar/model','avatar/kit','avatar/geometry','avatar/body-shiro','avatar/body-andon','avatar/body-ensou','avatar/body-kobako','avatar/body-kitsune','avatar/body-hotaru','avatar/body-kokedama','avatar/body-image','avatar/svg','avatar/stage','bridge','draft','companion-state','dialogue-state','approval-format','voice','realtime-voice','seasons','daylight','wallpaper','frame','lights','seal','ambient','inbox','music','onboarding','provider-settings','capability-ui','execution-ui','avatar/settings','frame-settings','app'];
export async function browserBundle(webDir,{preview=false}={}) {
  const parts=[],declared=new Map();
  for(const name of BUNDLE_ORDER) {
    const source=await readFile(path.join(webDir,`${name}.mjs`),'utf8');
    const transformed=source.replace(/^import .+ from '.+?';\r?\n/gm,'').replace(/^export (?=(?:async )?function\s|class\s|const\s|let\s)/gm,'');
    if(/^\s*(?:import\s|export\s)/m.test(transformed))throw new Error(`Unsupported module declaration in ${name}; update the bundle contract explicitly.`);
    for(const m of transformed.matchAll(/^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)){
      const owner=declared.get(m[1]);if(owner&&owner!==name)throw new Error(`Duplicate top-level name ${m[1]} in ${owner} and ${name}; module scopes are shared in the bundle.`);declared.set(m[1],name);
    }
    parts.push(transformed);
  }
  return `window.__TEPORA_PREVIEW__=${preview};\n(function(){\n'use strict';\nfunction fail(error){\n const root=document.getElementById('app');if(!root||root.childElementCount)return;\n const panel=document.createElement('div');panel.className='fatal';\n const title=document.createElement('h1');title.textContent='tepora';\n const heading=document.createElement('h2');heading.textContent='画面を起動できませんでした。';\n const details=document.createElement('p');details.textContent=String(error&&error.message||error||'Unknown startup error').replace(/Bearer\\s+\\S+/gi,'Bearer [redacted]').replace(/sk-[\\w-]+/g,'[redacted]').slice(0,500);\n panel.append(title,heading,details);root.replaceChildren(panel);\n}\nwindow.addEventListener('error',function(e){fail(e.error||e.message);});\nwindow.addEventListener('unhandledrejection',function(e){fail(e.reason);});\nconst timer=setTimeout(function(){fail('接続が完了しませんでした。アプリを起動し直してください。');},20000);\n(async function(){\n${parts.join('\n')}\n})().catch(fail).finally(function(){clearTimeout(timer);});\n})();\n`;
}
