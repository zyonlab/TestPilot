import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((key:string)=>translate(key,'zh'))}));
import {StoryRequirementsPanel} from '../../src/components/workbench/StoryRequirementsReview';
const data={pending:true,revisionId:'r1',candidates:[{id:'S1',title:'候选资产查询',acceptance:['切换账户后显示所选账户余额'],requirementDraft:{reason:'源规则为假设',questions:['余额范围是否包含未结算盈亏？']}}]};
it('shows proposed criteria and missing business decisions, not an execution pass; prevents approval while host writes',()=>{
 const html=renderToStaticMarkup(<StoryRequirementsPanel data={data} error="" busy={false} status="running" approve={async()=>{}}/>);
 for(const s of ['候选资产查询','余额范围是否包含未结算盈亏','确认前不会进入用例设计','不代表测试通过','disabled=""'])expect(html).toContain(s);
 const ready=renderToStaticMarkup(<StoryRequirementsPanel data={data} error="版本已更新" busy={false} status="waiting_review" approve={async()=>{}}/>);
 expect(ready).not.toContain('disabled=""');expect(ready).toContain('版本已更新');
});
it('removes the confirmation action after this revision has been approved',()=>{
 expect(renderToStaticMarkup(<StoryRequirementsPanel data={{...data,pending:false}} error="" busy={false} status="paused" approve={async()=>{}}/>)).toBe('');
});

it('shows the origin of inherited approval without another approval button',()=>{
 const html=renderToStaticMarkup(<StoryRequirementsPanel data={{...data,pending:false,inheritedFromRun:'run-reviewed-parent'}} error="" busy={false} status="paused" approve={async()=>{}}/>);
 expect(html).toContain('已沿用原人工审批');expect(html).toContain('run-reviewed-parent');expect(html).not.toContain('<button');
});
