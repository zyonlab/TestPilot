import {expect,it} from 'vitest';
import {executionObserver,readExecutionObservation} from '../src/execution-observation.js';
it('measures sequential spans and observed requests without turning zero calls into cache hits',()=>{
 let now=10;const o=executionObserver(()=>now);const requests:{forwarded:boolean}[]=[];
 o.begin('session-navigation');o.source(()=>requests);now=30;o.begin('actions');requests.push({forwarded:true},{forwarded:false});now=70;o.issue('failed',{attribution:'infra',retryable:true});o.end();
 expect(o.data.stages.map(s=>s.durationMs)).toEqual([20,40]);
 expect(o.data.stages.map(s=>s.model.forwarded)).toEqual([0,1]);expect(o.data.stages[1].model.blocked).toBe(1);expect(o.data.cache.midscene).toBe('unknown');
});
it('keeps missing and partially known request records unknown and strips sensitive fields',()=>{
 const o=executionObserver();o.begin('dispatch');o.issue('cancelled');o.end();
 expect(o.data.stages[0]).toMatchObject({status:'cancelled',model:{source:'unavailable',forwarded:null}});
 const parsed=readExecutionObservation({...o.data,url:'secret',stages:[{...o.data.stages[0],prompt:'secret',model:{...o.data.stages[0].model,endpoint:'secret'}}]});
 expect(JSON.stringify(parsed)).not.toContain('secret');expect(readExecutionObservation(undefined)).toBeNull();expect(readExecutionObservation({version:2})).toBeNull();
 const partial=executionObserver();partial.source(()=>[{}]);partial.begin('actions');partial.end();expect(partial.data.stages[0].model.forwarded).toBeNull();
});
