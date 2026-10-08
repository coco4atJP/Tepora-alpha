/** One cleanup owner per test: close every service, including restarts, before removing data. */
import {rm} from 'node:fs/promises';
const owners=new WeakMap();
export function serviceCleanup(t){
 if(owners.has(t))return owners.get(t);
 const closes=[],directories=new Set();
 const owner={
  directory(dir){directories.add(dir);return dir;},
  service(app){
   let closing;
   const close=()=>closing??=Promise.resolve().then(()=>app.close());
   closes.push(close);return {...app,close};
  },
 };
 // Register before any service starts. A failed bootstrap still closes its server.
 t.after(async()=>{
  const errors=[];
  for(const close of closes)try{await close();}catch(error){errors.push(error);}
  // Do not remove a database if its owner's close failed; report every close error instead.
  if(!errors.length)for(const dir of directories)try{await rm(dir,{recursive:true,force:true});}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Service fixture cleanup failed');
 });
 owners.set(t,owner);return owner;
}
