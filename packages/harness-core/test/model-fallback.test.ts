import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIModel } from '../src/model/openai.js';
afterEach(()=>vi.unstubAllGlobals());
for(const status of [429,502])it(`does not make an unbudgeted schema fallback request for HTTP ${status}`,async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'stop'}),{status}));vi.stubGlobal('fetch',fetch);
 const model=new OpenAIModel({baseUrl:'https://fixture.test/v1',apiKey:'fixture',model:'fixture',retries:0});
 await expect(model.chat({stable:'fixed',variable:'input',schema:{type:'object'}})).rejects.toThrow(`HTTP ${status}`);expect(fetch).toHaveBeenCalledTimes(1);
});
