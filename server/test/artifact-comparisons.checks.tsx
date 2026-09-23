import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
import {comparisonNodes,type ArtifactComparison} from '../../src/lib/artifactComparison';
let lang:'zh'|'en'|'ja'='zh';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((k:string)=>translate(k,lang))}));
import {ComparisonSummary,ArtifactComparisons} from '../../src/components/workbench/ArtifactComparisons';
const arm={runId:'r',versions:{},nodes:Object.fromEntries(comparisonNodes.map(n=>[n,{outputs:[],inputs:[],inputDigest:null,phase:null}]))};
const comparison={a:arm,b:arm,differences:[{field:'scenarioState',a:null,b:null,status:'unknown'}]} as unknown as ArtifactComparison;
for(const l of ['zh','en','ja'] as const)it(`shows unknown and uncollected without claiming zero quality (${l})`,()=>{
 lang=l;const html=renderToStaticMarkup(<ComparisonSummary value={comparison}/>);
 expect(html).toContain(translate('compare.boundary',l));expect(html).toContain(translate('compare.noOutput',l));expect(html).toContain(translate('compare.status.unknown',l));
 expect(renderToStaticMarkup(<ArtifactComparisons projectId="p"/>)).toContain(translate('compare.title',l));
});
