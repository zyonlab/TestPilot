import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
let lang:'zh'|'en'|'ja'='en';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((key:string,args?:Record<string,any>)=>translate(key,lang,args))}));
import {EvidenceReuse} from '../../src/components/workbench/EvidenceReuse';
const context={version:1,digest:'digest',hints:[{}],sourceRevision:'source',rejected:[{reason:'metadata_unknown'}]};
for(const l of ['zh','en','ja'] as const)it(`selected / unknown / used / fallback / malformed evidence (${l})`,()=>{
 lang=l;
 for(const value of [undefined,{context},{context,events:[{status:'used'}]}]){
  const html=renderToStaticMarkup(<EvidenceReuse value={value} context={context}/>);
  expect(html).toContain(translate('reuse.unknown',l));expect(html).not.toContain(translate('reuse.used',l,{n:0}));
 }
 const html=renderToStaticMarkup(<EvidenceReuse value={{context,events:[{status:'used',reason:'current_ui_validated',label:'Open',source:{revision:'source',observation:'obs-actual',edge:'sfg:edge:0',state:'entry'}},{status:'fallback',reason:'hidden'}]}}/>);
 expect(html).toContain(translate('reuse.used',l,{n:1}));expect(html).toContain('obs-actual');expect(html).toContain(translate('reuse.reason.hidden',l));expect(html).toContain(translate('reuse.versionHelp',l));
});
