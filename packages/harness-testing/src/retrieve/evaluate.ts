import { createHash } from 'node:crypto';
import { buildIndexFromDocs, retrieve } from './index.js';

export interface RetrievalFixture {
  version:1;
  purpose:'synthetic-retrieval-regression';
  docs:Array<{docId:string;text:string}>;
  queries:Array<{id:string;query:string;budgetTokens:number;chunkIds?:string[];required:string[]|null;relevant:string[]|null;note:string}>;
}
/** Fixed human-readable labels, not a production acceptance gate or a semantic judge. */
export function evaluateRetrieval(fixture:RetrievalFixture){
  const digest=createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
  const index=buildIndexFromDocs(fixture.docs,digest);
  return {version:1,algorithm:'bm25-relations-v1',fixtureDigest:digest,purpose:fixture.purpose,gate:null,
    cases:fixture.queries.map(q=>{
      const result=retrieve(index,q.query,q.budgetTokens,{chunkIds:q.chunkIds});
      const selected=result.chunks.map(c=>c.id),set=new Set(selected);
      const required=q.required===null?null:[...new Set(q.required)];
      const relevant=q.relevant===null?null:new Set(q.relevant);
      const missingIds=required?.filter(id=>!set.has(id))??null;
      const unknownLabelIds=[...new Set([...(required??[]),...(relevant??[])])].filter(id=>!index.chunks.some(c=>c.id===id));
      const valid=unknownLabelIds.length===0;
      return {id:q.id,selectedIds:selected,requiredRecall:valid&&required?.length?(required.length-missingIds!.length)/required.length:null,
        relevantPrecision:valid&&relevant&&selected.length?selected.filter(id=>relevant.has(id)).length/selected.length:null,
        missingIds,unknownLabelIds,
        assessment:!valid?'invalid-labels':required!==null&&relevant!==null?'labeled-synthetic':'unassessed',
        estimatedTokens:result.diagnostics.estimatedTokens,budgetTokens:q.budgetTokens,
        budgetUtilization:q.budgetTokens?result.diagnostics.estimatedTokens/q.budgetTokens:null,
        diagnostics:result.diagnostics};
    })};
}
