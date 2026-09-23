import {it,expect} from 'vitest';
import {STORY_PLANNING_CONTRACT,storyPlanningIssues} from '../src/casegen/planningContract.js';
import {STORIES_STABLE,CASES_STABLE} from '../src/casegen/prompts.js';
it('allows unobserved but supported business acceptance and genuine requirement questions',()=>{
 expect(storyPlanningIssues([{acceptance:['Given 持仓存在 When 全平 Then 释放保证金','【待确认：产品范围】是否支持组合保证金？']}])).toEqual([]);
});
it('rejects exploration coverage being embedded as requirement uncertainty',()=>{
 expect(storyPlanningIssues([{acceptance:['Then 释放保证金【待确认：界面观察不到】']}])).toMatchObject([{code:'observation_gap_in_requirement',jsonPointer:'/stories/0/acceptance/0'}]);
});
it('both generation entrypoints carry the planning versus execution boundary',()=>{
 expect(STORIES_STABLE).toContain(STORY_PLANNING_CONTRACT);
 expect(CASES_STABLE).toContain(STORY_PLANNING_CONTRACT);
});
