/** The solid body: しろ・改 as a soft 3D figure, built with three.js from the same spec as the flat one. Loaded only when chosen.
 * It needs no model file and fetches nothing: the figure is a few primitives, lit by the room's light and by its own lamp.
 * It reads the same pose vector as every other body, draws at 30 frames a second, and stops while the window is hidden or off screen.
 */
import * as THREE from './vendor/three.module.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const ease=(from,to,rate,dt)=>from+(to-from)*(1-Math.exp(-rate*dt));
const FALLBACK_POSE={energy:.35,valence:.1,alert:.2,focus:0,lamp:.25,near:.45,speech:0};

// Sizes are the flat figure's drawing units divided by 100, measured from the middle of the body (ellipsoid with a slight egg skew).
const SHAPES={
 egg:{cy:.85,rx:.75,ry:.79,skew:.07,face:.01,gap:.24,cheek:.44,shoulder:[.64,-.01],hand:[.73,-.25],headW:1.26,neck:-.41},
 mochi:{cy:.75,rx:.86,ry:.69,skew:.04,face:-.05,gap:.28,cheek:.55,shoulder:[.72,.01],hand:[.81,-.23],headW:1.46,neck:-.37},
 tall:{cy:.91,rx:.68,ry:.85,skew:.08,face:.11,gap:.21,cheek:.37,shoulder:[.56,.03],hand:[.65,-.21],headW:1.04,neck:-.31}
};
const MOTION={calm:.6,normal:1,lively:1.3};
const LIGHTS={
 light:{sky:0xfff6ea,ground:0xb8aa98,hemi:1.5,key:2.1,tint:0xffffff,rim:.35,lamp:.35},
 dark:{sky:0xd8cdbf,ground:0x3a3228,hemi:1.0,key:1.35,tint:0xffeedd,rim:.5,lamp:.7},
 lamp:{sky:0xffd9b0,ground:0x1e1610,hemi:.55,key:.95,tint:0xffc488,rim:.28,lamp:1.5}
};
/** How each material feels: ceramic is glossy, felt and moss are soft. */
const FEEL={porcelain:{roughness:.3,clearcoat:.7,clearcoatRoughness:.2},felt:{roughness:.98,sheen:1,sheenRoughness:.8},moss:{roughness:.98,sheen:.7,sheenRoughness:.8},sumi:{roughness:.35,clearcoat:.5,clearcoatRoughness:.3},washi:{roughness:.85},sora:{roughness:.55},sakura:{roughness:.8},kitsune:{roughness:.9}};

/** The surface of the body at (x, y), measured from its middle: depth, and the direction it faces. */
function surface(S,x,y){const yn=y/S.ry,k=1+S.skew*-yn,xn=x/(S.rx*k);return Math.sqrt(Math.max(1-xn*xn-yn*yn,0))*S.rx*k;}
function normalAt(S,x,y){const e=.002;return new THREE.Vector3(-(surface(S,x+e,y)-surface(S,x-e,y))/(2*e),-(surface(S,x,y+e)-surface(S,x,y-e))/(2*e),1).normalize();}
/** Half the width of the body at height y. */
const widthAt=(S,y)=>{const yn=clamp(y/S.ry,-1,1);return S.rx*(1+S.skew*-yn)*Math.sqrt(1-yn*yn);};

function bodyGeometry(S){
 const g=new THREE.SphereGeometry(1,72,56),p=g.attributes.position;
 for(let i=0;i<p.count;i++){
  let x=p.getX(i),y=p.getY(i),z=p.getZ(i);const k=1+S.skew*-y;
  x*=k;z*=k;if(y<-.82)y=-.82+(y+.82)*.45;   // the underside is flattened so it sits on the feet
  p.setXYZ(i,x*S.rx,y*S.ry,z*S.rx);
 }
 g.computeVertexNormals();return g;
}
function radialTexture(stops){
 const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),gr=g.createRadialGradient(64,64,0,64,64,64);
 for(const [at,css] of stops)gr.addColorStop(at,css);g.fillStyle=gr;g.fillRect(0,0,128,128);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
