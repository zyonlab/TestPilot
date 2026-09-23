import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sealEvidence,verifyEvidence} from '../src/evidenceStudy/integrity.js';
it('binds raw results and generated code while permitting a separate review receipt',()=>{
 const root=mkdtempSync(join(tmpdir(),'tp-proof-'));
 try{mkdirSync(join(root,'export'));writeFileSync(join(root,'result.json'),'{}');writeFileSync(join(root,'export','test.ts'),'await verify();');writeFileSync(join(root,'state.json'),'{}');symlinkSync(tmpdir(),join(root,'node_modules'),'dir');const sealed=sealEvidence(root);expect(verifyEvidence(root).files).toBe(2);writeFileSync(join(root,'state.json'),'{"review":"accepted"}');expect(verifyEvidence(root).digest).toBe(sealed.digest);writeFileSync(join(root,'export','test.ts'),'');expect(()=>verifyEvidence(root)).toThrow('evidence_content_changed');expect(()=>sealEvidence(root)).toThrow('already_sealed');}finally{rmSync(root,{recursive:true,force:true});}
});
