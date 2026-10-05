/** Where things sit on a body, as percentages of its 200×224 box: the lamp, the place near it where the amber light
 * waits for the person, and the crop used for the small conversation icon. The stage places its glow and lights from these.
 */
const AVATAR_BOXES={
 shiro:{amber:[88,-4],lamp:[56.5,7.6],compact:[28,54,144,144]},
 andon:{amber:[88,-2],lamp:[56,6.3],compact:[28,50,144,150]},
 ensou:{amber:[98,10],lamp:[73,22.3],compact:[30,48,140,140]},
 kobako:{amber:[90,2],lamp:[59,16],compact:[26,60,148,148]},
 kitsune:{amber:[100,6],lamp:[86,22],compact:[8,10,178,178]},
 hotaru:{amber:[96,10],lamp:[73,25],compact:[44,56,112,112]},
 kokedama:{amber:[80,16],lamp:[51,22],compact:[36,36,128,160]},
 image:{amber:[96,10],lamp:[76,16],compact:[16,18,168,190]},
 imageset:{amber:[96,10],lamp:[76,16],compact:[16,18,168,190]}
};
/** Bodies drawn on a canvas fill the stage box instead of keeping the 200×224 shape. */
export const AVATAR_FILL_KINDS=Object.freeze(['vrm','mesh','solid']);
const AVATAR_FILL_BOX={amber:[78,2],lamp:[50,4],compact:null};
/** The geometry for a spec. A tall or low body moves its lamp, so the shape is taken into account. */
export function avatarGeometry(spec){
 const kind=spec.render==='solid'?'solid':spec.body==='vrm'?'vrm':spec.body==='mesh'?'mesh':null;
 if(kind)return {...AVATAR_FILL_BOX,fill:true};
 const box=AVATAR_BOXES[spec.body]||AVATAR_BOXES.shiro;
 if(spec.body==='shiro'){
  const top={egg:48,mochi:68,tall:36}[spec.slots?.shape]??48,y=Math.round((top+2-33)/224*1000)/10;
  return {...box,lamp:[56.5,y],amber:[88,Math.round((y-11.6)*10)/10],fill:false};
 }
 return {...box,fill:false};
}
