/** Music from this PC for the home monitor. Files are read in place through blob URLs and are
 * never uploaded or copied; the list lasts while the window stays open.
 */
const MUSIC_FILES=/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;
export function createMusic({onChange=()=>{}}={}){
 const audio=new Audio();audio.preload='metadata';
 let tracks=[],index=0,last=0;
 const state=()=>({track:tracks[index]||null,index,count:tracks.length,playing:!audio.paused&&!!tracks.length,progress:audio.duration?audio.currentTime/audio.duration:0});
 const emit=()=>onChange(state());
 const release=()=>{for(const t of tracks)URL.revokeObjectURL(t.url);};
 function load(files){
  const chosen=[...files].filter(f=>f.type.startsWith('audio/')||MUSIC_FILES.test(f.name)).slice(0,300);
  if(!chosen.length)throw new Error('音楽ファイル（mp3・m4a・flac など）を選んでください。');
  audio.pause();release();tracks=chosen.map(f=>({title:f.name.replace(/\.[^.]+$/,''),url:URL.createObjectURL(f)}));index=0;play();
 }
 function play(at=index){if(!tracks.length)return;index=((at%tracks.length)+tracks.length)%tracks.length;if(audio.src!==tracks[index].url)audio.src=tracks[index].url;audio.play().catch(()=>emit());}
 audio.addEventListener('play',emit);audio.addEventListener('pause',emit);
 audio.addEventListener('ended',()=>{if(index<tracks.length-1)play(index+1);else emit();});
 audio.addEventListener('timeupdate',()=>{const now=Date.now();if(now-last>1000){last=now;emit();}});
 return {
  state,
  choose(){return new Promise((resolve,reject)=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus';
   input.onchange=()=>{try{load(input.files||[]);resolve(state());}catch(e){reject(e);}};input.addEventListener('cancel',()=>resolve(state()),{once:true});input.click();});},
  toggle(){if(!tracks.length)return;audio.paused?play():audio.pause();},
  next(){play(index+1);},prev(){audio.currentTime>4?(audio.currentTime=0):play(index-1);},
  pause(){audio.pause();},
  clear(){audio.pause();audio.removeAttribute('src');release();tracks=[];index=0;emit();}
 };
}
