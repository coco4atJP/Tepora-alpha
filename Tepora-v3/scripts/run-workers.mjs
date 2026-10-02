import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python=process.env.PYTHON||(process.platform==='win32'?'python':'python3');
const result=spawnSync(python,['-I','-S','-m','unittest','discover','-s','workers','-p','test_*.py','-v'],{
 cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit',shell:false
});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
