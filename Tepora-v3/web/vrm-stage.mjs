/** A 3D avatar from a VRM model the person brought. Loaded only when they have chosen one.
 * The model's bytes come from this PC (the service's asset route); the pinned renderer files live in ./vendor.
 * It reads the same pose vector as every other body: mood and loudness in, expressions, posture, gaze and lips out.
 * It draws at 30 frames a second while nothing is happening, and stops when the window is hidden or off screen.
 */
import * as THREE from './vendor/three.module.js';
import {GLTFLoader} from './vendor/GLTFLoader.js';
import {VRMLoaderPlugin,VRMUtils} from './vendor/three-vrm.module.min.js';

const EXPRESSIONS=['happy','relaxed','surprised','sad','angry','aa','ih','ou','ee','oh','blink'];
const LIGHTS={
 light:{sky:0xfff6ea,ground:0x8a7f72,hemi:1.6,key:2.1,tint:0xffffff},
 dark:{sky:0xe8dccd,ground:0x4a4036,hemi:1.15,key:1.5,tint:0xffeedd},
 lamp:{sky:0xffd9b0,ground:0x2a1e16,hemi:.75,key:1.35,tint:0xffc488}
};
const ease=(from,to,rate,dt)=>from+(to-from)*(1-Math.exp(-rate*dt));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const FALLBACK_POSE={energy:.35,valence:.1,alert:.2,focus:0,lamp:.25,near:.45,speech:0};

