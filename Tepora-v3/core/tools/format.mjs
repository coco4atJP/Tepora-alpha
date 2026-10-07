import {rawTokens} from '../agent/tokens.mjs';

/** Tool results are shaped once, when they are written, so the transcript never changes afterwards. */
export function toText(result){
 if(typeof result==='string')return result;
 if(result===undefined||result===null)return '(no output)';
 if(typeof result.text==='string'&&Object.keys(result).every(k=>['text','data','images'].includes(k)))return result.text;
 return JSON.stringify(result,null,1);
}
/** Keep the head and the tail; the middle is reachable through recall. */
export function fitTokens(text,maxTokens,ref){
 const total=rawTokens(text);
 if(total<=maxTokens)return {text,truncated:false};
 const perToken=text.length/total,keep=Math.max(200,Math.floor(maxTokens*perToken)),head=Math.floor(keep*0.7),tail=keep-head;
 const cut=text.length-head-tail;
 return {text:`${text.slice(0,head)}\n…[${cut.toLocaleString('en-US')} characters omitted of ${text.length.toLocaleString('en-US')}; recall("${ref}", offset=${head}) reads the rest]…\n${text.slice(text.length-tail)}`,truncated:true};
}
export function oneLine(value,max=90){
 const s=String(value??'').replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max-1)+'…':s;
}
export function argsLabel(args){
 if(!args||typeof args!=='object')return '';
 const parts=[];
 for(const [k,v] of Object.entries(args)){
  if(v===undefined||v===null||v==='')continue;
  const s=typeof v==='string'?(v.length>60?JSON.stringify(v.slice(0,57)+'…'):JSON.stringify(v)):Array.isArray(v)?`[${v.length}]`:typeof v==='object'?'{…}':String(v);
  parts.push(`${k}=${s}`);if(parts.join(' ').length>110)break;
 }
 return oneLine(parts.join(' '),120);
}
export function defaultStub(name,args,text,{error}={}){
 const head=error?'error: '+oneLine(error,80):oneLine(text.split('\n').find(l=>l.trim())||'',70);
 return `${name}(${argsLabel(args)}) → ${head} [${text.length.toLocaleString('en-US')} chars]`;
}

/** Light JSON Schema check for tool arguments: enough to give the model a precise error. */
export function checkArgs(schema,args,path='arguments'){
 if(!schema||typeof schema!=='object')return null;
 if(schema.type==='object'){
  if(!args||typeof args!=='object'||Array.isArray(args))return `${path} must be an object`;
  for(const key of schema.required||[])if(args[key]===undefined)return `${path}.${key} is required`;
  for(const [key,value] of Object.entries(args)){
   const sub=schema.properties?.[key];
   if(!sub){if(schema.additionalProperties===false)return `${path}.${key} is not a known parameter (expected: ${Object.keys(schema.properties||{}).join(', ')})`;continue;}
   const e=checkArgs(sub,value,`${path}.${key}`);if(e)return e;
  }
  return null;
 }
 if(args===undefined||args===null)return null;
 if(schema.enum&&!schema.enum.includes(args))return `${path} must be one of ${schema.enum.map(x=>JSON.stringify(x)).join(', ')}`;
 const t=schema.type;
 if(t==='string'&&typeof args!=='string')return `${path} must be a string`;
 if(t==='integer'&&!Number.isInteger(args))return `${path} must be an integer`;
 if(t==='number'&&typeof args!=='number')return `${path} must be a number`;
 if(t==='boolean'&&typeof args!=='boolean')return `${path} must be true or false`;
 if(t==='array'){if(!Array.isArray(args))return `${path} must be an array`;if(schema.items)for(let i=0;i<args.length;i++){const e=checkArgs(schema.items,args[i],`${path}[${i}]`);if(e)return e;}}
 if(typeof args==='number'){if(schema.minimum!==undefined&&args<schema.minimum)return `${path} must be ≥ ${schema.minimum}`;if(schema.maximum!==undefined&&args>schema.maximum)return `${path} must be ≤ ${schema.maximum}`;}
 return null;
}

/** Repairs the slips small models make (fences, trailing commas, a missing closer). Never used on truncated output. */
export function parseArgs(raw){
 const source=String(raw??'').trim();
 if(!source)return {args:{},repaired:false};
 try{const v=JSON.parse(source);return v&&typeof v==='object'&&!Array.isArray(v)?{args:v,repaired:false}:{error:'arguments must be a JSON object'};}catch(e){
  const fixed=repairJSON(source);
  if(fixed!==null){try{const v=JSON.parse(fixed);if(v&&typeof v==='object'&&!Array.isArray(v))return {args:v,repaired:true};}catch{}}
  return {error:`arguments are not valid JSON (${String(e.message).slice(0,120)})`};
 }
}
export function repairJSON(text){
 let s=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
 const start=s.indexOf('{');if(start<0)return null;s=s.slice(start);
 s=s.replace(/,\s*([}\]])/g,'$1');
 const stack=[];let inString=false,escape=false,end=-1;
 for(let i=0;i<s.length;i++){
  const c=s[i];
  if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}
  if(c==='"')inString=true;else if(c==='{'||c==='[')stack.push(c==='{'?'}':']');
  else if(c==='}'||c===']'){if(stack.pop()!==c)return null;if(!stack.length){end=i;break;}}
 }
 if(end>=0)return s.slice(0,end+1);
 if(inString)s+='"';
 s=s.replace(/,\s*$/,'');
 return s+stack.reverse().join('');
}
