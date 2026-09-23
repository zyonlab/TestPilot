import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root='/Users/admin/Midscene/testpilot', dir=new URL('./',import.meta.url);
const req=createRequire(root+'/packages/testpilot-mcp/package.json');
const {register}=await import(pathToFileURL(req.resolve('tsx/esm/api')).href);register();
const {validateRulePack}=await import(pathToFileURL(root+'/packages/harness-testing/src/domain/rules.ts').href);
const pack=JSON.parse(readFileSync(new URL('rule-pack.json',dir),'utf8'));
const validated=validateRulePack(pack);
if(!validated.ok)throw new Error(JSON.stringify(validated.errors));
console.log(JSON.stringify({rulePackValidation:true,hash:validated.hash}));
const {Client}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const cfg=JSON.parse(readFileSync('/Users/admin/plugins/testpilot-codex/.mcp.json','utf8')).mcpServers.testpilot;
const client=new Client({name:'hyperliquid-project-onboarding',version:'1.0.0'});
const receiptPath=new URL('installation-receipt.json',dir);
let receipt=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):{};
const persist=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
async function call(action,body,params){const out=await client.callTool({name:'tp_project',arguments:{action,...(body?{body}:{}),...(params?{params}:{})}});if(out.isError)throw new Error(JSON.stringify(out.content));return JSON.parse(out.content.find(x=>x.type==='text').text);}
try{
 await client.connect(new StdioClientTransport({...cfg,env:{...process.env,...cfg.env},stderr:'pipe'}));
 if(!receipt.project){receipt.project=(await call('create',{name:'Hyperliquid Testnet · 合约交易全生命周期与资金准确性',targetUrl:'https://app.hyperliquid-testnet.xyz/trade',targetPlatform:'web'})).project;persist();}
 const params={id:receipt.project.id};
 if(!receipt.environment){
 const fixture=JSON.parse(readFileSync(root+'/fixtures/hyperliquid-testnet/cases.json','utf8')).environment;
 receipt.environment=(await call('add_environment',{name:'testnet-injected-wallet',baseUrl:'https://app.hyperliquid-testnet.xyz/trade',viewport:{width:1600,height:1000},isDefault:true,injectWallet:true,capabilities:[],vars:{TP_NETWORK_SCOPE:'hyperliquid-testnet-only',TP_WALLET_VERIFICATION:'pending-first-authenticated-run',TP_ACCOUNT_MODE_POLICY:'observe-current-mode-before-changing',TP_FINANCIAL_ORACLE:'decimal-ui-snapshot'},login:{authRequired:true,steps:fixture.login.steps}},params)).environment;persist();}
 receipt.domainReference=await call('add_domain_reference',{title:'Hyperliquid 测试网：合约全生命周期与资金准确性 · 2026-09-20',text:readFileSync(new URL('domain-reference.md',dir),'utf8')},params);persist();
 receipt.rulePack=await call('add_rule_pack',{pack:validated.pack},params);persist();
 await call('update',{materials:['site-observations.md','scope.md','domain-reference.md','rule-pack.json'].map(x=>fileURLToPath(new URL(x,dir)))},params);
 const refs=await call('domain_references',undefined,params), packs=await call('rule_packs',undefined,params), environments=await call('environments',undefined,params);
 const saved=packs.packs.find(p=>p.hash===validated.hash);
 if(!saved?.valid)throw new Error('rule pack not readable/valid after save');
 const reread=await call('rule_pack',undefined,{...params,hash:validated.hash});
 const ref=refs.references.find(r=>r.title.includes('2026-09-20'));
 if(!ref)throw new Error('domain reference missing');
 const refFull=await call('domain_reference',undefined,{...params,hash:ref.hash});
 if(refFull.reference.text!==readFileSync(new URL('domain-reference.md',dir),'utf8').trim())throw new Error('domain text differs');
 const env=environments.environments.find(e=>e.id===receipt.environment.id);
 if(!env?.injectWallet||env.viewport?.width!==1600||!env.login?.authRequired)throw new Error('environment config mismatch');
 receipt.verification={readBack:true,rulePackValid:true,rulePackHash:validated.hash,domainHash:ref.hash,injectWallet:env.injectWallet,walletSessionVerified:false,liveTradesExecuted:false,modules:reread.pack.modules.length,features:reread.pack.features.length,rules:reread.pack.rules.length,lifecycle:reread.pack.lifecycle.length};persist();
 console.log(JSON.stringify({projectId:receipt.project.id,environmentId:env.id,...receipt.verification},null,2));
}finally{await client.close();}
