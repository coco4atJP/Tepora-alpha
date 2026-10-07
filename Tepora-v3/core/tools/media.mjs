import {writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {invariant} from '../policy.mjs';
import {oneLine} from './format.mjs';

/** Images, speech and video through the generation endpoints connected under 「能力の接続」. The finished file is
 * saved into the session folder; a picture also comes back as an image, so a model that sees can check it. */
const EXT={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/ogg':'ogg','video/mp4':'mp4','video/webm':'webm'};
const wait=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason);},{once:true});});
export function mediaTool({media,capabilities}){
 const routes=()=>{try{return capabilities.get().routes||{};}catch{return {};}};
 const kinds=()=>['image','tts','video','image_edit'].filter(k=>routes()[k]);
 const deliver=async(job,ctx)=>{
  const asset=await media.readAsset(job.asset.id),ext=EXT[asset.mime]||'bin',dir=path.join(ctx.cwd,'media');
  await mkdir(dir,{recursive:true});const file=path.join(dir,`${job.kind}-${job.id.slice(0,8)}.${ext}`);await writeFile(file,asset.bytes);
  const image=asset.mime.startsWith('image/')&&['image/png','image/jpeg','image/webp','image/gif'].includes(asset.mime)&&asset.bytes.length<=3_500_000?[{mime:asset.mime,base64:asset.bytes.toString('base64'),name:path.basename(file)}]:undefined;
  return {text:`Ready: ${file} (${asset.mime}, ${Math.round(asset.bytes.length/1024)} KB, by ${job.provider||'?'} ${job.model||''}). Check that it matches what was asked.`,...(image?{images:image}:{}),data:{path:file,mediaId:job.id}};
 };
 return {
  name:'media',group:'core',
  available:()=>kinds().length>0,
  description:'Generate an image (kind "image"), speech audio ("tts"), a short video ("video") or an edited image ("image_edit", needs source_media_id from an earlier generation) with the connected generation services. Waits for the result (up to wait seconds) and saves it into your folder; a picture is also shown to you. status checks a generation that was still running.',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
   action:{type:'string',enum:['generate','status']},kind:{type:'string',enum:['image','tts','video','image_edit']},prompt:{type:'string'},title:{type:'string'},
   size:{type:'string',enum:['1024x1024','1536x1024','1024x1536']},duration:{type:'integer',minimum:1,maximum:15},aspect_ratio:{type:'string',enum:['16:9','9:16','1:1','4:3','3:4','3:2','2:3']},
   source_media_id:{type:'string'},id:{type:'string',description:'status: the generation id.'},wait:{type:'integer',minimum:0,maximum:900,description:'Seconds to wait for the result (default 180).'}}},
  summarize:a=>`media ${a.action}${a.kind?' '+a.kind:''}${a.prompt?' '+JSON.stringify(oneLine(a.prompt,40)):''}`,
  async run(a,ctx){
   let job;
   if(a.action==='status'){job=media.list().find(j=>j.id===a.id);invariant(job,`No generation ${a.id}`,404);}
   else{
    invariant(a.kind&&typeof a.prompt==='string'&&a.prompt.trim(),'kind and prompt are required');
    invariant(kinds().includes(a.kind),`No service is connected for "${a.kind}". Connected: ${kinds().join(', ')||'none'}.`,409);
    const source=a.source_media_id?media.list().find(j=>j.id===a.source_media_id)?.asset?.id:null;
    job=media.create({kind:a.kind,prompt:a.prompt,title:a.title||oneLine(a.prompt,60),requestId:randomUUID(),profileIdentity:capabilities.pin(a.kind).identity,sourceAssetId:source||null,
     options:{...(a.size?{size:a.size}:{}),...(a.duration?{duration:a.duration}:{}),...(a.aspect_ratio?{aspectRatio:a.aspect_ratio}:{})}});
   }
   const until=Date.now()+(a.wait??180)*1000;
   while(!['ready','failed','cancelled'].includes(job.status)&&Date.now()<until){await wait(1000,ctx.signal);job=media.list().find(j=>j.id===job.id)||job;}
   if(job.status==='ready')return deliver(job,ctx);
   if(['failed','cancelled'].includes(job.status))invariant(false,`The generation ${job.status}: ${job.note||''}`,502);
   return {text:`Still generating (${job.status}${job.note?': '+job.note:''}). Check later with media status, id "${job.id}".`,data:{mediaId:job.id,status:job.status}};
  }
 };
}
