import{expect,it}from'vitest';import{scopedCacheId}from'../src/exec/cache.js';
it('binds cache replay to model, intent, URL, DOM and rendered scene',()=>{
 const page={url:'https://fixture.test',dom:'<button>Go</button>',scene:'pixels-a'},ctx={model:'m1',intent:'revision1'};const first=scopedCacheId('c1',ctx,page);
 expect(first).toBe(scopedCacheId('c1',{intent:'revision1',model:'m1'},page));
 for(const changed of [{...page,url:page.url+'/v2'},{...page,dom:'<button>Stop</button>'},{...page,scene:'pixels-b'}])expect(scopedCacheId('c1',ctx,changed)).not.toBe(first);
 expect(scopedCacheId('c1',{...ctx,model:'m2'},page)).not.toBe(first);expect(scopedCacheId('c1',{...ctx,intent:'revision2'},page)).not.toBe(first);expect(scopedCacheId(undefined,ctx,page)).toBeUndefined();
});
