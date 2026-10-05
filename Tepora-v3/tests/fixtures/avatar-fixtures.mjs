/** Things a person might bring for the avatar, made from nothing, so a browser test can bring them without any real
 * character: a VRM 1.0 humanoid built from boxes, a mesh-avatar-studio project with a painted face, one picture
 * and a set of three. They are small, drawn here, and carry no one's artwork.
 *   node tests/fixtures/avatar-fixtures.mjs <folder>   →  test.vrm, mesh-project/, picture.png, imageset/
 */
import zlib from 'node:zlib';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/* ---------------- a small anti-aliased rasteriser and PNG writer ---------------- */
const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
const crc=buf=>{let c=0xffffffff;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'latin1'),data]),c=Buffer.alloc(4);c.writeUInt32BE(crc(body));return Buffer.concat([len,body,c]);};
function encodePNG(w,h,rgba){
 const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)Buffer.from(rgba.buffer,rgba.byteOffset+y*w*4,w*4).copy(raw,y*(w*4+1)+1);
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const rgb=hex=>{const n=parseInt(hex.slice(1),16);return [n>>16&255,n>>8&255,n&255];};
class Canvas{
 constructor(w,h,bg=null){this.w=w;this.h=h;this.d=new Uint8ClampedArray(w*h*4);if(bg)this.rect(0,0,w,h,bg);}
 blend(x,y,[r,g,b],a){
  if(x<0||y<0||x>=this.w||y>=this.h||a<=0)return;const i=(y*this.w+x)*4,d=this.d,da=d[i+3]/255,oa=a+da*(1-a);
  d[i]=(r*a+d[i]*da*(1-a))/oa;d[i+1]=(g*a+d[i+1]*da*(1-a))/oa;d[i+2]=(b*a+d[i+2]*da*(1-a))/oa;d[i+3]=oa*255;
 }
 rect(x0,y0,x1,y1,color,alpha=1){const c=rgb(color);for(let y=Math.max(0,y0);y<Math.min(this.h,y1);y++)for(let x=Math.max(0,x0);x<Math.min(this.w,x1);x++)this.blend(x,y,c,alpha);}
 ellipse(cx,cy,rx,ry,color,alpha=1,clipY=null){
  const c=rgb(color),m=Math.min(rx,ry);
  for(let y=Math.max(0,Math.floor(cy-ry-2));y<=Math.min(this.h-1,Math.ceil(cy+ry+2));y++){
   if(clipY&&(y<clipY[0]||y>clipY[1]))continue;
   for(let x=Math.max(0,Math.floor(cx-rx-2));x<=Math.min(this.w-1,Math.ceil(cx+rx+2));x++)this.blend(x,y,c,Math.max(0,Math.min(1,.5-(Math.hypot((x+.5-cx)/rx,(y+.5-cy)/ry)-1)*m))*alpha);
  }
 }
 stroke(points,r,color,alpha=1){for(let i=0;i<points.length-1;i++){const [ax,ay]=points[i],[bx,by]=points[i+1],n=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)/(r*.5)));for(let k=0;k<=n;k++)this.ellipse(ax+(bx-ax)*k/n,ay+(by-ay)*k/n,r,r,color,alpha);}}
 png(){return encodePNG(this.w,this.h,this.d);}
}

