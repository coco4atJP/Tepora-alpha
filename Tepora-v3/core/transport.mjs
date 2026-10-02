import {invariant} from './policy.mjs';
/** Bound decoded responses before JSON.parse. Don't allocate an arbitrary provider body. */
export async function boundedJSON(response,{maxBytes=2_000_000}={}){
 invariant(response.body,'Provider response has no body',502);
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,value='';
 try{
  while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;
   invariant(bytes<=maxBytes,'Provider response exceeds the response-size limit',502);value+=decoder.decode(item.value,{stream:true});}
  value+=decoder.decode();return JSON.parse(value);
 }catch(e){await reader.cancel().catch(()=>{});throw e;}
 finally{reader.releaseLock();}
}
