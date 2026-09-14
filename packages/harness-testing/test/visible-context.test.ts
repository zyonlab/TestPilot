import {expect,it} from 'vitest';
import {visibleContextTree} from '../src/exec/visibleContext.js';
it('keeps visible descendants and their IDs without mutating the full document',()=>{
 const tree={node:null,children:[{node:{isVisible:false,id:'container'},children:[{node:{isVisible:true,id:'nav'},children:[]}]},{node:{isVisible:false,id:'offscreen'},children:[]}]};
 const before=JSON.stringify(tree),view=visibleContextTree(tree);
 expect(view.children).toHaveLength(1);expect(view.children[0].node).toBeNull();expect(view.children[0].children[0].node?.id).toBe('nav');expect(JSON.stringify(tree)).toBe(before);
});
