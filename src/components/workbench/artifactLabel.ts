/** One label vocabulary for material links and readers across all projects. */
export function artifactLabel(name:string,t:(key:string)=>string):string {
  const labels:Record<string,string>={
    'knowledge/domain-reference':'surface.domainReferences',
    'exploration/observations':'exploration.graph',
    'exploration/report':'artifact.explorationReport',
    'exploration.md':'artifact.explorationNotes',
    'product/model-candidate':'artifact.model',
    'validated/instructions':'artifact.instructions',
    'validated/modules':'workflow.stage.modules',
    'validated/stories':'workflow.stage.stories',
    'validated/cases':'workflow.stage.cases',
    'validated/gate':'workflow.stage.gate',
  };
  if(name.startsWith('compilation-observation/'))return t('observation.stage.compilation');
  if(name.startsWith('g2/'))return t('workflow.kind.code');
  if(name.startsWith('preparation/')){const parts=name.split('/');if(parts[2]==='experience')return t('bench.preparationArtifact.experience');if(parts[3]?.startsWith('context-'))return `${parts[2]} · ${t('bench.preparationArtifact.context')}`;return parts[2]==='instructions'?t('artifact.instructions'):`${parts[2]} · ${parts[3]} · ${t(`bench.preparationArtifact.${parts[4]}`)}`;}
  return labels[name]?t(labels[name]):name.startsWith('knowledge/rulepack/')?`${t('surface.rulePacks')} · ${name.slice('knowledge/rulepack/'.length)}`:name;
}