/* ---------------- a VRM 1.0 humanoid of boxes ---------------- */
export function vrmFixture(){
 const P=[],N=[],I=[];   // one unit cube shared by every part
 for(const [nx,ny,nz,ux,uy,uz,vx,vy,vz] of [[1,0,0,0,0,-1,0,1,0],[-1,0,0,0,0,1,0,1,0],[0,1,0,1,0,0,0,0,-1],[0,-1,0,1,0,0,0,0,1],[0,0,1,1,0,0,0,1,0],[0,0,-1,-1,0,0,0,1,0]]){
  const base=P.length/3;
  for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]){P.push((nx+a*ux+b*vx)/2,(ny+a*uy+b*vy)/2,(nz+a*uz+b*vz)/2);N.push(nx,ny,nz);}
  I.push(base,base+1,base+2,base,base+2,base+3);
 }
 const pos=Buffer.from(new Float32Array(P).buffer),nor=Buffer.from(new Float32Array(N).buffer),idx=Buffer.from(new Uint16Array(I).buffer),bin=Buffer.concat([pos,nor,idx]);
 const bones={hips:[0,1,0],spine:[0,.12,0],chest:[0,.16,0],neck:[0,.2,0],head:[0,.08,0],
  leftUpperArm:[.12,.14,0],leftLowerArm:[.28,0,0],leftHand:[.26,0,0],rightUpperArm:[-.12,.14,0],rightLowerArm:[-.28,0,0],rightHand:[-.26,0,0],
  leftUpperLeg:[.09,-.05,0],leftLowerLeg:[0,-.42,0],leftFoot:[0,-.42,0],rightUpperLeg:[-.09,-.05,0],rightLowerLeg:[0,-.42,0],rightFoot:[0,-.42,0]};
 const parent={spine:'hips',chest:'spine',neck:'chest',head:'neck',leftUpperArm:'chest',leftLowerArm:'leftUpperArm',leftHand:'leftLowerArm',rightUpperArm:'chest',rightLowerArm:'rightUpperArm',rightHand:'rightLowerArm',
  leftUpperLeg:'hips',leftLowerLeg:'leftUpperLeg',leftFoot:'leftLowerLeg',rightUpperLeg:'hips',rightLowerLeg:'rightUpperLeg',rightFoot:'rightLowerLeg'};
 const nodes=[],index={};
 for(const [name,t] of Object.entries(bones)){index[name]=nodes.length;nodes.push({name,translation:t,children:[]});}
 for(const [name,p] of Object.entries(parent))nodes[index[p]].children.push(index[name]);
 for(const [bone,mat,c,s] of [['head',1,[0,.12,0],[.24,.26,.24]],['head',2,[0,.2,0],[.27,.12,.27]],['head',0,[.06,.1,.125],[.04,.05,.01]],['head',0,[-.06,.1,.125],[.04,.05,.01]],['chest',3,[0,-.08,0],[.34,.46,.2]],['spine',3,[0,-.02,0],[.28,.2,.18]],
  ['leftUpperArm',3,[.14,0,0],[.28,.08,.08]],['leftLowerArm',1,[.14,0,0],[.28,.07,.07]],['rightUpperArm',3,[-.14,0,0],[.28,.08,.08]],['rightLowerArm',1,[-.14,0,0],[.28,.07,.07]],
  ['leftUpperLeg',4,[0,-.2,0],[.12,.42,.12]],['leftLowerLeg',4,[0,-.2,0],[.1,.42,.1]],['rightUpperLeg',4,[0,-.2,0],[.12,.42,.12]],['rightLowerLeg',4,[0,-.2,0],[.1,.42,.1]]]){
  nodes[index[bone]].children.push(nodes.length);nodes.push({name:`${bone}-part`,mesh:mat,translation:c,scale:s});
 }
 const material=(name,color)=>({name,pbrMetallicRoughness:{baseColorFactor:[...color,1],metallicFactor:0,roughnessFactor:.7}});
 const json={asset:{version:'2.0',generator:'tepora-test-fixture'},scene:0,scenes:[{nodes:[0]}],nodes,
  meshes:[0,1,2,3,4].map(m=>({primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:m}]})),
  materials:[material('ink',[.1,.08,.08]),material('skin',[.96,.82,.72]),material('hair',[.25,.16,.14]),material('cloth',[.29,.44,.65]),material('trousers',[.2,.22,.3])],
  accessors:[{bufferView:0,componentType:5126,count:24,type:'VEC3',min:[-.5,-.5,-.5],max:[.5,.5,.5]},{bufferView:1,componentType:5126,count:24,type:'VEC3'},{bufferView:2,componentType:5123,count:36,type:'SCALAR'}],
  bufferViews:[{buffer:0,byteOffset:0,byteLength:pos.length,target:34962},{buffer:0,byteOffset:pos.length,byteLength:nor.length,target:34962},{buffer:0,byteOffset:pos.length+nor.length,byteLength:idx.length,target:34963}],
  buffers:[{byteLength:bin.length}],extensionsUsed:['VRMC_vrm'],
  extensions:{VRMC_vrm:{specVersion:'1.0',meta:{name:'テスト用ヒューマノイド',version:'1',authors:['tester'],licenseUrl:'https://vrm.dev/licenses/1.0/',avatarPermission:'everyone',allowExcessivelyViolentUsage:false,allowExcessivelySexualUsage:false,commercialUsage:'personalNonProfit',allowPoliticalOrReligiousUsage:false,allowAntisocialOrHateUsage:false,creditNotation:'required',allowRedistribution:false,modification:'prohibited'},
   humanoid:{humanBones:Object.fromEntries(Object.keys(bones).map(n=>[n,{node:index[n]}]))}}}};
 const pad=(buf,byte)=>Buffer.concat([buf,Buffer.alloc((4-buf.length%4)%4,byte)]),j=pad(Buffer.from(JSON.stringify(json)),0x20),b=pad(bin,0);
 const head=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);
 head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(12+8+j.length+8+b.length,8);
 jh.writeUInt32LE(j.length,0);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(b.length,0);bh.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([head,jh,j,bh,b]);
}

