import {expect,it,vi} from 'vitest';
import {trackSourceSession,cancelSourceSession} from '../src/sourceSessions.js';
it('cancels only the requested workflow and releases completed sessions',async()=>{
 const a=vi.fn().mockResolvedValue(undefined), b=vi.fn().mockResolvedValue(undefined);
 const offA=trackSourceSession('a',a),offB=trackSourceSession('b',b);
 await cancelSourceSession('a');expect(a).toHaveBeenCalledOnce();expect(b).not.toHaveBeenCalled();
 offA();await cancelSourceSession('a');expect(a).toHaveBeenCalledOnce();offB();
});
it('old completion cannot remove replacement session',async()=>{
 const old=trackSourceSession('same',async()=>{}), stop=vi.fn().mockResolvedValue(undefined);
 const off=trackSourceSession('same',stop);old();await cancelSourceSession('same');expect(stop).toHaveBeenCalledOnce();off();
});