const sphere=(r,w=24,h=16)=>new THREE.SphereGeometry(r,w,h);
const put=(parent,geometry,material,[x,y,z]=[0,0,0],[sx,sy,sz]=[1,1,1])=>{const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.scale.set(sx,sy,sz);parent.add(m);return m;};
/** A group sitting on the body surface at (x, y), turned to face outward. */
function onSurface(S,x,y,lift=.004){const g=new THREE.Group(),z=surface(S,x,y),n=normalAt(S,x,y);g.position.set(x,y,z).addScaledVector(n,lift);g.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),n);return g;}

export async function createSolidAvatar(host,{spec,reducedMotion=false,theme='light',signal,follow=true,moodPose=()=>FALLBACK_POSE,colors,season='off'}={}){
 if(signal?.aborted)throw Object.assign(new Error('aborted'),{aborted:true});
 const S=SHAPES[spec.slots?.shape]||SHAPES.egg,motionScale=MOTION[spec.motion]||1;
 const canvas=document.createElement('canvas');canvas.className='solid-canvas';canvas.setAttribute('aria-hidden','true');
 let renderer;
 try{renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});}
 catch{throw new Error('この端末ではWebGLを使えないため、立体で表示できません。');}
 renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(22,1,.1,40);
 const hemi=new THREE.HemisphereLight(0xffffff,0x888888,1),key=new THREE.DirectionalLight(0xffffff,1),rim=new THREE.DirectionalLight(0xbfd4ff,.3);
 key.position.set(1.1,2.2,2.6);rim.position.set(-1.6,1.4,-1.8);scene.add(hemi,key,rim);

 const mats={
  body:new THREE.MeshPhysicalMaterial({roughness:.8}),limb:new THREE.MeshStandardMaterial({roughness:.85}),mitt:new THREE.MeshStandardMaterial({roughness:.8}),foot:new THREE.MeshStandardMaterial({roughness:.9}),
  ink:new THREE.MeshStandardMaterial({roughness:.3,side:THREE.DoubleSide}),cheek:new THREE.MeshStandardMaterial({roughness:1,transparent:true,opacity:.6,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2}),
  inner:new THREE.MeshStandardMaterial({roughness:1,transparent:true,opacity:.5,side:THREE.DoubleSide}),shade:new THREE.MeshStandardMaterial({roughness:.9,side:THREE.DoubleSide}),
  lamp:new THREE.MeshStandardMaterial({roughness:.4}),glint:new THREE.MeshBasicMaterial({color:0xffffff})
 };
 const feel=FEEL[spec.palette]||{roughness:.8};
 Object.assign(mats.body,{roughness:.8,clearcoat:0,sheen:0,...feel});
 const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:radialTexture([[0,'rgba(255,255,255,.95)'],[.35,'rgba(255,255,255,.34)'],[1,'rgba(255,255,255,0)']]),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
 const lampLight=new THREE.PointLight(0xffffff,1,3.4,2);

 // ---- the figure: rig stands on the floor, bodyG is the middle of the body ----
 const rig=new THREE.Group(),bodyG=new THREE.Group();bodyG.position.y=S.cy;rig.add(bodyG);scene.add(rig);
 const shell=new THREE.Mesh(bodyGeometry(S),mats.body);bodyG.add(shell);
 for(const side of [-1,1])put(rig,sphere(1,24,16),mats.foot,[side*.22,.075,.06],[.155,.075,.17]);
 const shadow=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:radialTexture([[0,'rgba(0,0,0,.42)'],[.55,'rgba(0,0,0,.16)'],[1,'rgba(0,0,0,0)']]),transparent:true,depthWrite:false}));
 shadow.rotation.x=-Math.PI/2;shadow.position.y=.002;scene.add(shadow);

 // face: parts sit on the surface; turning this group slides them over the body, which is how the figure looks around
 const face=new THREE.Group();bodyG.add(face);
 const eyes=[],eyeStyle=spec.face?.eyes||'capsule',gx=S.gap;
 for(const side of [-1,1]){
  const root=onSurface(S,side*gx,S.face),tilt=new THREE.Group(),open=new THREE.Group(),smile=new THREE.Mesh(new THREE.TorusGeometry(.075,.016,8,24,Math.PI),mats.ink);
  root.add(tilt);tilt.add(open,smile);smile.position.set(0,-.02,.012);smile.visible=false;
  if(eyeStyle==='dot'){put(open,sphere(.074),mats.ink,[0,0,0],[1,1,.45]);put(open,sphere(.023,12,8),mats.glint,[.024,.026,.03]);}
  else if(eyeStyle==='big'){put(open,sphere(.11),mats.ink,[0,0,0],[1,1.23,.45]);put(open,sphere(.044,12,8),mats.glint,[.036,.06,.04]);put(open,sphere(.02,12,8),mats.glint,[-.034,-.06,.035]);}
  else if(eyeStyle==='sleepy')put(open,new THREE.CircleGeometry(.11,28,Math.PI,Math.PI),mats.ink,[0,.012,.012]);
  else{put(open,new THREE.CapsuleGeometry(.06,.14,6,18),mats.ink,[0,0,0],[1,1,.42]);put(open,sphere(.025,12,8),mats.glint,[.016,.062,.03]);put(open,sphere(.012,10,6),mats.glint,[-.018,-.07,.028]);}
  face.add(root);eyes.push({root,tilt,open,smile,side});
 }
 const cheeks=[];
 if(spec.face?.cheeks!==false)for(const side of [-1,1]){const root=onSurface(S,side*S.cheek,S.face-.18,.006);put(root,new THREE.CircleGeometry(1,28),mats.cheek,[0,0,0],[.12,.065,1]);face.add(root);cheeks.push(root);}
 const brows=[];
 if(spec.face?.brows)for(const side of [-1,1]){const root=onSurface(S,side*gx,S.face+.21,.012),curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(-.1,0,0),new THREE.Vector3(0,.05,0),new THREE.Vector3(.1,0,0));put(root,new THREE.TubeGeometry(curve,12,.011,6),mats.ink);face.add(root);brows.push({root,side});}
 const mouthRoot=onSurface(S,0,S.face-.24,.01),smileMouth=new THREE.Mesh(new THREE.TorusGeometry(.075,.014,8,24,Math.PI),mats.ink),openMouth=new THREE.Mesh(sphere(.07),mats.ink);
 smileMouth.rotation.z=Math.PI;smileMouth.position.y=.04;openMouth.visible=false;mouthRoot.add(smileMouth,openMouth);face.add(mouthRoot);

 // arms: each pivots at the shoulder; the hand rests against the side of the body
 const arms=[];
 for(const side of [-1,1]){
  const pivot=new THREE.Group(),[sx,sy]=S.shoulder,[hx,hy]=S.hand,dx=side*(hx-sx),dy=hy-sy,len=Math.hypot(dx,dy);
  pivot.position.set(side*sx,sy,.09);
  const limb=put(pivot,new THREE.CapsuleGeometry(.075,len,6,12),mats.limb,[dx/2,dy/2,0]);limb.rotation.z=Math.atan2(-dx,dy);
  const hand=put(pivot,sphere(1,20,14),mats.mitt,[dx,dy,.02],[.105,.125,.1]);put(hand,sphere(.3,10,8),mats.glint,[-.25,.35,.8]);
  bodyG.add(pivot);arms.push({pivot,side,hand});
 }

 // ears
 const ears=[],earKind=spec.parts?.ears||'none';
 if(earKind!=='none')for(const side of [-1,1]){
  const x=side*S.headW*(earKind==='cat'?.3:.36),y=S.ry*Math.sqrt(Math.max(1-(x/(S.rx*(1-S.skew*.7)))**2,0))-(earKind==='cat'?.1:.05),pivot=new THREE.Group();pivot.position.set(x,y,0);
  if(earKind==='cat'){put(pivot,new THREE.ConeGeometry(.17,.34,4),mats.body,[0,.15,0],[1,1,.5]);put(pivot,new THREE.ConeGeometry(.1,.22,4),mats.inner,[0,.13,.05],[1,1,.4]);}
  else if(earKind==='bear'){put(pivot,sphere(.16,20,14),mats.body,[0,.08,0],[1,1,.6]);put(pivot,sphere(.085,16,12),mats.inner,[0,.08,.05],[1,1,.4]);}
  else{put(pivot,new THREE.CapsuleGeometry(.115,.4,8,16),mats.body,[0,.27,0],[1,1,.6]);put(pivot,new THREE.CapsuleGeometry(.055,.3,8,12),mats.inner,[0,.28,.05],[1,1,.4]);}
  bodyG.add(pivot);ears.push({pivot,side});
 }

 // lamp on a bent stem; it also lights the body, which is what makes the figure feel lit from within a room
 const antenna=new THREE.Group();antenna.position.set(0,S.ry-.02,0);bodyG.add(antenna);
 const stem=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0),new THREE.Vector3(-.01,.14,0),new THREE.Vector3(.04,.24,0),new THREE.Vector3(.13,.31,0)]),20,.014,6),mats.shade);antenna.add(stem);
 const lampG=new THREE.Group();lampG.position.set(.13,.33,0);antenna.add(lampG);
 const lampShape=spec.lamp?.shape||'bead';
 if(lampShape==='flame'){const pts=[];for(let i=0;i<=20;i++){const s=i/20;pts.push(new THREE.Vector2(Math.max(.0001,.07*Math.sin(Math.PI*Math.pow(s,.75))),-.08+.2*s));}put(lampG,new THREE.LatheGeometry(pts,24),mats.lamp);}
 else if(lampShape==='bud'){put(lampG,sphere(.06,20,14),mats.lamp,[0,0,0],[1,1.4,1]);put(lampG,new THREE.TorusGeometry(.045,.012,6,16,Math.PI),mats.shade,[0,-.05,0]).rotation.z=Math.PI;}
 else if(lampShape==='bulb'){put(lampG,sphere(.072,24,16),mats.lamp);put(lampG,new THREE.CylinderGeometry(.034,.04,.04,12),mats.shade,[0,-.085,0]);}
 else put(lampG,sphere(.07,24,16),mats.lamp);
 put(lampG,sphere(.019,10,8),mats.glint,[-.025,.028,.05]);
 lampG.add(halo,lampLight);halo.scale.setScalar(.7);

 // accessories
 const prop=name=>{
  if(name==='headphones'){
   const ys=S.ry*.3,xs=widthAt(S,ys)+.025,pts=[];for(let i=0;i<=24;i++){const a=Math.PI*i/24;pts.push(new THREE.Vector3(Math.cos(a)*xs,ys+Math.sin(a)*(S.ry-ys+.025),0));}
   bodyG.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),40,.024,8),mats.ink));
   for(const side of [-1,1]){const cup=put(bodyG,new THREE.CylinderGeometry(.095,.095,.07,18),mats.ink,[side*(xs+.01),ys,0]);cup.rotation.z=Math.PI/2;}
  }else if(name==='glasses'){
   for(const side of [-1,1]){const root=onSurface(S,side*gx,S.face,.034);put(root,new THREE.TorusGeometry(.135,.013,8,32),mats.ink,[0,0,0],[1,1.08,1]);put(root,new THREE.CircleGeometry(.13,28),glass,[0,0,-.004],[1,1.08,1]);face.add(root);}
   const bridge=onSurface(S,0,S.face+.01,.034);put(bridge,new THREE.TorusGeometry(.04,.011,6,12,Math.PI),mats.ink,[0,0,0]);face.add(bridge);
  }else if(name==='cup'){
   const cup=new THREE.Group();cup.position.set(.05,.07,.2);
   put(cup,new THREE.CylinderGeometry(.1,.08,.2,20),holdMat,[0,0,0]);put(cup,new THREE.TorusGeometry(.06,.014,6,14,Math.PI),holdMat,[.1,0,0]).rotation.z=-Math.PI/2;
   arms[1].pivot.add(cup);cup.position.add(arms[1].hand.position);
  }else if(name==='uchiwa'){
   const fan=new THREE.Group();fan.position.copy(arms[1].hand.position).add(new THREE.Vector3(.03,.06,.2));fan.rotation.z=-.3;
   put(fan,new THREE.CylinderGeometry(.016,.016,.22,8),new THREE.MeshStandardMaterial({color:0xb78f5a,roughness:.8}),[0,0,0]);put(fan,new THREE.CylinderGeometry(.15,.15,.02,28),new THREE.MeshStandardMaterial({color:0xf1ead8,roughness:.9}),[0,.2,0]).rotation.x=Math.PI/2;
   arms[1].pivot.add(fan);
  }else if(name==='petal'||name==='leaf'){
   const m=new THREE.MeshStandardMaterial({color:name==='leaf'?0xc8a15f:0xf2c4c4,roughness:.9,side:THREE.DoubleSide}),x=-S.headW*.15,y=S.ry*.8,o=onSurface(S,x,y,.012);
   put(o,sphere(1,16,10),m,[0,.07,0],[.08,.16,.02]);o.rotateZ(-.5);bodyG.add(o);
  }else if(name==='scarf'){
   const y=S.neck+.06,r=widthAt(S,y)+.012,m=new THREE.MeshStandardMaterial({color:0xa9b3bd,roughness:.95});
   const band=put(bodyG,new THREE.TorusGeometry(r,.048,12,56),m,[0,y,0]);band.rotation.x=Math.PI/2;
   put(bodyG,new THREE.BoxGeometry(.16,.3,.05),new THREE.MeshStandardMaterial({color:0x9aa5b0,roughness:.95}),[r*.45,y-.16,surface(S,r*.45,y-.16)+.03]).rotation.z=.08;
  }
 };
 const glass=new THREE.MeshStandardMaterial({color:0xffffff,transparent:true,opacity:.14,roughness:.1,depthWrite:false}),holdMat=new THREE.MeshStandardMaterial({color:0xf4f0e6,roughness:.5});
 const wornSeason=spec.props?.season==='auto'?season:spec.props?.season;
 if(wornSeason&&wornSeason!=='off')prop(wornSeason);
 if(spec.props?.hobby&&spec.props.hobby!=='none')prop(spec.props.hobby);

 // ---- colour, light, framing ----
 const stemColor=new THREE.Color();
 function paint(name){
  const c=colors(name),L=LIGHTS[name]||LIGHTS.light;
  mats.body.color.set(c.body);mats.body.sheenColor.set(c.light);mats.limb.color.set(c.limb);mats.mitt.color.set(c.body);mats.foot.color.set(c.foot);mats.ink.color.set(c.ink);mats.cheek.color.set(c.cheek);mats.inner.color.set(c.cheek);
  stemColor.set(c.ink).lerp(new THREE.Color(c.body),.35);mats.shade.color.copy(stemColor);
  mats.lamp.color.set(c.lamp);mats.lamp.emissive.set(c.lamp);halo.material.color.set(c.lamp);lampLight.color.set(c.lamp);
  hemi.color.setHex(L.sky);hemi.groundColor.setHex(L.ground);hemi.intensity=L.hemi;key.color.setHex(L.tint);key.intensity=L.key;rim.intensity=L.rim;
  lighting=L;
 }
 let lighting=LIGHTS.light;paint(theme);
 scene.updateMatrixWorld(true);
 const box=new THREE.Box3().setFromObject(rig),centerY=(box.max.y+box.min.y)/2,halfH=(box.max.y-box.min.y)/2*1.07,halfW=Math.max(box.max.x,-box.min.x)*1.1+.2;
 let distance=6;
 const resize=()=>{
  const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;
  const half=Math.tan(camera.fov*Math.PI/360);distance=Math.max(halfH/half,halfW/(half*camera.aspect));
  camera.position.set(0,centerY+.06,distance);camera.lookAt(0,centerY,0);camera.updateProjectionMatrix();
  shadow.scale.set(S.rx*2.5,S.rx*1.7,1);
 };
 host.append(canvas);
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 let visible=true;const seen=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);});seen.observe(host);

 // ---- life ----
 let mood='idle',level=0,reduced=reducedMotion,pointer=null,pointerTimer=0,look={x:0,y:0},idleLook={x:0,y:0,next:2},t=0,last=0,frame=0,disposed=false,nextBlink=1.6,blink=0;
 const smooth={energy:.35,valence:.1,alert:.2,lamp:.25,near:.45,happy:0,sleep:0,worry:0,talk:0,wave:0,raiseL:0,raiseR:0,tilt:0};
 const onPointer=e=>{
  if(reduced)return;const r=host.getBoundingClientRect();if(!r.width)return;
  pointer={x:clamp((e.clientX-(r.left+r.width/2))/Math.max(260,innerWidth/2),-1,1),y:clamp((e.clientY-(r.top+r.height*.3))/Math.max(220,innerHeight/2),-1,1)};
  clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointer=null;},4000);
 };
 if(follow)window.addEventListener('pointermove',onPointer,{passive:true});
 function tick(now){
  if(disposed)return;frame=requestAnimationFrame(tick);
  if(!visible||document.hidden){last=now;return;}
  const busy=mood==='talking'||mood==='happy'||mood==='attention';
  if(!busy&&now-last<32)return;
  const dt=clamp((now-last)/1000,.001,.1);last=now;t+=dt;
  const m=reduced?0:motionScale,pose=moodPose(mood,level),sleepy=mood==='sleepy',talking=mood==='talking',k=reduced?30:6;
  smooth.energy=ease(smooth.energy,pose.energy,k,dt);smooth.valence=ease(smooth.valence,pose.valence,k,dt);smooth.alert=ease(smooth.alert,pose.alert,k,dt);smooth.lamp=ease(smooth.lamp,pose.lamp,k,dt);smooth.near=ease(smooth.near,pose.near,k,dt);
  smooth.happy=ease(smooth.happy,mood==='happy'?1:0,10,dt);smooth.sleep=ease(smooth.sleep,sleepy?1:0,4,dt);smooth.worry=ease(smooth.worry,mood==='concerned'?1:0,6,dt);
  smooth.tilt=ease(smooth.tilt,mood==='thinking'?-.07:mood==='listening'?.04:mood==='concerned'?.03:0,5,dt);
  // where it looks: the pointer when near, otherwise a slow wander (and up and aside while thinking)
  if(!pointer&&m&&t>idleLook.next){idleLook={x:(Math.random()*2-1)*.35,y:(Math.random()*2-1)*.2,next:t+2+Math.random()*3};}
  const aim=pointer&&!reduced?pointer:mood==='thinking'&&!reduced?{x:-.4,y:-.5}:m?idleLook:{x:0,y:0};
  look.x=ease(look.x,aim.x,4,dt);look.y=ease(look.y,aim.y,4,dt);
  face.rotation.y=look.x*.32;face.rotation.x=look.y*.15;rig.rotation.y=look.x*.12;
  // body: breath, bounce, lean
  const breath=Math.sin(t*(sleepy?.9:1.2+1.2*smooth.energy)),bounce=(mood==='happy'||talking)?Math.abs(Math.sin(t*(3+4*smooth.energy))):0;
  const stretch=1+breath*.012*m*(.5+smooth.energy)+smooth.alert*.025-smooth.sleep*.05;
  rig.scale.set(1/Math.sqrt(stretch)+smooth.near*.02,stretch+smooth.near*.02,1/Math.sqrt(stretch)+smooth.near*.02);
  rig.position.y=bounce*.045*m;rig.rotation.x=smooth.near*.1-smooth.worry*.04+smooth.sleep*.04;rig.rotation.z=smooth.tilt+Math.sin(t*.4)*.012*m;
  shadow.material.opacity=1-bounce*.25*m;
  // eyes: blink on a timer, closed while sleepy, a smile when happy
  nextBlink-=dt;if(nextBlink<=0){blink=1;nextBlink=2+Math.random()*4;}
  blink=Math.max(0,blink-dt*7);
  const lid=Math.max(.08,(1+smooth.alert*.14)*(1-Math.sin(Math.min(blink,1)*Math.PI)*.92)*(1-smooth.sleep*.92));
  for(const e of eyes){
   e.open.scale.set(1,lid*(1-smooth.happy),1);e.open.visible=smooth.happy<.97;e.smile.visible=smooth.happy>.03;e.smile.scale.setScalar(Math.max(.01,smooth.happy));
   e.tilt.rotation.z=e.side*smooth.worry*.28;
  }
  mats.cheek.opacity=.45+.35*Math.max(smooth.happy,smooth.near*.5);
  for(const b of brows){b.root.children[0].rotation.z=-b.side*smooth.worry*.3;b.root.children[0].position.y=smooth.alert*.04-smooth.worry*.005;}
  // mouth: a smile that follows valence, opening with speech
  const driven=level>.03,open=talking?(driven?pose.speech:pose.speech*(.35+.65*Math.abs(Math.sin(t*9)))):0;smooth.talk=ease(smooth.talk,open,16,dt);
  openMouth.visible=smooth.talk>.04;openMouth.scale.set(1,.12+.88*smooth.talk,.4);smileMouth.visible=smooth.talk<=.08;
  smileMouth.scale.set(1,clamp(.25+smooth.valence*.9,-.5,.65)+(mood==='happy'?.2:0),1);
  // arms: rest with a faint sway; raised when happy or when asking for attention
  const wave=mood==='attention'?Math.sin(t*7)*.25:0;
  smooth.raiseL=ease(smooth.raiseL,mood==='happy'?.9:0,6,dt);smooth.raiseR=ease(smooth.raiseR,mood==='attention'?2.3:mood==='happy'?.9:0,6,dt);
  const sway=Math.sin(t*1.1)*.04*m;
  arms[0].pivot.rotation.z=-(smooth.raiseL+Math.sin(t*6)*.12*smooth.happy*m)-sway;arms[1].pivot.rotation.z=smooth.raiseR+wave*m+sway;
  // ears perk up when alert, drop when worried or sleepy
  for(const e of ears){const spread=earKind==='cat'?.42:earKind==='bear'?.5:.15;e.pivot.rotation.z=-e.side*(spread+smooth.alert*(earKind==='rabbit'?-.12:.05)+(smooth.worry+smooth.sleep)*.3+Math.sin(t*.9+e.side)*.03*m);}
  // lamp: brighter and a little restless when something wants attention; sways on its stem
  const glow=(.5+1.1*smooth.lamp)*(theme==='lamp'?1.25:1)+(mood==='attention'?Math.sin(t*6)*.18*m:Math.sin(t*2.3)*.06*m);
  mats.lamp.emissiveIntensity=glow;halo.material.opacity=clamp(.25+.5*smooth.lamp,0,.8);lampLight.intensity=lighting.lamp*(.4+.9*smooth.lamp);
  antenna.rotation.z=Math.sin(t*1.3)*.05*m-rig.rotation.z*.4;
  renderer.render(scene,camera);
 }
 frame=requestAnimationFrame(tick);
 return {
  kind:'solid',
  setMood(next){mood=next||'idle';},
  setLook(x,y){pointer={x:clamp(Number(x)||0,-1,1),y:clamp(Number(y)||0,-1,1)};clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointer=null;},4000);},
  setLevel(value){level=clamp(Number(value)||0,0,1);},
  setTheme(name){theme=name;paint(name);},
  setReduced(on){reduced=!!on;if(reduced)pointer=null;},
  destroy(){
   disposed=true;cancelAnimationFrame(frame);clearTimeout(pointerTimer);window.removeEventListener('pointermove',onPointer);observer.disconnect();seen.disconnect();
   scene.traverse(o=>{o.geometry?.dispose();const m=o.material;if(m){m.map?.dispose();m.dispose?.();}});
   renderer.dispose();renderer.forceContextLoss?.();canvas.remove();
  }
 };
}
