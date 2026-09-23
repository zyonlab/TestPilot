import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const files=(root:string,prefix=''):string[]=>readdirSync(join(root,prefix)).flatMap(name=>{
 const path=join(prefix,name),stat=lstatSync(join(root,path));
 if(stat.isSymbolicLink()||name==='node_modules'||name==='test-results'||name==='state.json'||name==='state.json.tmp'||name==='seal.json')return[];
 return stat.isDirectory()?files(root,path):[path];
});
/** Content integrity is not an independent signature. The local operator still controls this disk. */
export function sealEvidence(root:string){
 if(existsSync(join(root,'seal.json')))throw new Error('evidence_already_sealed');
 const hashes=Object.fromEntries(files(root).sort().map(f=>[f,hash(readFileSync(join(root,f)))]));
 const seal={schemaVersion:1,at:new Date().toISOString(),hashes,digest:hash(JSON.stringify(hashes)),independentSignature:false};
 writeFileSync(join(root,'seal.json'),JSON.stringify(seal,null,2));return seal;
}
export function verifyEvidence(root:string){
 const seal=JSON.parse(readFileSync(join(root,'seal.json'),'utf8'));
 if(hash(JSON.stringify(seal.hashes))!==seal.digest)throw new Error('evidence_seal_invalid');
 for(const [file,want]of Object.entries(seal.hashes)){
  const full=resolve(root,file);if(!full.startsWith(resolve(root)+sep)||lstatSync(full).isSymbolicLink()||hash(readFileSync(full))!==want)throw new Error('evidence_content_changed:'+file);
 }
 return {digest:seal.digest,files:Object.keys(seal.hashes).length,independentSignature:false};
}
