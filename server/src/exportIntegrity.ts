import {createHash} from 'node:crypto';
export const exportHash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const exportVerifier = `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const raw=readFileSync('testpilot-manifest.json','utf8'),manifest=JSON.parse(raw);
const expected=process.env.TP_APPROVED_EXPORT_SHA256;
if(process.env.CI&&!expected)throw new Error('APPROVED_EXPORT_HASH_REQUIRED');
if(expected&&hash(raw)!==expected)throw new Error('EXPORT_APPROVAL_MISMATCH');
for(const [path,want]of Object.entries(manifest.files)){if(path.startsWith('/')||path.split('/').includes('..'))throw new Error('UNSAFE_EXPORT_PATH');if(hash(readFileSync(path))!==want)throw new Error('EXPORT_FILE_CHANGED: '+path);}
console.log(JSON.stringify({status:'verified',manifestHash:hash(raw),caseCount:manifest.cases.length,approvalBound:!!expected}));
`;
export function sealExport(files:Record<string,string>,cases:unknown[]) {
 files['scripts/verify-export.mjs']=exportVerifier;
 files['testpilot-manifest.json']=JSON.stringify({schemaVersion:1,policy:'frozen-cases-shared-oracle-v1',cases,files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([p,s])=>[p,exportHash(s)]))},null,2)+'\n';
}
