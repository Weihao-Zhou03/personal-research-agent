import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {KnowledgeStore} from '../lib/kb/knowledge-store.mjs';
import {ResearchJobs} from '../lib/jobs/research-jobs.mjs';
import {hashText,INDEX_VERSION} from '../lib/kb/text.mjs';
import {readProxyKey} from '../lib/proxy-config.mjs';
import {environmentKey,environmentModel} from '../lib/research-config.mjs';

// Explicit opt-in. Only the checked-in public synthetic corpus is ever sent.
const args=process.argv.slice(2),local=args.includes('--local-proxy');
if(!args.includes('--allow-generation')||!args.includes('--output'))throw Error('Usage: node eval/run-model.mjs --allow-generation [--local-proxy] --output report.json');
const output=path.resolve(args[args.indexOf('--output')+1] || '');
const config=local?{provider:'openai',baseUrl:'http://127.0.0.1:8317/v1',model:'gpt-6-luna'}:environmentModel();
const key=local?readProxyKey():environmentKey(config);if(!key)throw Error('Configure the key in a private environment/key file; do not paste it into logs or chat.');
const connection=await fetch(`${config.baseUrl}/models`,{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(10000)}).catch(()=>null);
if(!connection?.ok)throw Error('Model preflight unavailable; no evaluation jobs were created. Start the configured service and rerun explicitly.');
const list=await connection.json();if(!list.data?.some(m=>m.id===config.model))throw Error('Configured model is not listed; no generation was attempted.');
const datasetText=readFileSync(new URL('./lexical-cases.json',import.meta.url),'utf8'),dataset=JSON.parse(datasetText);
const startId=args.includes('--start-id')?args[args.indexOf('--start-id')+1]:null;
if(startId&&!dataset.questions.some(q=>q.id===startId))throw Error('Unknown start question ID');
const directory=mkdtempSync(path.join(tmpdir(),'research-model-eval-')),store=new SQLiteStore({filename:path.join(directory,'eval.sqlite')});
let jobs,report;
try{
  const capture=new CaptureService(store),workspace=capture.createWorkspace('公开合成模型评测'),kb=new KnowledgeStore(store),sourceIds=new Map();
  for(const source of dataset.sources){const row=kb.importText({workspaceId:workspace.id,title:source.title,text:source.text,externalId:source.external_id});sourceIds.set(source.external_id,row.source_id);}
  let providerOutputs=[];
  jobs=new ResearchJobs(store,{knowledge:kb,modelConfig:config,resolveKey:()=>key,autoStart:false,fetchImpl:async(...input)=>{const response=await fetch(...input);if(args.includes('--record-public-output')&&response.ok){try{const payload=await response.clone().json();providerOutputs.push({content:payload.choices?.[0]?.message?.content,finish_reason:payload.choices?.[0]?.finish_reason});}catch{}}return response;}});
  report={schema_version:'1',eval:dataset.name,data_status:dataset.data_status,dataset_sha256:hashText(datasetText),source_commit_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),node:process.version,index_version:INDEX_VERSION,started_at:new Date().toISOString(),results:[],semantic_review:'pending; structural validity is not factual support',not_verified:['real_private_corpus','Watch_device','human_semantic_review']};
  for(const q of dataset.questions.slice(startId?dataset.questions.findIndex(q=>q.id===startId):0)){
    providerOutputs=[];
    const start=performance.now(),candidates=kb.evidence(workspace.id,kb.currentRevision(workspace.id),q.question);
    const accepted=jobs.submit({ownerId:capture.ownerId,deviceId:'public-eval',workspaceId:workspace.id,requestId:randomUUID(),question:q.question,createdAtClient:new Date().toISOString()});
    await jobs.runOnce();let job=jobs.get(accepted.response.job_id);
    while(job.status==='waiting_retry'){
      const ms=Math.max(0,Date.parse(job.next_retry_at)-Date.now());
      if(ms>60000){break;}
      await new Promise(resolve=>setTimeout(resolve,ms+10));await jobs.runOnce();job=jobs.get(job.job_id);
    }
    const gold=items=>q.required.map(fact=>({...fact,matched:items.some(e=>e.source_id===sourceIds.get(fact.source)&&e.text.includes(fact.needle))}));
    const actual=gold(job.evidence),retrieved=gold(candidates);
    report.results.push({id:q.id,question:q.question,answerable:q.answerable!==false,necessary_evidence:actual,recall_at_8:retrieved.length?retrieved.filter(x=>x.matched).length/retrieved.length:null,recall_after_input_budget:actual.length?actual.filter(x=>x.matched).length/actual.length:null,candidates,evidence:job.evidence,model_config:job.model_config,prompt_version:job.prompt_version,status:job.status,failure_code:job.failure_code,elapsed_ms:Math.round(performance.now()-start),attempts:job.attempts,result:job.results.at(-1)?.result || null,...(providerOutputs.length?{public_provider_outputs:providerOutputs}:{})});
    report.summary={questions:report.results.length,completed:report.results.filter(x=>x.status==='completed').length,failed:report.results.filter(x=>x.status!=='completed').length,usage:jobs.usage({ownerId:capture.ownerId})};
    writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({id:q.id,status:job.status,calls:job.calls_used,elapsed_ms:report.results.at(-1).elapsed_ms}));
    if(job.status!=='completed'&&(!args.includes('--continue-structural-errors')||!['INVALID_RESULT','MODEL_OUTPUT_INCOMPLETE'].includes(job.failure_code))){report.stopped_early='First failed/ambiguous task stops the batch. Inspect before explicitly starting a new evaluation.';break;}
  }
  report.completed_at=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
}finally{await jobs?.stop();store.close();rmSync(directory,{recursive:true,force:true});}
