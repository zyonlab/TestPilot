import {it,expect,vi,afterEach} from 'vitest';
import {activateScopedControl,availableControlSelectors} from '../src/exec/controlScope.js';
afterEach(()=>vi.unstubAllGlobals());
function fixture(occluded:boolean){
 const click=vi.fn(),el={innerText:'Limit',getBoundingClientRect:()=>({width:100,height:30,left:0,top:0}),matches:()=>false,getAttribute:()=>null,scrollIntoView:vi.fn(),contains:()=>false,click};
 vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',display:'block'}));
 vi.stubGlobal('document',{querySelector:()=>el,querySelectorAll:()=>[el],elementFromPoint:()=>occluded?{}:el});return click;
}
it('does not programmatically click a background component covered by a popup',()=>{
 const click=fixture(true);expect(activateScopedControl({sel:'#limit',label:'Limit'})).toBe('ambiguous:occluded');expect(click).not.toHaveBeenCalled();
});
it('activates the observed exact control when it is hit-testable',()=>{
 const click=fixture(false);expect(activateScopedControl({sel:'#limit',label:'Limit'})).toBe('selector');expect(click).toHaveBeenCalledOnce();
});
it('browser activation is serializable without process-local helpers',()=>{
 fixture(false);
 const evaluate=new Function(`return (${activateScopedControl.toString()})`)();
 expect(evaluate({sel:'#limit',label:'Limit'})).toBe('selector');
});

it('excludes occluded controls before planning without consuming background targets',()=>{
 fixture(true);expect(availableControlSelectors(['#limit'])).toEqual([]);
 fixture(false);expect(availableControlSelectors(['#limit'])).toEqual(['#limit']);
 const evaluate=new Function(`return (${availableControlSelectors.toString()})`)();
 expect(evaluate(['#limit'])).toEqual(['#limit']);
});