export async function createVRMAvatar(host,{url,spec,reducedMotion=false,theme='light',signal,framing='bust',moodPose=()=>FALLBACK_POSE,follow=true}={}){
 const gain={calm:.6,normal:1,lively:1.3}[spec?.motion]||1;   // 動き: how much it sways, breathes and turns
 const canvas=document.createElement('canvas');canvas.className='vrm-canvas';canvas.setAttribute('aria-hidden','true');
 let renderer;
 try{renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});}
 catch{throw new Error('この端末ではWebGLを使えないため、3Dモデルを表示できません。');}
 renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(24,1,.1,30);
 const hemi=new THREE.HemisphereLight(0xfff6ea,0x8a7f72,1.6),key=new THREE.DirectionalLight(0xffffff,2.1);key.position.set(.8,1.6,2.4);scene.add(hemi,key);
 const lights=name=>{const l=LIGHTS[name]||LIGHTS.light;hemi.color.setHex(l.sky);hemi.groundColor.setHex(l.ground);hemi.intensity=l.hemi;key.color.setHex(l.tint);key.intensity=l.key;};lights(theme);
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store',signal});
 if(!response.ok){renderer.dispose();throw new Error('保存したモデルを読み込めませんでした。');}
 const loader=new GLTFLoader();loader.register(parser=>new VRMLoaderPlugin(parser));
 let gltf;try{gltf=await loader.parseAsync(await response.arrayBuffer(),'');}catch(e){renderer.dispose();throw new Error('VRMとして読み込めませんでした。');}
 const vrm=gltf.userData.vrm;if(!vrm){renderer.dispose();throw new Error('VRMとして読み込めませんでした。');}
 if(signal?.aborted){VRMUtils.deepDispose(gltf.scene);renderer.dispose();throw Object.assign(new Error('aborted'),{aborted:true});}
 VRMUtils.removeUnnecessaryVertices(gltf.scene);VRMUtils.combineSkeletons?.(gltf.scene);VRMUtils.rotateVRM0(vrm);
 vrm.scene.traverse(o=>{o.frustumCulled=false;});scene.add(vrm.scene);host.append(canvas);
 const bone=name=>vrm.humanoid?.getNormalizedBoneNode(name)||null;
 const bones={hips:bone('hips'),spine:bone('spine'),chest:bone('chest')||bone('upperChest'),neck:bone('neck'),head:bone('head'),
  leftUpperArm:bone('leftUpperArm'),rightUpperArm:bone('rightUpperArm'),leftLowerArm:bone('leftLowerArm'),rightLowerArm:bone('rightLowerArm')};
 // A VRM 0.x model's normalized bones are turned half a circle about Y: turns about X and Z run the other way.
 const f=vrm.meta?.metaVersion==='0'?-1:1;
 const has=new Set(EXPRESSIONS.filter(name=>vrm.expressionManager?.getExpression(name)));
 const set=(name,value)=>{if(has.has(name))vrm.expressionManager.setValue(name,clamp(value,0,1));};
 // Frame from the waist up so the face reads well from across the room, or the whole body.
 vrm.scene.updateMatrixWorld(true);
 const headY=bones.head?bones.head.getWorldPosition(new THREE.Vector3()).y:1.4,hipY=bones.hips?bones.hips.getWorldPosition(new THREE.Vector3()).y:.9;
 const top=headY+(framing==='full'?.3:.24),bottom=framing==='full'?-.02:hipY-.12,focusY=(top+bottom)/2,halfHeight=(top-bottom)/2,halfWidth=framing==='full'?.55:.42;
 const look=new THREE.Object3D();scene.add(look);if(vrm.lookAt){vrm.lookAt.target=look;vrm.lookAt.autoUpdate=true;}
 let mood='idle',level=0,talk=0,pointer={x:0,y:0},eye={x:0,y:0},nextBlink=1.5,blink=0,frame=0,disposed=false,visible=true,reduced=reducedMotion,last=0,pointerTimer=0;
 const weights=Object.fromEntries(EXPRESSIONS.map(name=>[name,0]));
 let distance=2,elapsed=0;
 const resize=()=>{
  const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;
  const half=Math.tan(camera.fov*Math.PI/360);distance=Math.max(halfHeight/half,halfWidth/(half*camera.aspect))*1.08;
  camera.position.set(0,focusY+.02,distance);camera.lookAt(0,focusY,0);camera.updateProjectionMatrix();
 };
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 const seen=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);});seen.observe(host);
 const onPointer=e=>{
  if(reduced)return;const r=host.getBoundingClientRect();if(!r.width)return;
  const x=(e.clientX-(r.left+r.width/2))/Math.max(260,innerWidth/2),y=(e.clientY-(r.top+r.height*.3))/Math.max(220,innerHeight/2);
  pointer={x:clamp(x,-1,1),y:clamp(y,-1,1)};clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointer={x:0,y:0};},4000);
 };
 if(follow)window.addEventListener('pointermove',onPointer,{passive:true});
 function tick(now){
  if(disposed)return;frame=requestAnimationFrame(tick);
  if(!visible||document.hidden){last=now;return;}
  const busy=mood==='talking'||mood==='listening'||mood==='happy';
  if(!busy&&now-last<33)return;
  const dt=clamp((now-last)/1000,.001,.1),motion=reduced?0:gain,sleepy=mood==='sleepy',pose=moodPose(mood,level);elapsed+=dt;const t=elapsed;
  // Arms rest along the body instead of the T-pose stored in the file.
  if(bones.leftUpperArm)bones.leftUpperArm.rotation.z=f*(-1.18+Math.sin(t*1.1)*.015*motion);
  if(bones.rightUpperArm)bones.rightUpperArm.rotation.z=f*(1.18-Math.sin(t*1.1)*.015*motion);
  if(bones.leftLowerArm)bones.leftLowerArm.rotation.z=-.12*f;if(bones.rightLowerArm)bones.rightLowerArm.rotation.z=.12*f;
  const breathe=Math.sin(t*(sleepy?.9:1.6))*(sleepy?.03:.02)*motion*(.6+pose.energy);
  if(bones.chest)bones.chest.rotation.x=f*(breathe+(mood==='listening'?.05:0));
  if(bones.spine)bones.spine.rotation.z=f*(Math.sin(t*.45)*.012*motion+(mood==='thinking'?.03:0));
  eye.x=ease(eye.x,pointer.x,4,dt);eye.y=ease(eye.y,pointer.y,4,dt);
  if(bones.neck)bones.neck.rotation.y=eye.x*.18;
  if(bones.head){bones.head.rotation.y=eye.x*.22+Math.sin(t*.37)*.04*motion;bones.head.rotation.x=f*(-eye.y*.12+(sleepy?.18:0)+Math.sin(t*.6)*.015*motion);bones.head.rotation.z=f*((mood==='thinking'?.09:mood==='listening'?-.05:0)+Math.sin(t*.29)*.02*motion);}
  look.position.set(eye.x*.6,focusY+.05+eye.y*.35,distance);
  // Natural blinking; eyes stay closed while sleepy.
  nextBlink-=dt;if(nextBlink<=0){blink=1;nextBlink=2+Math.random()*4;}
  blink=Math.max(0,blink-dt*7);
  const targets={
   happy:Math.max(0,(pose.valence-.15)/.85)*.85,sad:Math.max(0,-pose.valence)*.45,surprised:Math.max(0,pose.alert-.75)*1.4,relaxed:Math.max(0,.4-pose.energy)*1.4+(mood==='listening'?.2:0)
  };
  talk=ease(talk,mood==='talking'?Math.max(level,.15+Math.abs(Math.sin(t*11))*.45*motion):level,18,dt);
  targets.aa=talk*.9;targets.oh=talk*.25*Math.abs(Math.sin(t*3.1));
  targets.blink=sleepy?1:Math.sin(Math.min(blink,1)*Math.PI);
  for(const name of EXPRESSIONS){weights[name]=ease(weights[name],targets[name]||0,name==='blink'?40:8,dt);set(name,weights[name]);}
  last=now;vrm.update(dt);renderer.render(scene,camera);
 }
 frame=requestAnimationFrame(tick);
 return {
  kind:'vrm',meta:vrm.meta,
  setMood(next){mood=next||'idle';},
  setLook(x,y){pointer={x:clamp(Number(x)||0,-1,1),y:clamp(Number(y)||0,-1,1)};},
  setLevel(value){level=clamp(Number(value)||0,0,1);},
  setTheme(name){lights(name);},
  setReduced(on){reduced=!!on;},
  destroy(){disposed=true;cancelAnimationFrame(frame);clearTimeout(pointerTimer);window.removeEventListener('pointermove',onPointer);observer.disconnect();seen.disconnect();VRMUtils.deepDispose(vrm.scene);renderer.dispose();renderer.forceContextLoss?.();canvas.remove();}
 };
}
