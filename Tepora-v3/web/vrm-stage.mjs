/** Optional VRM avatar stage. Loaded only after the person selects a local VRM model.
 * The model bytes come from this PC (/api/character/model); the pinned renderer files live in
 * ./vendor. The avatar mirrors the same moods as the built-in character: idle, listening,
 * thinking, talking, happy, attention, sleepy.
 */
import * as THREE from './vendor/three.module.js';
import {GLTFLoader} from './vendor/GLTFLoader.js';
import {VRMLoaderPlugin,VRMUtils} from './vendor/three-vrm.module.min.js';

const MOOD_EXPRESSIONS={
 idle:{},listening:{relaxed:.25},thinking:{relaxed:.15},talking:{happy:.18},happy:{happy:.85},
 attention:{surprised:.35},concerned:{sad:.3},sleepy:{relaxed:.6}
};
const EXPRESSIONS=['happy','relaxed','surprised','sad','angry','aa','ih','ou','ee','oh','blink'];
const ease=(from,to,rate,dt)=>from+(to-from)*(1-Math.exp(-rate*dt));

export async function createVRMStage(host,{url='/api/character/model',reducedMotion=false}={}){
 const canvas=document.createElement('canvas');canvas.className='vrm-canvas';canvas.setAttribute('aria-hidden','true');
 let renderer;
 try{renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});}
 catch{throw new Error('この端末ではWebGLを使えないため、3Dモデルを表示できません。');}
 renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(24,1,.1,30);
 scene.add(new THREE.HemisphereLight(0xfff6ea,0x8a7f72,1.6));
 const key=new THREE.DirectionalLight(0xffffff,2.1);key.position.set(.8,1.6,2.4);scene.add(key);
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
 if(!response.ok)throw new Error('保存したモデルを読み込めませんでした。');
 const loader=new GLTFLoader();loader.register(parser=>new VRMLoaderPlugin(parser));
 const gltf=await loader.parseAsync(await response.arrayBuffer(),'');
 const vrm=gltf.userData.vrm;if(!vrm)throw new Error('VRMとして読み込めませんでした。');
 VRMUtils.removeUnnecessaryVertices(gltf.scene);VRMUtils.combineSkeletons?.(gltf.scene);VRMUtils.rotateVRM0(vrm);
 vrm.scene.traverse(o=>{o.frustumCulled=false;});scene.add(vrm.scene);host.append(canvas);
 const bone=name=>vrm.humanoid?.getNormalizedBoneNode(name)||null;
 const bones={hips:bone('hips'),spine:bone('spine'),chest:bone('chest')||bone('upperChest'),neck:bone('neck'),head:bone('head'),
  leftUpperArm:bone('leftUpperArm'),rightUpperArm:bone('rightUpperArm'),leftLowerArm:bone('leftLowerArm'),rightLowerArm:bone('rightLowerArm')};
 const has=new Set(EXPRESSIONS.filter(name=>vrm.expressionManager?.getExpression(name)));
 const set=(name,value)=>{if(has.has(name))vrm.expressionManager.setValue(name,Math.max(0,Math.min(1,value)));};
 // Frame from the waist up so the face reads well on a monitor across the room.
 vrm.scene.updateMatrixWorld(true);
 const headY=bones.head?bones.head.getWorldPosition(new THREE.Vector3()).y:1.4,hipY=bones.hips?bones.hips.getWorldPosition(new THREE.Vector3()).y:.9;
 const top=headY+.24,bottom=hipY-.12,focusY=(top+bottom)/2,halfHeight=(top-bottom)/2;
 const look=new THREE.Object3D();scene.add(look);if(vrm.lookAt){vrm.lookAt.target=look;vrm.lookAt.autoUpdate=true;}
 let mood='idle',level=0,talk=0,pointer={x:0,y:0},eye={x:0,y:0},nextBlink=1.5,blink=0,frame=0,disposed=false,visible=true;
 const weights=Object.fromEntries(EXPRESSIONS.map(name=>[name,0]));
 const clock=new THREE.Clock();
 let distance=2;
 const resize=()=>{const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;
  // Fit head-to-waist vertically and the shoulders horizontally, whichever is tighter.
  const half=Math.tan(camera.fov*Math.PI/360);distance=Math.max(halfHeight/half,.42/(half*camera.aspect))*1.08;
  camera.position.set(0,focusY+.02,distance);camera.lookAt(0,focusY,0);camera.updateProjectionMatrix();};
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 const seen=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);});seen.observe(host);
 function tick(){
  if(disposed)return;frame=requestAnimationFrame(tick);
  const dt=Math.min(clock.getDelta(),.1),t=clock.elapsedTime;
  if(!visible||document.hidden)return;
  const motion=reducedMotion?0:1,sleepy=mood==='sleepy';
  // Arms rest along the body instead of the T-pose stored in the file.
  if(bones.leftUpperArm)bones.leftUpperArm.rotation.z=-1.18+Math.sin(t*1.1)*.015*motion;
  if(bones.rightUpperArm)bones.rightUpperArm.rotation.z=1.18-Math.sin(t*1.1)*.015*motion;
  if(bones.leftLowerArm)bones.leftLowerArm.rotation.z=-.12;if(bones.rightLowerArm)bones.rightLowerArm.rotation.z=.12;
  const breathe=Math.sin(t*(sleepy?.9:1.6))*(sleepy?.03:.02)*motion;
  if(bones.chest)bones.chest.rotation.x=breathe+(mood==='listening'?.05:0);
  if(bones.spine)bones.spine.rotation.z=Math.sin(t*.45)*.012*motion+(mood==='thinking'?.03:0);
  eye.x=ease(eye.x,pointer.x,4,dt);eye.y=ease(eye.y,pointer.y,4,dt);
  if(bones.neck)bones.neck.rotation.y=eye.x*.18;
  if(bones.head){bones.head.rotation.y=eye.x*.22+Math.sin(t*.37)*.04*motion;bones.head.rotation.x=-eye.y*.12+(sleepy?.18:0)+Math.sin(t*.6)*.015*motion;bones.head.rotation.z=(mood==='thinking'?.09:mood==='listening'?-.05:0)+Math.sin(t*.29)*.02*motion;}
  look.position.set(eye.x*.6,focusY+.05+eye.y*.35,distance);
  // Natural blinking; eyes stay closed while sleepy.
  nextBlink-=dt;if(nextBlink<=0){blink=1;nextBlink=2+Math.random()*4;}
  blink=Math.max(0,blink-dt*7);
  const targets={...MOOD_EXPRESSIONS[mood]};
  talk=ease(talk,mood==='talking'?Math.max(level,.15+Math.abs(Math.sin(t*11))*.45*motion):level,18,dt);
  targets.aa=talk*.9;targets.oh=talk*.25*Math.abs(Math.sin(t*3.1));
  targets.blink=sleepy?1:Math.sin(Math.min(blink,1)*Math.PI);
  for(const name of EXPRESSIONS){weights[name]=ease(weights[name],targets[name]||0,name==='blink'?40:8,dt);set(name,weights[name]);}
  vrm.update(dt);renderer.render(scene,camera);
 }
 tick();
 return {
  kind:'vrm',meta:vrm.meta,
  setMood(next){mood=MOOD_EXPRESSIONS[next]?next:'idle';},
  setLook(x,y){pointer={x:Math.max(-1,Math.min(1,x)),y:Math.max(-1,Math.min(1,y))};},
  setLevel(value){level=Math.max(0,Math.min(1,Number(value)||0));},
  destroy(){disposed=true;cancelAnimationFrame(frame);observer.disconnect();seen.disconnect();VRMUtils.deepDispose(vrm.scene);renderer.dispose();canvas.remove();}
 };
}
