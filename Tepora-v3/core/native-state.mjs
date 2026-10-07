/** The migration boundary: Rust owns persistence; JavaScript owns service callbacks.
 * There is deliberately no JavaScript fallback: a missing/failed native core must
 * never silently switch storage engines or create a second connection.
 */
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let StateCore;
try { ({StateCore}=require('./native/tepora_core.node')); }
catch(cause) {
 throw new Error('Tepora Rust core is unavailable. Run npm run build:core with the Rust toolchain installed, then restart Tepora.',{cause});
}
export class NativeState {
 constructor(filename){this.core=new StateCore(filename);}
 call(operation,payload={}) {
  try {return JSON.parse(this.core.call(operation,JSON.stringify(payload)));}
  catch(error){
   const match=/^\[(\d{3})\]\s*(.*)$/s.exec(error.message);
   if(match){error.status=Number(match[1]);error.message=match[2];}
   throw error;
  }
 }
 /** Compatibility for existing transactions and diagnostic SQL. Domain writes
  * use the Rust operations above, on this same connection, not a JS SQL driver. */
 exec(sql){return this.call('exec',{sql});}
 prepare(sql){
  const query=(mode,args)=>this.call('sql',{sql,args,mode});
  return {run:(...args)=>query('run',args),get:(...args)=>query('get',args)??undefined,
   all:(...args)=>query('all',args),iterate:(...args)=>query('all',args)[Symbol.iterator]()};
 }
 close(){return this.call('close');}
}