/* ---------------- a mesh-avatar-studio project: rig.json and built/* of a painted face ---------------- */
export function meshFixture(){
 const W=512,H=640,EYE_N=24,SKIN='#f6d9c4',HAIR='#3b2a2a',CLOTH='#4a6fa5';
 const mask=new Canvas(W,H,'#000000'),base=new Canvas(W,H),files={};
 const hair=(cx,cy,rx,ry)=>{base.ellipse(cx,cy,rx,ry,HAIR);mask.ellipse(cx,cy,rx,ry,'#ffffff');};
 hair(256,262,172,205);base.ellipse(256,720,250,300,CLOTH,1,[430,H-1]);base.ellipse(256,455,40,70,SKIN);base.ellipse(256,262,132,152,SKIN);
 for(const [x,y,rx,ry] of [[200,172,62,56],[256,160,72,62],[312,172,62,56],[150,215,34,70],[362,215,34,70],[120,320,34,130],[392,320,34,130]])hair(x,y,rx,ry);
 base.stroke([[216,246],[232,241],[248,246]],2.6,'#5a4038');base.stroke([[264,246],[280,241],[296,246]],2.6,'#5a4038');
 base.stroke([[250,318],[256,324],[262,318]],1.8,'#d9b49c');base.stroke([[232,350],[244,356],[256,358],[268,356],[280,350]],2.6,'#b8605e');
 const eyes=[],layers={};
 const curve=top=>Array.from({length:EYE_N},(_,k)=>{const s=Math.pow(Math.sin(Math.PI*k/(EYE_N-1)),.7);return top?272-20*s-1:272+14*s+2;});
 [[200,0],[312,1]].forEach(([cx,i])=>{
  const x0=cx-38,x1=cx+38,top=curve(true),bot=curve(false),rect=[x0,242,76,60],at=(k,y)=>[x0+(x1-x0)*k/(EYE_N-1)-rect[0],y-rect[1]];
  eyes.push({x0,x1,top,bot});
  const ball=new Canvas(rect[2],rect[3]);ball.ellipse(38,30,37,24,'#fdfdfb');ball.ellipse(38,30,18,18,'#6b4a35');ball.ellipse(38,30,9,9,'#1b1210');ball.ellipse(32,23,5,5,'#ffffff');
  const lash=new Canvas(rect[2],rect[3]);lash.stroke(top.map((y,k)=>at(k,y)),3.4,'#241816');
  const low=new Canvas(rect[2],rect[3]);low.stroke(bot.map((y,k)=>at(k,y)),1.4,'#7a5a52',.8);
  const crease=new Canvas(rect[2],rect[3]);crease.stroke(top.map((y,k)=>at(k,y-9)),1.3,'#a98a7d',.6);
  for(const [part,c] of [['ball',ball],['lash',lash],['low',low],['crease',crease]]){files[`built/eye${i}_${part}.png`]=c.png();layers[`eye${i}_${part}`]=rect;}
 });
 const area=(cx,cy,rx,ry,extra={})=>({cx,cy,rx,ry,...extra});
 const rig={version:1,image:{width:W,height:H},
  head:{cx:256,cy:262,rx:160,ry:180,pivotX:256,pivotY:440,maxRoll:.14,shiftX:18,shiftY:12,weightBand:[410,480],turnBand:[430,520]},
  body:{chest:area(256,540,160,100),pivotX:256,pivotY:640,maxRoll:.05,rollBand:[500,630],breathBand:[500,640],shoulders:[area(140,490,80,50),area(372,490,80,50)]},
  face:{brow:area(256,242,120,34,{band:[215,270]}),jaw:area(256,350,80,50,{band:[330,370]}),nose:area(256,318,22,22),mouth:area(256,352,44,22),eyeA:area(200,272,52,32),eyeB:area(312,272,52,32),earR:area(124,300,26,40),earL:area(388,300,26,40)},
  mouth:{cx:256,cy:352,angle:0,halfLen:28,bow:4},cheeks:[[190,312],[322,312]],eyes,
  mesh:{baseCell:32,eyeBallCell:12,eyeCell:12,tasselCell:12,handCell:16,spriteCell:12},view:{padTop:0,padSide:.04},
  strands:[{name:'side0',nodes:[[120,250],[116,320],[114,390],[118,450]],sigma:26,max:14,k:1},{name:'side1',nodes:[[392,250],[396,320],[398,390],[394,450]],sigma:26,max:14,k:1}]};
 files['rig.json']=Buffer.from(JSON.stringify(rig));files['built/layers.json']=Buffer.from(JSON.stringify({build:'1',layers}));
 files['built/base.png']=base.png();files['built/hairmask.png']=mask.png();
 return files;
}

