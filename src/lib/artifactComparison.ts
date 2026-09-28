import type {Revision} from './workflowRuns';
export const comparisonNodes = ['source','modules','stories','cases','gate','finalize','g2','execution'] as const;
export type ComparisonNode = typeof comparisonNodes[number];
export type ComparisonMode = 'node-version' | 'input-version' | 'pipeline';
export type ComparisonVerdict = 'a-better' | 'same' | 'b-better' | 'incomparable';
export interface ComparisonArm {
  runId:string;
  versions:Record<string,string|null>;
  nodes:Record<ComparisonNode,{outputs:Revision[];inputs:Revision[];inputDigest:string|null;phase:string|null}>;
}
export interface ArtifactComparison {
  schemaVersion:'artifact-comparison.v1';projectId:string;at:string;mode:ComparisonMode;node:ComparisonNode|'all';
  a:ComparisonArm;b:ComparisonArm;
  differences:{field:string;a:string|null;b:string|null;status:'same'|'different'|'unknown'}[];
  limitations:string[];attribution:'diagnostic-only';scorerVersion:'artifact-comparison.v1';
}
export interface ComparisonReview {
  schemaVersion:'artifact-comparison-review.v1';comparisonId:string;node:ComparisonNode|'all';
  dimension:'overall'|'coverage'|'correctness'|'evidence'|'usability'|'noise';verdict:ComparisonVerdict;
  note:string;evidence:string[];at:string;actor:{kind:string;id:string};identityEvidence:'local-action-source';
  promotesBaseline:false;
}
