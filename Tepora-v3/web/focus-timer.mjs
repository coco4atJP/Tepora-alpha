/** A window-local countdown. Repaints never advance time; delayed callbacks use the deadline.
 * No scheduling, persistence, permissions or automatic restart is owned here.
 */
export function createFocusTimer({minutes=25,now=()=>Date.now()}={}){
 const checked=value=>{if(!Number.isInteger(value)||value<5||value>90)throw new RangeError('Invalid focus timer minutes');return value;};
 let duration=checked(minutes),configured=duration,remainingMs=duration*60000,deadline=0,running=false,completed=0;
 const tick=()=>{
  if(!running)return false;
  remainingMs=Math.max(0,deadline-now());
  if(remainingMs>0)return false;
  running=false;completed++;remainingMs=duration*60000;deadline=0;return true;
 };
 const reset=()=>{running=false;remainingMs=duration*60000;deadline=0;};
 return {
  tick,
  snapshot:()=>({minutes:duration,remainingSeconds:Math.ceil(remainingMs/1000),running,completed}),
  toggle(){tick();running=!running;if(running)deadline=now()+remainingMs;},
  reset,
  setMinutes(value){duration=checked(value);configured=duration;reset();},
  sync(value){checked(value);if(!running&&value!==configured){duration=value;configured=value;reset();}}
 };
}
