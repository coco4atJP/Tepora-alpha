import {btn} from './ui.mjs';
/** Browser handoff uses only an active attempt ID. URLs stay owned by the service. */
export function createAuthBrowser({bridge,endpoint,hostId,action,previewMode,visible}){
 let id=null,ready=false,autoId=null,version=0,opening=false,opened=false,message='';
 const host=()=>document.getElementById(hostId);
 function reset(){version++;id=null;ready=false;autoId=null;opening=false;opened=false;message='';}
 function paint(){
  const el=host();if(!el)return;
  if(!ready){el.replaceChildren();return;}
  if(!el.querySelector('button'))el.innerHTML=`${btn(action,'認証ページを開く','external','button secondary')}<p class="small-text" role="status"></p>`;
  const button=el.querySelector('button'),status=el.querySelector('[role=status]');
  button.disabled=opening||previewMode;button.querySelector('span').textContent=opening?'ブラウザーを開いています…':opened?'認証ページをもう一度開く':'認証ページを開く';
  status.textContent=message;status.hidden=!message;
 }
 async function open(){
  if(previewMode||!id||!ready||opening||!visible())return;
  autoId=null;const current=version,attempt=id;opening=true;message='';paint();
  try{
   await bridge.request(endpoint,'POST',{id:attempt});
   if(current!==version||!visible())return;
   opened=true;message='既定のブラウザーでログインを進めてください。完了したら、この画面に戻ってください。';
  }catch{
   if(current!==version||!visible())return;
   message='ブラウザーを開けませんでした。ボタンからもう一度お試しください。';
  }finally{if(current===version){opening=false;if(visible())paint();}}
 }
 return {
  reset,
  started(attempt){reset();autoId=attempt;},
  update(pending,canOpen){
   const next=pending?.status==='pending'?pending.id:null;
   if(id!==next){version++;id=next;opening=false;opened=false;message='';}
   ready=Boolean(id&&canOpen);paint();
   if(ready&&autoId===id&&visible()){autoId=null;void open();}
  },
  open
 };
}
