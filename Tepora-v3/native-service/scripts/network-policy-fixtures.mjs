// Refresh checked source differential fixtures without DNS, sockets, models, or keys.
import {writeFile} from 'node:fs/promises';
import {ipDomain,normalURL,insideEndpoint,NetworkPolicy} from '../../core/network-policy.mjs';
const ips=['::1','0:0:0:0:0:0:0:1','::','::ffff:127.0.0.1','::ffff:0808:0808','::127.0.0.1','64:ff9b::0808:0808','2002:c000:0201::','2001:db8::1','2001:0:1::1','2001:20::1','2001:200::1','2001:4860:4860::8888','3fff::1','4000::1','fd00::1','fc00::1','fe80::1','FE80::1%eth0','ff02::1','localhost','localhost.','not-an-ip','127.1','0177.0.0.1'];
for(const a of [0,1,10,100,127,169,172,192,198,203,223,224,240,255])for(const b of [0,2,16,18,19,20,31,32,51,63,64,100,113,127,128,168,254])for(const c of [0,100,113])ips.push(`${a}.${b}.${c}.1`);
const modes=['online','trusted-lan','offline'],domains=['device','lan','cloud'],purposes=['model','vision','worker','web','public-web','web-tool','feed','download'];
const network=new NetworkPolicy({value(){return null;}}),permissions=[];
for(const mode of modes)for(const internetTools of [false,true])for(const domain of domains)for(const purpose of purposes)permissions.push({mode,internetTools,domain,purpose,allowed:network.permitted(domain,purpose,{mode,internetTools})});
const paths=[];
const bases=['http://localhost:8000/v1','http://localhost:8000/','https://gpu.example/%76%31/'];
for(const base of bases)for(const suffix of ['','/models','x','/../admin','/%2e%2e%2fadmin','/%252e%252e%252fadmin','/%25252e%25252e%25252fadmin','/%2525252e%2525252e%2525252fadmin','/%252525252e%252525252e%252525252fadmin','/..%5cadmin','/%00','/%ff','/%','/%25','//models','/./models','/x/../models','/漢字','/a%2fb','?alt=sse']){const target=base.replace(/\/$/,'')+suffix;let allowed=false;try{allowed=insideEndpoint(target,base);}catch{}paths.push({base,target,allowed});}
paths.push({base:bases[0],target:'http://localhost:8001/v1/models',allowed:false},{base:bases[0],target:'http://evil.example:8000/v1/models',allowed:false});
const urls=[];
for(const value of ['http://localhost:80/v1','https://EXAMPLE.com:443/v1','http://127.1/v1','http://2130706433/v1','http://0x7f000001/v1','http://0177.0.0.1/v1','http://[::1]/v1','http://[::ffff:127.0.0.1]/v1','https://example.com/a/../v1','https://example.com/v1?x=1','https://example.com/v1?','https://example.com/v1#','https://example.com/v1#x','https://u:p@example.com/v1','https://@example.com/v1','https://%65xample.com/v1','ftp://example.com/v1','https://[fe80::1%25eth0]/','/relative'])for(const query of [false,true]){try{urls.push({value,query,url:normalURL(value,{query}).href});}catch{urls.push({value,query,url:null});}}
const data={source:'core/network-policy.mjs',ip:ips.map(ip=>({ip,domain:ipDomain(ip)})),permissions,paths,urls};
await writeFile(new URL('../src/network/source-fixtures.json',import.meta.url),JSON.stringify(data));
console.log(`${data.ip.length} IPs, ${permissions.length} permissions, ${paths.length} paths, ${urls.length} URLs`);
