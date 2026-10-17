import {invariant} from './policy.mjs';
import {normalURL,insideEndpoint} from './network-policy.mjs';

const supportedApis=new Set(['openai-completions','mistral-conversations','openai-responses','azure-openai-responses','openai-codex-responses','anthropic-messages','google-generative-ai','pi-messages']);
const modelKeys=new Set(['id','name','api','provider','baseUrl','input','inputLimits','cost','headers','type','reasoning','thinkingLevelMap','promptCache','contextWindow','maxTokens','samplingParams','samplingParamsByThinkingLevel','compat','lab','enabled','providers']);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const boundedString=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/[\u0000-\u001f\u007f]/.test(x);
export const supportedPiApi=api=>supportedApis.has(api);

/** Persist only inert SDK metadata. Never manufacture defaults or copy credentials into a model. */
function checkedJSON(value){
 let nodes=0;
 const visit=(x,depth)=>{
  invariant(++nodes<=100000&&depth<=16,'pi-aiモデル定義が大きすぎます。');
  if(x===null||typeof x==='boolean'||x===undefined)return;
  if(typeof x==='number'){invariant(Number.isFinite(x),'pi-aiモデル定義の数値が不正です。');return;}
  if(typeof x==='string'){invariant(x.length<=16000,'pi-aiモデル定義の文字列が長すぎます。');return;}
  invariant(Array.isArray(x)||plain(x),'pi-aiモデル定義の形式が不正です。');
  for(const [key,item] of Object.entries(x)){invariant(!['__proto__','constructor','prototype'].includes(key),'pi-aiモデル定義のキーが不正です。');visit(item,depth+1);}
 };
 visit(value,0);const encoded=JSON.stringify(value);invariant(Buffer.byteLength(encoded)<=2_000_000,'pi-aiモデル一覧が大きすぎます。');return JSON.parse(encoded);
}
function checkedModel(model,provider,catalog){
 const def=catalog.getProvider(provider);
 invariant(plain(model)&&Object.keys(model).every(k=>modelKeys.has(k))&&model.provider===provider&&(model.type===undefined||model.type==='chat'),'pi-aiモデルのプロバイダー・形式が不正です。');
 invariant(boundedString(model.id,160)&&boundedString(model.name,500),'pi-aiモデルのID・名前が不正です。');
 invariant(supportedPiApi(model.api)&&def.getModels().some(m=>m.api===model.api),'このpi-aiアダプターの専用通信はまだ接続していません。');
 invariant(typeof model.reasoning==='boolean'&&Array.isArray(model.input)&&model.input.length>0&&model.input.length<=2&&new Set(model.input).size===model.input.length&&model.input.every(x=>['text','image'].includes(x)),'pi-aiモデルの入力形式が不正です。');
 for(const field of ['contextWindow','maxTokens'])invariant(Number.isSafeInteger(model[field])&&model[field]>0&&model[field]<=32_000_000,'pi-aiモデルのトークン数が不正です。');
 const rates=cost=>plain(cost)&&['input','output','cacheRead','cacheWrite'].every(k=>typeof cost[k]==='number'&&Number.isFinite(cost[k])&&cost[k]>=0&&cost[k]<=1_000_000_000);
 invariant(rates(model.cost)&&(model.cost.tiers===undefined||Array.isArray(model.cost.tiers)&&model.cost.tiers.length<=32&&model.cost.tiers.every(t=>rates(t)&&Number.isSafeInteger(t.inputTokensAbove)&&t.inputTokensAbove>=0)),'pi-aiモデルの料金定義が不正です。');
 const emptyAzure=model.baseUrl===''&&provider==='azure'&&!def.auth?.oauth&&def.getModels().some(m=>m.api===model.api&&m.baseUrl==='');
 if(!emptyAzure){
  invariant(boundedString(model.baseUrl,2048),'pi-aiモデルの送信先が不正です。');
  const url=normalURL(model.baseUrl),endpoints=[def.baseUrl,...def.getModels().map(m=>m.baseUrl)].filter(Boolean);
  const copilot=provider==='github-copilot'&&/^https:\/\/api\.(individual|business|enterprise)\.githubcopilot\.com$/.test(url.origin);
  invariant(url.protocol==='https:'&&(copilot||endpoints.some(base=>{try{return insideEndpoint(url,base);}catch{return false;}})),'pi-aiモデルの送信先が登録外です。');
 }
 for(const key of ['lab','enabled','providers'])if(model[key]!==undefined)invariant(provider==='radius','pi-aiモデルのゲートウェイ属性が不正です。');
 if(model.lab!==undefined)invariant(boundedString(model.lab,500),'pi-aiモデルのラベルが不正です。');
 if(model.enabled!==undefined)invariant(typeof model.enabled==='boolean','pi-aiモデルの有効状態が不正です。');
 if(model.providers!==undefined){
  invariant(Array.isArray(model.providers)&&model.providers.length<=64,'pi-aiモデルのゲートウェイ一覧が不正です。');
  for(const entry of model.providers)invariant(plain(entry)&&Object.keys(entry).every(k=>['id','name','credential','source'].includes(k))&&boundedString(entry.id,100)&&/^[a-z][a-z0-9-]*$/.test(entry.id)&&boundedString(entry.name,500)&&entry.credential==='radius'&&entry.source==='radius','pi-aiモデルのゲートウェイ属性に認証情報・送信先は保存できません。');
 }

 if(model.headers!==undefined){
  invariant(plain(model.headers)&&Object.keys(model.headers).length<=32,'pi-aiモデルのヘッダーが不正です。');
  for(const [key,value] of Object.entries(model.headers))invariant(/^[A-Za-z0-9-]{1,100}$/.test(key)&&!/(authorization|cookie|api[-_]?key|token|secret|credential|^host$|^connection$|^content-length$|^transfer-encoding$)/i.test(key)&&boundedString(value,8000),'pi-aiモデルに認証ヘッダーは保存できません。');
 }
 return model;
}
export function checkedPiModels(provider,models,catalog){
 invariant(catalog.getProvider(provider)&&Array.isArray(models)&&models.length<=2048,'pi-aiモデル一覧の形式が不正です。');
 const copy=checkedJSON(models),ids=new Set();
 for(const model of copy){checkedModel(model,provider,catalog);invariant(!ids.has(model.id),'pi-aiモデルIDが重複しています。');ids.add(model.id);}
 return copy;
}
/** A different SDK version needs explicit refresh; never silently reinterpret its metadata. */
export function storedPiCatalog(value,provider,catalog,version){
 if(value===undefined)return null;
 invariant(plain(value)&&Object.keys(value).every(k=>['schema','version','at','models'].includes(k))&&value.schema===1&&boundedString(value.version,32)&&typeof value.at==='string'&&Number.isFinite(Date.parse(value.at))&&Array.isArray(value.models),'pi-ai保存モデル一覧の形式が不正です。');
 if(value.version!==version)return null;
 return {schema:1,version:value.version,at:value.at,models:checkedPiModels(provider,value.models,catalog)};
}
