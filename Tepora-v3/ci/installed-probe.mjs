/** Import the installed service without starting it or touching user data. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]);
await import(pathToFileURL(path.join(root,'core','server.mjs')).href);
console.log(JSON.stringify({installed_service_imported:true}));
