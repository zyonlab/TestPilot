import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({host:vi.fn(),api:vi.fn(),put:vi.fn(),runtime:'codex',revisions:[{id:'k1',name:'knowledge/domain.md',revision:1}] as Array<{id:string;name:string;revision:number}>,contents:{} as Record<string,unknown>}));
vi.mock('../src/plannerHost.js',()=>({nativeHostChat:mocks.host}));
vi.mock('../src/modelProfiles.js',()=>({projectPlannerModel:()=>({chat:mocks.api})}));
vi.mock('../src/runService.js',()=>({runLedger:()=>({requireRun:()=>({input:{parameters:{plannerRuntime:mocks.runtime}}}),listRevisions:()=>mocks.revisions,readRevision:(id:string)=>({content:mocks.contents[id]??{text:'冻结的杠杆领域资料'}}),putRevision:mocks.put})}));
import {askExplorationPlanner,cancelExplorationPlanner} from '../src/explorationPlanner.js';
beforeEach(()=>{vi.clearAllMocks();mocks.runtime='codex';mocks.revisions=[{id:'k1',name:'knowledge/domain.md',revision:1}];mocks.contents={};mocks.host.mockResolvedValue({text:'{"business":"交易","stories":[],"decisions":[]}',tokens:12,ms:10});});
it('uses run-bound native host and frozen knowledge, saves call evidence',async()=>{
 await askExplorationPlanner({runId:'run',projectId:'project',prompt:'控件清单'});
 expect(mocks.host).toHaveBeenCalledWith('codex',expect.objectContaining({variable:expect.stringContaining('冻结的杠杆领域资料')}),expect.objectContaining({timeoutMs:300000}));
 expect(mocks.api).not.toHaveBeenCalled();expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({name:'exploration/planner-call',sourceRefs:['k1']}),expect.anything());
});
it('host failure never silently switches to configured API',async()=>{
 mocks.host.mockRejectedValue(new Error('host failed'));
 await expect(askExplorationPlanner({runId:'run',projectId:'project',prompt:'x'})).rejects.toThrow('host failed');expect(mocks.api).not.toHaveBeenCalled();
});
it('does not silently switch an unsupported run runtime',async()=>{
 mocks.runtime='penguin';await expect(askExplorationPlanner({runId:'run',projectId:'project'})).rejects.toThrow('unsupported');expect(mocks.api).not.toHaveBeenCalled();
});
it('run-scoped requests cannot lose project scope and fall back to an API model',async()=>{
 await expect(askExplorationPlanner({runId:'run'})).rejects.toThrow('project_required');expect(mocks.api).not.toHaveBeenCalled();expect(mocks.host).not.toHaveBeenCalled();
});

it('gives exploration only knowledge whose roles include source, plus rule packs, and says when a screenshot could not be passed',async()=>{
 mocks.revisions=[{id:'k1',name:'knowledge/cases-only.md',revision:1},{id:'k2',name:'knowledge/for-source.md',revision:1},{id:'k3',name:'knowledge/rulepack/p',revision:1}];
 mocks.contents={k1:{text:'CASES ONLY',roles:['cases']},k2:{text:'SOURCE OK',roles:['source','stories']},k3:{rulePack:{id:'p'}}};
 await askExplorationPlanner({runId:'run',projectId:'project',prompt:'x',imageDataUrl:'data:image/png;base64,AA'});
 const variable=mocks.host.mock.calls[0][1].variable as string;
 expect(variable).toContain('SOURCE OK');expect(variable).not.toContain('CASES ONLY');expect(variable).toContain('"id":"p"');
 expect(mocks.put.mock.calls[0][0].content).toMatchObject({imagesDropped:true});
});
it('cancelling the run aborts the waiting host call',async()=>{
 let signal:AbortSignal|undefined;
 mocks.host.mockImplementation((_h:string,_r:unknown,o:{signal:AbortSignal})=>{signal=o.signal;return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('planner_host_cancelled'))));});
 const pending=askExplorationPlanner({runId:'run-c',projectId:'project',prompt:'x'});
 await vi.waitFor(()=>expect(signal).toBeDefined());
 cancelExplorationPlanner('run-c');
 await expect(pending).rejects.toThrow('planner_host_cancelled');expect(signal!.aborted).toBe(true);
});
