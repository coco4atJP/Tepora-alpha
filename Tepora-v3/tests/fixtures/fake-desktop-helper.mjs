// A stand-in for tepora-desktop-helper speaking the desktop-contract.json JSON-lines protocol.
import readline from 'node:readline';
const sent=[];
const reply=m=>process.stdout.write(JSON.stringify(m)+'\n');
process.stdout.write('helper banner that is not JSON\n');
reply({id:999999,ok:true,result:'nobody asked'});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);sent.push(r);
 const ok=result=>reply({id:r.id,ok:true,result}),fail=error=>reply({id:r.id,ok:false,error});
 switch(r.cmd){
  case 'status':return ok({backend:'linux-x11',accessibility:true,input:true,capture:false,problem:null});
  case 'windows':return ok({windows:[{pid:42,app:'Fixture',title:'Main',active:true}]});
  case 'observe':return ok({title:'Main',elements:[{ref:'e1',role:'button',name:'Save',inView:true},{ref:'e2',role:'password',name:'PIN',value:'••••',inView:true},{ref:'e3',role:'combobox',name:'Size',value:'One',inView:true}],text:'Ready'});
  case 'press':return r.ref==='e404'?fail('No element e404 in the latest observation. Observe again.'):ok({});
  case 'sent':return ok({sent:sent.slice(0,-1).map(({id,...rest})=>rest)});
  default:return ok({});
 }
});
