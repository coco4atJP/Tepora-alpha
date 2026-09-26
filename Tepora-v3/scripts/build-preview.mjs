import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const parts=[];
for(const name of ['ui','demo','bridge','voice','app']){const source=await readFile(path.join(root,'web',name+'.mjs'),'utf8');parts.push(source.replace(/^import .+ from '.+?';\n/gm,'').replace(/^export /gm,''));}
const css=await readFile(path.join(root,'web/styles.css'),'utf8');
const code=`window.__TEPORA_PREVIEW__=true;\n(async()=>{\n${parts.join('\n')}\n})();`;
const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#120c0a"><title>Tepora V3 — interactive preview</title><style>${css}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status" aria-live="polite"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
const output=process.argv[2]||path.join(root,'tepora-v3-preview.html');await writeFile(output,html);console.log(output);
