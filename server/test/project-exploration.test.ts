import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('persists project exploration defaults and unlimited budget across reads and edits',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tp-exploration-'));
  vi.stubEnv('TP_DATA_DIR',dir);
  const store=await import('../src/db.js');
  try {
    const p=store.createProject('SPA','https://example.test/trade','web',[],0,'current-url');
    expect(store.getProject(p.id)).toMatchObject({explorationMaxScreens:0,explorationScope:'current-url'});
    store.updateProject(p.id,{name:'Renamed'});
    expect(store.getProject(p.id)).toMatchObject({explorationMaxScreens:0,explorationScope:'current-url'});
    store.updateProject(p.id,{explorationMaxScreens:35,explorationScope:'rules'});
    expect(store.listProjects().find(x=>x.id===p.id)).toMatchObject({explorationMaxScreens:35,explorationScope:'rules'});
  } finally {store.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});
