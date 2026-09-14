import { navigateProject } from './projectContext';
export const openCard = (id: string): void => navigateProject(id);
export const closeCard = (): void => navigateProject('canvas');
export const openRunOnCanvas = (runId: string): void => navigateProject('canvas', {runId,revisionId:'',nodeId:''});
