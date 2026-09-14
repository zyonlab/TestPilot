import {afterEach,expect,it,vi} from 'vitest';
import {projectHref,readProjectContext} from '../../src/lib/projectContext';
afterEach(()=>vi.unstubAllGlobals());
const route='#/?open=canvas&project=a&run=run-a&artifact=rev-a&node=stories&scope=module-a';
it('keeps the full identity when navigating between views',()=>{vi.stubGlobal('location',{hash:route});expect(readProjectContext()).toEqual({projectId:'a',runId:'run-a',revisionId:'rev-a',nodeId:'stories',scope:'module-a'});expect(projectHref('artifacts')).toContain('artifact=rev-a');});
it('invalidates child context on project or run selection',()=>{vi.stubGlobal('location',{hash:route});expect(projectHref('canvas',{projectId:'b'})).toBe('#/?open=canvas&project=b');expect(projectHref('canvas',{runId:'run-b'})).toBe('#/?open=canvas&project=a&run=run-b');});
it('encodes identities without turning their text into query parameters',()=>{vi.stubGlobal('location',{hash:route});const p=new URLSearchParams(projectHref('artifacts',{runId:'run&project=wrong'}).split('?')[1]);expect(p.get('project')).toBe('a');expect(p.get('run')).toBe('run&project=wrong');expect(p.has('artifact')).toBe(false);});
