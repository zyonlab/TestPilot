import { assessExploration, buildExplorationReport, ExplorationReportSchema, ExplorationAttemptSchema, type ExplorationCharter } from '@testpilot/harness-testing/domain';
import { StateFlowGraphSchema } from '@testpilot/harness-testing/exec';

/** Server-owned evaluation. Never persist a collector/model's completion claim unchanged. */
export function evaluateExplorationResult<T extends {url:string; graph:unknown; report?:unknown; stopped?:{kind:string;n?:number}; partial?:boolean; sourceAttempt?:unknown}>(result:T, charter?:ExplorationCharter) {
  const sourceAttempt=ExplorationAttemptSchema.safeParse(result.sourceAttempt);
  const provenance=sourceAttempt.success?{sourceAttempt:sourceAttempt.data}:{};
  const parsedGraph=StateFlowGraphSchema.safeParse(result.graph);
  const graph=parsedGraph.success?parsedGraph.data:undefined;
  const parsedReport=ExplorationReportSchema.safeParse(result.report);
  const stop=result.partial?{kind:'failed'}:result.stopped??{kind:'unknown'};
  if(charter && graph && parsedReport.success) {
    if(parsedReport.data.charterId!==charter.id || parsedReport.data.rulePack.hash!==charter.rulePack.hash || parsedReport.data.entryUrl!==charter.scope.entryUrl)throw new Error('exploration_report_scope_mismatch');
    const report=buildExplorationReport({charter,graph,targets:parsedReport.data.targets,observations:parsedReport.data.observations,stop,budget:parsedReport.data.budget,unknowns:parsedReport.data.unknowns});
    return {...result,report:{...report,...provenance},assessment:report.assessment};
  }
  const assessment=assessExploration({entryUrl:result.url,charter,graph,stop});
  return {...result,assessment,report:{schemaVersion:'exploration-summary.v1',entryUrl:result.url,assessment,stopReason:stop,...provenance}};
}
