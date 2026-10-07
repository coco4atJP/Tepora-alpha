import {randomUUID} from 'node:crypto';
import {invariant} from '../policy.mjs';
import {oneLine} from '../tools/format.mjs';

/** "15:00" (today, or tomorrow when already past), "2026-10-06T15:00" (local time) or a full ISO time. */
export function parseWhen(at,now=Date.now()){
 const s=String(at||'').trim();
 const hm=/^(\d{1,2}):(\d{2})$/.exec(s);
 if(hm){const d=new Date(now);d.setHours(Number(hm[1]),Number(hm[2]),0,0);if(d.getTime()<=now)d.setDate(d.getDate()+1);return d;}
 return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s)?s+'T09:00':s);
}
/** Reminders and recurring work for the resident agent (its routines). A due item becomes an ordinary
 * input: a reminder to the main session, or the task of a new work agent. Nothing here calls a model. */
export class Scheduler{
 constructor(runtime){this.rt=runtime;this.timer=null;}
 list(){return this.rt.store.list('schedule').sort((a,b)=>a.at.localeCompare(b.at));}
 add({text,at,in_minutes,every_minutes,mode='remind',createdBy=null}){
  invariant(typeof text==='string'&&text.trim()&&text.length<=4000,'text is required (at most 4000 characters)');
  invariant(['remind','task'].includes(mode),'mode must be "remind" or "task"');
  const now=this.rt.clock();let when;
  if(in_minutes!==undefined&&in_minutes!==null){invariant(Number.isFinite(in_minutes)&&in_minutes>=0&&in_minutes<=525600,'in_minutes must be between 0 and 525600');when=new Date(now+in_minutes*60000);}
  else{invariant(typeof at==='string'&&at.trim(),'Give at (for example "15:00" or "2026-10-06T15:00") or in_minutes');when=parseWhen(at,now);invariant(!Number.isNaN(when.getTime()),`Could not read the time "${at}"`);}
  invariant(every_minutes===undefined||every_minutes===null||Number.isInteger(every_minutes)&&every_minutes>=5&&every_minutes<=525600,'every_minutes must be a whole number of at least 5');
  invariant(this.list().length<200,'At most 200 scheduled items');
  const doc={id:'sch_'+randomUUID().slice(0,8),text:text.trim(),mode,at:when.toISOString(),every:every_minutes||null,createdBy,createdAt:new Date(now).toISOString(),fired:0};
  this.rt.store.put('schedule',doc);this.rt.store.emit('schedule.updated',doc);return doc;
 }
 cancel(id){const d=this.rt.store.get('schedule',String(id||''));invariant(d,`No scheduled item ${id}`,404);this.rt.store.remove('schedule',d.id);this.rt.store.emit('schedule.updated',{...d,removed:true});return d;}
 start(){clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),15000);this.timer.unref?.();this.tick();}
 /** Fires everything due. A repeating item that was missed while the service was off fires once, then keeps its rhythm. */
 tick(){
  if(this.rt.closed)return;
  const now=this.rt.clock();
  for(const d of this.list()){
   if(Date.parse(d.at)>now)continue;
   const main=this.rt.main(),label=`scheduled ${d.mode==='task'?'task':'reminder'} ${d.id}${d.every?` (every ${d.every} min)`:''}`;
   if(d.mode==='task')this.rt.spawn(main,{task:d.text,title:oneLine(d.text,40),from:'schedule'}).catch(e=>this.rt.event(main.id,'schedule-failed',{id:d.id,message:oneLine(e.message,200)}));
   else this.rt.send(main.id,{text:d.text,from:'schedule',kind:'reminder',source:label});
   if(d.every){let next=Date.parse(d.at)+d.every*60000;if(next<=now)next=now+d.every*60000;this.rt.store.put('schedule',{...d,at:new Date(next).toISOString(),fired:d.fired+1,lastFiredAt:new Date(now).toISOString()});}
   else this.rt.store.remove('schedule',d.id);
   this.rt.store.emit('schedule.updated',{...d,fired:d.fired+1});
  }
 }
 close(){clearInterval(this.timer);}
}
export function scheduleTool(scheduler){
 const show=d=>`${d.id} ${d.mode} at ${new Date(d.at).toLocaleString('sv-SE',{hour12:false}).slice(0,16)}${d.every?` every ${d.every} min`:''}: ${oneLine(d.text,120)}`;
 return {
  name:'schedule',group:'core',
  description:'Reminders and recurring work. add: at a local time ("15:00" or "2026-10-06T15:00") or in_minutes, optionally every_minutes to repeat. mode "remind" (default) sends you the text at that time; "task" starts a work agent with the text as its task. list shows what is scheduled; cancel removes one by id.',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
   action:{type:'string',enum:['add','list','cancel']},text:{type:'string',description:'add: what to remind yourself of, or the task to start.'},
   at:{type:'string'},in_minutes:{type:'number',minimum:0},every_minutes:{type:'integer',minimum:5},mode:{type:'string',enum:['remind','task']},id:{type:'string'}}},
  summarize:a=>`schedule ${a.action}${a.text?' '+JSON.stringify(oneLine(a.text,40)):''}`,
  async run(a,ctx){
   if(a.action==='list'){const items=scheduler.list();return {text:items.length?items.map(show).join('\n'):'Nothing is scheduled.'};}
   if(a.action==='cancel'){const d=scheduler.cancel(a.id);return {text:`Cancelled ${d.id}.`};}
   const d=scheduler.add({text:a.text,at:a.at,in_minutes:a.in_minutes,every_minutes:a.every_minutes,mode:a.mode,createdBy:ctx.session.id});
   return {text:`Scheduled ${show(d)}`,data:{id:d.id,at:d.at}};
  }
 };
}
