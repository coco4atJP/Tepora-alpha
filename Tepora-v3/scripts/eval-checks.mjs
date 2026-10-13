import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

/** Deterministic outcome checks. Unknown/empty checks fail instead of granting success. */
export async function evaluateChecks(c,cwd,store,entries=[],sessionId=null){
 if(!Array.isArray(c.checks)||!c.checks.length)return [{ok:false,detail:'No acceptance checks'}];
 const results=[];
 for(const k of c.checks){
  let ok=false,detail='';
  try{
   if(k.type==='file'){
    const text=await readFile(path.join(cwd,k.path),'utf8'),actual=k.trim?text.trim():text;
    ok=Object.hasOwn(k,'equals')?actual===k.equals:typeof k.contains==='string'&&text.includes(k.contains);
    detail=ok?'':'File content does not match';
   }else if(k.type==='json'){
    const text=await readFile(path.join(cwd,k.path),'utf8'),value=JSON.parse(text);
    ok=!!value&&typeof value==='object'&&!Array.isArray(value);
    if(Object.hasOwn(k,'equals'))ok=ok&&isDeepStrictEqual(value,k.equals);
    else{
     ok=ok&&Array.isArray(k.keys)&&k.keys.every(key=>Object.hasOwn(value,key));
     if(k.exactKeys)ok=ok&&Object.keys(value).length===k.keys.length;
     for(const [key,wanted] of Object.entries(k.values||{}))ok=ok&&isDeepStrictEqual(value[key],wanted);
     for(const [key,length] of Object.entries(k.arrayLengths||{}))ok=ok&&Array.isArray(value[key])&&value[key].length===length;
     if(k.contains)ok=ok&&text.includes(k.contains);
    }
    detail=ok?'':'JSON keys, values or array lengths do not match';
   }else if(k.type==='artifact'){
    const a=store.list('artifact').find(x=>x.title===k.title&&sessionId&&(x.sessionId===sessionId||x.jobId===sessionId));
    ok=!!a&&typeof k.contains==='string'&&a.content.includes(k.contains)&&(!k.minVersion||a.version>=k.minVersion);
    detail=ok?'':'Artifact content or version does not match';
   }else if(k.type==='tool'){
    ok=entries.some(e=>e.type==='tool'&&e.name===k.name&&!e.error&&!e.notExecuted&&!e.interrupted&&
     (!Object.hasOwn(k,'exitCode')||e.data?.exitCode===k.exitCode)&&
     (!k.path||typeof e.args?.path==='string'&&path.resolve(cwd,e.args.path)===path.resolve(cwd,k.path)));
    detail=ok?'':'Required successful tool execution was not recorded';
   }else detail='Unknown check type';
  }catch(e){detail=e.code==='ENOENT'?'File not created':e.message;}
  results.push({...k,ok,detail});
 }
 return results;
}
