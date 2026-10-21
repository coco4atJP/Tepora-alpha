import {copyFile,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';

/** Never rewrite an inode that may already have executable pages/code-signature state. */
export async function installNativeBinary(source,destination){
 const temporary=destination+'.'+randomUUID()+'.tmp';
 try{await copyFile(source,temporary,constants.COPYFILE_EXCL);await rename(temporary,destination);}
 finally{await rm(temporary,{force:true});}
}
