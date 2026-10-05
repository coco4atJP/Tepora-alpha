/** What the app asks of an avatar body, independent of how the body draws.
 * The app derives one mood from what is really happening and hands bodies a small pose vector;
 * every renderer (drawn, picture, VRM, mesh, solid) reads the same numbers.
 */
export const AVATAR_MOODS=Object.freeze(['idle','listening','thinking','talking','happy','attention','concerned','sleepy']);
/** valence is -1..1; the others are 0..1. */
export const POSE_KEYS=Object.freeze(['energy','valence','alert','focus','lamp','near','speech']);
const POSE_TABLE=Object.freeze({
 idle:     {energy:.35,valence:.1,alert:.2,focus:0,lamp:.25,near:.45,speech:0},
 listening:{energy:.55,valence:.2,alert:.7,focus:.8,lamp:.55,near:1,speech:0},
 thinking: {energy:.4,valence:0,alert:.5,focus:.9,lamp:.65,near:.5,speech:0},
 talking:  {energy:.6,valence:.3,alert:.5,focus:.6,lamp:.5,near:.85,speech:.6},
 happy:    {energy:.9,valence:1,alert:.6,focus:.2,lamp:.78,near:.9,speech:0},
 attention:{energy:.6,valence:0,alert:.9,focus:.5,lamp:.5,near:.8,speech:0},
 concerned:{energy:.3,valence:-.8,alert:.6,focus:.4,lamp:.1,near:.35,speech:0},
 sleepy:   {energy:.05,valence:.1,alert:0,focus:0,lamp:.04,near:0,speech:0}
});
/** The pose for a mood. `level` (0..1 loudness) raises speech while talking. Unknown moods are idle. */
export function moodPose(mood,level=0){
 const base=POSE_TABLE[mood]||POSE_TABLE.idle,loud=Math.max(0,Math.min(1,Number(level)||0));
 return {...base,speech:mood==='talking'?Math.max(base.speech,loud):base.speech};
}
/** Derive one mood from what is actually happening. Pure; the caller decides when to repaint. */
export function companionMood({recording=false,typing=false,sending=false,awaitingReply=false,talking=false,celebrate=false,attention=0,failures=0,sleepy=false}={}){
 if(talking)return 'talking';
 if(recording)return 'listening';
 if(sending||awaitingReply)return 'thinking';
 if(celebrate)return 'happy';
 if(typing)return 'listening';
 if(failures)return 'concerned';
 if(attention)return 'attention';
 if(sleepy)return 'sleepy';
 return 'idle';
}
