import {randomUUID,createHash} from 'node:crypto';
import {invariant,text} from './policy.mjs';
import {destination} from './context.mjs';

export function validateSchedule(input) {
  invariant(input&&typeof input==='object','A schedule is required');
  if(input.type==='once'){
    invariant(typeof input.at==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.at)&&Number.isFinite(Date.parse(input.at)),'Use an ISO date/time with timezone');
    return {type:'once',at:new Date(input.at).toISOString()};
  }
  if(input.type==='interval'){
    invariant(Number.isInteger(input.minutes)&&input.minutes>=5&&input.minutes<=525600,'Interval must be 5 minutes to one year');
    return {type:'interval',minutes:input.minutes};
  }
  invariant(input.type==='daily'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time),'Daily time must be HH:mm');
  invariant(typeof input.timezone==='string','Choose an explicit timezone');
  try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format();}catch{throw new Error('Unknown timezone');}
  const weekdays=input.weekdays||[0,1,2,3,4,5,6];
  invariant(Array.isArray(weekdays)&&weekdays.length>0&&weekdays.length<=7&&weekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6),'Invalid weekdays');
  return {type:'daily',time:input.time,timezone:input.timezone,weekdays:[...new Set(weekdays)]};
}
export function nextOccurrence(schedule,after) {
  if(schedule.type==='once')return Date.parse(schedule.at)>after?Date.parse(schedule.at):null;
  if(schedule.type==='interval')return after+schedule.minutes*60000;
  // First matching wall-clock minute, including DST. Missing minutes are skipped, not guessed.
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',weekday:'short'});
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for(let t=Math.floor(after/60000)*60000+60000,end=t+8*86400000;t<end;t+=60000){
    const p=Object.fromEntries(fmt.formatToParts(t).map(p=>[p.type,p.value]));
    if(`${p.hour}:${p.minute}`===schedule.time&&schedule.weekdays.includes(days.indexOf(p.weekday)))return t;
  }
  throw new Error('Unable to resolve daily schedule');
}
const jobId=(routineId,due)=>'routine-'+createHash('sha256').update(`${routineId}:${due}`).digest('hex').slice(0,40);
const busy=new Set(['queued','running','waiting_approval','paused','interrupted','blocked']);

export class Routines {
  constructor(store,harness,{clock=()=>Date.now(),intervalMs=15000}={}) {
    Object.assign(this,{store,harness,clock,intervalMs});this.closed=false;this.ticking=false;
  }
  save(input,id=null,expectedRevision) {
    const previous=id?this.store.get('routine',id):null;
    invariant(!id||previous,'Routine not found',404);
    if(previous)invariant(previous.revision===expectedRevision,'Routine changed; reload before saving',409);
    const schedule=validateSchedule(input.schedule),now=this.clock();
    if(schedule.type==='once')invariant(Date.parse(schedule.at)>now,'The requested time is in the past');
    const r={id:id||randomUUID(),title:text(input.title,'title',120),input:text(input.input),schedule,
      enabled:false,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||new Date(now).toISOString(),
      catchUp:input.catchUp==='skip'?'skip':'latest',graceMs:Math.min(86400000,Math.max(60000,Number(input.graceMs)||3*3600000)),
      lastJobId:previous?.lastJobId||null,lastOccurrence:previous?.lastOccurrence||null,status:'proposed'};
    this.store.put('routine',r);this.store.emit('routine.updated',r);return r;
  }
  enable(id,enabled,expectedRevision) {
    const r=this.store.get('routine',id);invariant(r,'Routine not found',404);
    invariant(typeof enabled==='boolean'&&r.revision===expectedRevision,'Routine changed or invalid enabled value',409);
    r.schedule=validateSchedule(r.schedule);text(r.input);text(r.title,'title',120);
    r.enabled=enabled;r.revision++;r.status=enabled?'scheduled':'paused';
    if(enabled){
      r.nextAt=nextOccurrence(r.schedule,this.clock());invariant(r.nextAt!==null,'The one-shot time has passed');
      r.runtime=structuredClone(this.store.settings);r.routeSnapshot=this.harness.registry?.configured?this.harness.registry.pin('work'):null;r.destination=r.routeSnapshot?.id||destination(r.runtime);
      r.consentEpoch=this.store.value('consent-epoch')||0;
    }
    this.store.put('routine',r);this.store.emit('routine.updated',r);return r;
  }
  start(){this.timer=setInterval(()=>{try{this.tick();}catch{}},this.intervalMs);this.timer.unref?.();}
  tick() {
    if(this.closed||this.ticking)return;this.ticking=true;
    try {
      const now=this.clock();
      for(const r of this.store.list('routine')){
        if(!r.enabled||r.nextAt>now||!Number.isFinite(r.nextAt))continue;
        if(r.consentEpoch!==(this.store.value('consent-epoch')||0)||r.destination!==(this.harness.registry?.configured?this.harness.registry.pin('work').id:destination(this.store.settings))){
          r.enabled=false;r.status='needs-consent';r.note='接続先または権限が変わりました。再確認するまで実行しません。';this.persist(r);continue;
        }
        if(busy.has(this.store.get('job',r.lastJobId)?.status)){
          if(r.status!=='previous-job-pending'){r.status='previous-job-pending';this.persist(r);}continue;
        }
        let due=r.nextAt;
        if(r.schedule.type==='interval'&&r.catchUp==='latest')due+=Math.floor((now-due)/(r.schedule.minutes*60000))*r.schedule.minutes*60000;
        if(r.schedule.type==='daily'&&r.catchUp==='latest'){
          const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:r.schedule.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',weekday:'short'});
          const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          for(let candidate=Math.floor(now/60000)*60000,stop=Math.max(due,candidate-8*86400000);candidate>=stop;candidate-=60000){
            const p=Object.fromEntries(fmt.formatToParts(candidate).map(p=>[p.type,p.value]));
            if(`${p.hour}:${p.minute}`===r.schedule.time&&r.schedule.weekdays.includes(days.indexOf(p.weekday))){due=candidate;break;}
          }
        }
        // Skip duplicate wall-clock dates in the autumn DST repeated hour.
        const day=r.schedule.type==='daily'?new Intl.DateTimeFormat('en-CA',{timeZone:r.schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(due):null;
        const missed=now-due>r.graceMs||r.catchUp==='skip'&&now-due>60000||day&&day===r.lastLocalDay;
        if(!missed){
          const id=jobId(r.id,due);
          // Deterministic job identity closes the crash gap between submitting and saving nextAt.
          const existing=this.store.get('job',id);
          if(!existing){
            try {this.harness.submit(r.input,'work',{id,runtime:r.runtime,routeSnapshot:r.routeSnapshot,routineId:r.id,isolated:true,priority:-1});}
            catch(e){r.note=String(e.message).slice(0,300);r.status='backpressured';this.persist(r);continue;}
          }
          r.lastJobId=id;r.lastOccurrence=due;r.lastLocalDay=day;r.status='submitted';
        }else{r.status='missed';r.note='休止中の実行時刻を過ぎました。過去の仕事を大量には実行しません。';}
        r.nextAt=nextOccurrence(r.schedule,now);if(r.nextAt===null)r.enabled=false;
        this.persist(r);
      }
    } finally {this.ticking=false;}
  }
  persist(r){this.store.put('routine',r);this.store.emit('routine.updated',r);}
  pauseAll(){for(const r of this.store.list('routine'))if(r.enabled){r.enabled=false;r.status='paused';r.revision++;this.persist(r);}}
  close(){this.closed=true;clearInterval(this.timer);}
}
