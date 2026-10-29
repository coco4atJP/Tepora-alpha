/** A scripted tool-calling model for the shared canvas. Not an LLM: it answers by keyword so tests and
 * screen captures can drive the real agent loop, tool routing, policy and canvas board end to end. */
export const CANVAS_ROCKET='<svg data-id="scene" viewBox="0 0 800 600" width="100%" height="100%"><rect data-id="sky" width="800" height="600" fill="#0b1030"/><g data-id="stars" fill="#fff"><circle cx="90" cy="80" r="2"/><circle cx="700" cy="120" r="2.5"/><circle cx="620" cy="460" r="1.8"/><circle cx="160" cy="420" r="2.2"/></g><circle data-id="moon" cx="660" cy="110" r="44" fill="#f5e7b2"/><g data-id="rocket"><path data-id="body" d="M400 110 C450 170 456 300 440 380 L360 380 C344 300 350 170 400 110 Z" fill="#e9edf5"/><circle data-id="window" cx="400" cy="230" r="28" fill="#4fa3e0" stroke="#5b6b85" stroke-width="6"/><path data-id="fin-left" d="M360 330 L318 410 L362 384 Z" fill="#d9534f"/><path data-id="fin-right" d="M440 330 L482 410 L438 384 Z" fill="#d9534f"/><path data-id="flame" d="M372 384 Q400 500 428 384 Z" fill="#f3b23c"/></g><text data-id="title" x="400" y="560" text-anchor="middle" fill="#cfd7ff" font-size="28">夜空を飛ぶロケット</text></svg>';
export const CANVAS_CIRCUIT='<svg data-id="circuit" viewBox="0 0 800 600" width="100%" height="100%"><rect data-id="paper" width="800" height="600" fill="#fbfaf5"/><g data-id="wires" stroke="#333" stroke-width="5" fill="none"><path d="M160 160 H640 V440 H160 Z"/></g><g data-id="battery"><rect x="130" y="260" width="60" height="80" fill="#fbfaf5"/><line x1="130" y1="280" x2="190" y2="280" stroke="#333" stroke-width="6"/><line x1="145" y1="320" x2="175" y2="320" stroke="#333" stroke-width="6"/><text x="70" y="305" font-size="22">9V</text></g><g data-id="resistor"><rect x="330" y="140" width="140" height="40" fill="#e9d9a8" stroke="#333" stroke-width="4"/><text x="360" y="125" font-size="22">R1 330Ω</text></g><g data-id="led"><path d="M620 270 L660 270 L640 310 Z" fill="#e8463b" stroke="#333" stroke-width="4"/><line x1="618" y1="312" x2="662" y2="312" stroke="#333" stroke-width="4"/><text x="676" y="300" font-size="22">D1 LED</text></g><text data-id="caption" x="400" y="540" text-anchor="middle" font-size="26" fill="#333">LEDを光らせる回路</text></svg>';
const text=m=>typeof m?.content==='string'?m.content:(m?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
/** Everything the model was told since its last reply, oldest first. */
const pending=body=>{const out=[];for(let i=body.messages.length-1;i>0;i--){const m=body.messages[i];if(m.role==='assistant')break;out.unshift(m);}return out;};
export function canvasModel({seen=[]}={}){
 return body=>{
  const system=text(body.messages[0]),main=/chief of staff/.test(system),fresh=pending(body),tool=fresh.findLast(m=>m.role==='tool');
  const said=fresh.filter(m=>m.role==='user').map(text).join('\n');
  seen.push({session:main?'main':'worker',context:said,tools:(body.tools||[]).map(t=>t.function.name)});
  if(tool){
   const r=text(tool);
   if(main&&/^Drew v/m.test(r))return {content:'夜空を飛ぶロケットを描きました。気になるところをクリックして「これ」と言ってください。'};
   if(main&&/^Made v/m.test(r))return {content:/星/.test(r)?'星を増やしてにぎやかにしました。':'選んでくれたところを赤くしました。'};
   if(main)return {content:'仕事として回路図を頼みました。キャンバスに描いていきます。'};
   return {content:'LEDの回路図をキャンバスに描きました。'};
  }
  if(!main)return {calls:[{name:'canvas',args:{action:'create',summary:'LED回路図',html:CANVAS_CIRCUIT}}]};
  if(/report from|報告/.test(said)&&!/描いて|赤く|星/.test(said.split('\n').at(-1)))return {content:'回路図ができています。'};
  if(/回路/.test(said))return {calls:[{name:'sessions_spawn',args:{task:'Draw a simple circuit diagram that lights an LED (9V battery, 330Ω resistor, LED) on the shared canvas.',title:'LED回路図'}}]};
  if(/ロケット/.test(said))return {calls:[{name:'canvas',args:{action:'create',summary:'夜空を飛ぶロケット',html:CANVAS_ROCKET}}]};
  if(/赤く/.test(said)){const id=/selected "([^"]+)"/.exec(said)?.[1]||'flame';return {calls:[{name:'canvas',args:{action:'patch',summary:`${id}を赤く`,ops:[{op:'set',id,attrs:{fill:'#e5322d'}}]}}]};}
  if(/星/.test(said))return {calls:[{name:'canvas',args:{action:'patch',summary:'星を増やす',ops:[{op:'add',parent:'stars',html:'<circle cx="250" cy="150" r="3"/><circle cx="540" cy="60" r="2.6"/><circle cx="300" cy="500" r="2.4"/><circle cx="740" cy="330" r="3"/><circle cx="60" cy="260" r="2.6"/>'},{op:'set',id:'stars',attrs:{fill:'#fff6c8'}}]}}]};
  return {content:'はい。'};
 };
}