/* ---------------- pictures: one, and a set with a mood each ---------------- */
function face({mouth,eyes,tint}){
 const c=new Canvas(400,500);c.ellipse(200,310,150,180,tint);c.ellipse(200,300,125,140,'#fbeee0');
 if(eyes==='open'){c.ellipse(150,280,16,22,'#2b2220');c.ellipse(250,280,16,22,'#2b2220');c.ellipse(145,272,5,5,'#fff');c.ellipse(245,272,5,5,'#fff');}
 else{c.stroke([[132,284],[150,266],[168,284]],5,'#2b2220');c.stroke([[232,284],[250,266],[268,284]],5,'#2b2220');}
 if(mouth==='open')c.ellipse(200,350,26,30,'#8a3b3b');else if(mouth==='smile')c.stroke([[165,340],[200,365],[235,340]],5,'#9b4a4a');else c.stroke([[175,350],[225,350]],5,'#9b4a4a');
 c.ellipse(120,330,20,12,'#f4a8a0',.6);c.ellipse(280,330,20,12,'#f4a8a0',.6);return c.png();
}
export const imageFixtures=()=>({'idle.png':face({mouth:'flat',eyes:'open',tint:'#7aa6c8'}),'happy.png':face({mouth:'smile',eyes:'happy',tint:'#c8a07a'}),'talk-open.png':face({mouth:'open',eyes:'open',tint:'#7aa6c8'})});

export function writeAvatarFixtures(dir){
 const put=(rel,data)=>{const file=path.join(dir,rel);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,data);};
 put('test.vrm',vrmFixture());
 for(const [rel,data] of Object.entries(meshFixture()))put(path.join('mesh-project',rel),data);
 const pictures=imageFixtures();put('picture.png',pictures['idle.png']);
 for(const [name,data] of Object.entries(pictures))put(path.join('imageset',name),data);
 return dir;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(writeAvatarFixtures(path.resolve(process.argv[2]||'avatar-fixtures')));
