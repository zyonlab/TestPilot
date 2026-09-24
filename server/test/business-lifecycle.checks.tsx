import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((key:string)=>translate(key,'zh'))}));
import {BusinessLifecycle} from '../../src/components/workbench/BusinessLifecycle';
const transition={id:'close',featureId:'position.close',name:'平仓',claimType:'hypothesis',preconditions:['存在非零持仓；挂单不等于持仓'],action:'平仓',outcome:'核对剩余持仓',failureModes:['未成交','拒绝'],preparation:'需授权的测试持仓与清理方案',sourceRefs:['example']};
it('shows missing state, candidate provenance and missing stories without suggesting observed completion',()=>{
 const html=renderToStaticMarkup(<BusinessLifecycle transitions={[transition]} stories={[]}/>);
 for(const text of ['存在非零持仓','领域假设待确认','缺少故事关联','需授权的测试持仓','不代表页面已观察'])expect(html).toContain(text);
});
it('shows exact success and rejection criteria, and old artifacts remain unknown',()=>{
 const html=renderToStaticMarkup(<BusinessLifecycle transitions={[transition]} stories={[{id:'S1',title:'关闭持仓',acceptance:['成交后持仓减少','拒绝后持仓保持'],businessTransitions:[{transitionId:'close',preconditions:transition.preconditions,acceptanceIndexes:[0],failureAcceptanceIndexes:[1]}]}]}/>);
 expect(html).toContain('成交后持仓减少');expect(html).toContain('拒绝后持仓保持');expect(html).toContain('已关联故事');
 expect(renderToStaticMarkup(<BusinessLifecycle/>)).toContain('生命周期覆盖未知');
});
