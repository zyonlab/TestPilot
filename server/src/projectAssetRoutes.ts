import {ProjectDiscoveries} from './projectDiscoveries.js';
import {createProjectRunPlan,readProjectRunPlan,projectPlanInputs} from './projectRunPlans.js';
import {createWebWorkflow} from './workflowOps.js';
import {Router} from 'express';
import {ProjectAssets} from './projectAssets.js';
import {assertProject,runLedger} from './runService.js';
import {LedgerError} from './runLedger.js';
import {reviewerPrincipal} from './reviewPrincipal.js';
export function projectAssetRouter(){
 const router=Router({mergeParams:true});
 router.use((req,res,next)=>{try{assertProject((req.params as {projectId:string}).projectId);next();}catch(e){res.status(e instanceof LedgerError?e.status:400).json({code:e instanceof LedgerError?e.code:'asset_request_invalid'});}});
 const wrap=(fn:(req:any)=>unknown)=>(req:any,res:any)=>{try{res.json(fn(req));}catch(e){res.status(e instanceof LedgerError?e.status:400).json({code:e instanceof LedgerError?e.code:'asset_request_invalid'});}};
 const store=()=>new ProjectAssets(runLedger());
 router.post('/plans',wrap(req=>{reviewerPrincipal(req);return createProjectRunPlan(req.params.projectId,req.body);}));
 router.get('/plans/:id',wrap(req=>readProjectRunPlan(req.params.projectId,req.params.id)));
 router.post('/plans/:id/start',async(req,res)=>{try{reviewerPrincipal(req);const project=(req.params as any).projectId;const plan=readProjectRunPlan(project,req.params.id);if(plan.runId){res.json({wfRunId:plan.runId,created:false});return;}const result=await createWebWorkflow(project,projectPlanInputs(project,req.params.id));runLedger().db.prepare('UPDATE project_run_plans SET runId=? WHERE id=?').run(result.wfRunId,plan.id);res.json(result);}catch(e){res.status(e instanceof LedgerError?e.status:400).json({code:e instanceof Error?e.message:'plan_start_failed'});}});
 router.get('/discoveries',wrap(req=>({discoveries:new ProjectDiscoveries(runLedger()).list(req.params.projectId)})));
 router.post('/discoveries/collect',wrap(req=>{reviewerPrincipal(req);const ledger=runLedger(),collector=new ProjectDiscoveries(ledger);for(const r of ledger.listRevisions(req.params.projectId,req.body.runId)){collector.capture(r,ledger.readRevision(r.id,req.params.projectId).content);}return {discoveries:collector.list(req.params.projectId)};}));
 router.post('/discoveries/:id/decision',wrap(req=>new ProjectDiscoveries(runLedger()).decide(req.params.projectId,req.params.id,req.body.status,req.body.reason,reviewerPrincipal(req))));
 router.get('/',wrap(req=>store().list(req.params.projectId)));
 router.post('/candidates',wrap(req=>store().propose(req.params.projectId,req.body,reviewerPrincipal(req))));
 router.get('/versions/:id',wrap(req=>store().read(req.params.projectId,req.params.id)));
 router.post('/versions/:id/decision',wrap(req=>store().decide(req.params.projectId,req.params.id,req.body,reviewerPrincipal(req))));
 router.post('/snapshots',wrap(req=>store().snapshot(req.params.projectId,req.body.label,reviewerPrincipal(req))));
 router.get('/snapshots/:id',wrap(req=>store().readSnapshot(req.params.projectId,req.params.id)));
 return router;
}
