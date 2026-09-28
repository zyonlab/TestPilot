import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({host:vi.fn(),api:vi.fn(),put:vi.fn(),runtime:'codex',revisions:[{id:'k1',name:'knowledge/domain.md',revision:1}]}));
vi.mock('../src/plannerHost.js',()=>({nativeHostChat:mocks.host}));
vi.mock('../src/modelProfiles.js',()=>({projectPlannerModel:()=>({chat:mocks.api})}));
vi.mock('../src/runService.js',()=>({runLedger:()=>({requireRun:()=>({input:{parameters:{plannerRuntime:mocks.runtime}}}),listRevisions:()=>mocks.revisions,readRevision:()=>({content:{text:'冻结的杠杆领域资料'}}),putRevision:mocks.put})}));
import {askExplorationPlanner} from '../src/explorationPlanner.js';
beforeEach(()=>{vi.clearAllMocks();mocks.runtime='codex';mocks.host.mockResolvedValue({text:'{"business":"交易","stories":[],"decisions":[]}',tokens:12,ms:10});});
it('uses run-bound native host and frozen knowledge, saves call evidence',async()=>{
 await askExplorationPlanner({runId:'run',projectId:'project',prompt:'控件清单'});
 expect(mocks.host).toHaveBeenCalledWith('codex',expect.objectContaining({variable:expect.stringContaining('冻结的杠杆领域资料')}),{timeoutMs:300000});
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
