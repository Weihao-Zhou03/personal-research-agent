import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {KnowledgeStore} from '../lib/kb/knowledge-store.mjs';
import {ResearchJobs} from '../lib/jobs/research-jobs.mjs';

const valid=()=>({schema_version:'1',answer_status:'answered',watch_brief:{headline:'资料检索结论',bullets:[{text:'模型依据中文资料生成简报。',citation_ids:['E1']}]},
  sections:[{heading:'依据',statements:[{kind:'fact',text:'研究资料说明模型使用中文资料。',citation_ids:['E1']}]}],limitations:[]});
const response=(value=valid(),extra={})=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],...extra}),{status:200,headers:{'content-type':'application/json'}});
async function fixture(t,{hasEvidence=true,fetchImpl=async()=>response(),config={}}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'research-jobs-')),filename=path.join(dir,'test.sqlite'),store=new SQLiteStore({filename});
  store.initializeEmptyLegacyState();let now=Date.parse('2026-10-21T09:00:00Z');const clock=()=>now;
  const capture=new CaptureService(store,{clock}),workspace=capture.createWorkspace('中文研究'),knowledge=new KnowledgeStore(store,{clock});
  const imported=hasEvidence?knowledge.importText({workspaceId:workspace.id,title:'中文模型研究',text:'研究资料：模型使用中文资料检索生成简报。',externalId:'source-a'}):null;
  let current={provider:'openai',baseUrl:'https://model.example.invalid/v1',model:'test-model',...config},calls=0;
  const workers=[],stores=[store];const create=(targetStore=store,kb=knowledge)=> {
    if(!stores.includes(targetStore)) stores.push(targetStore);
    const jobs=new ResearchJobs(targetStore,{knowledge:kb,clock,modelConfig:()=>current,resolveKey:()=> 'test-only-secret',fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);},autoStart:false});workers.push(jobs);return jobs;
  };
  const jobs=create();
  t.after(async()=>{for(const worker of workers) await worker.stop();for(const openStore of stores) openStore.close();await rm(dir,{recursive:true,force:true});});
  const input=(overrides={})=>({ownerId:capture.ownerId,deviceId:'test_device',workspaceId:workspace.id,requestId:randomUUID(),question:'中文资料模型是什么？',createdAtClient:'2026-10-21T08:59:00Z',...overrides});
  return {store,filename,capture,workspace,knowledge,imported,jobs,input,create,get calls(){return calls;},advance:ms=>{now+=ms;},setConfig:value=>{current={...current,...value};},clock};
}

test('Ask acceptance is durable, owner-operation idempotent and freezes corpus, question, config and budgets',async t=> {
  const f=await fixture(t),input=f.input(),a=f.jobs.submit(input),b=f.jobs.submit({...input,deviceId:'new-device'});
  assert.equal(a.replayed,false);assert.equal(b.replayed,true);assert.equal(a.response.job_id,b.response.job_id);assert.equal(f.calls,0);
  assert.throws(()=>f.jobs.submit({...input,question:'另一个问题'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const newCorpus=f.knowledge.importText({workspaceId:f.workspace.id,title:'新中文资料',text:'新研究资料：模型的新说法。',externalId:'source-a'}).corpus_revision_id;
  assert.notEqual(newCorpus,a.response.corpus_revision_id);
  await f.jobs.runOnce();const view=f.jobs.get(a.response.job_id);
  assert.equal(view.status,'completed');assert.equal(view.calls_used,1);assert.equal(view.model_config.maxCalls,2);
  assert.equal(view.evidence[0].corpus_revision_id,a.response.corpus_revision_id);assert.equal(view.evidence[0].text,'研究资料：模型使用中文资料检索生成简报。');
  assert.equal(view.current_revision,1);assert.equal(view.results[0].result.citations[0].quote,view.evidence[0].text);
  assert.ok(!JSON.stringify(view).includes('test-only-secret'));assert.equal(f.jobs.usage().unknown_usage_calls,1);
});

test('No evidence finishes as insufficient_evidence without a model call, including after restart',async t=> {
  const f=await fixture(t,{hasEvidence:false}),accepted=f.jobs.submit(f.input());
  const replacement=f.create();await replacement.runOnce();const job=replacement.get(accepted.response.job_id);
  assert.equal(job.status,'completed');assert.equal(job.results[0].result.answer_status,'insufficient_evidence');assert.equal(job.calls_used,0);assert.equal(f.calls,0);
  assert.deepEqual(job.results[0].result.citations,[]);assert.equal(replacement.brief(job.job_id).source_count,0);
});

test('SQLite competing workers claim one lease; stale heartbeats and final results are fenced',async t=> {
  const f=await fixture(t);f.jobs.submit(f.input());const otherStore=new SQLiteStore({filename:f.filename});
  const other=f.create(otherStore,new KnowledgeStore(otherStore,{clock:f.clock}));const first=f.jobs.claim();assert.ok(first);
  assert.equal(other.claim(),null);assert.equal(other.heartbeat(first),false);
  f.advance(59000);assert.equal(f.jobs.heartbeat(first),true);f.advance(59000);assert.equal(other.claim(),null);
  f.advance(1001);const resumed=other.claim();assert.equal(resumed.id,first.id);assert.equal(resumed.lease_version,2);
  assert.equal(f.jobs.complete(first,{...valid(),citations:[]}),false);assert.equal(f.jobs.heartbeat(first),false);
  await other.execute(resumed);assert.equal(other.get(first.id).status,'completed');
});

test('Expired lease with a sent unknown request becomes needs_attention; late provider response never completes it',async t=> {
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{fetchImpl:async()=>{entered();return new Promise(resolve=>{release=resolve;});}}),accepted=f.jobs.submit(f.input());
  const execution=f.jobs.runOnce();await started;
  const otherStore=new SQLiteStore({filename:f.filename});const other=f.create(otherStore,new KnowledgeStore(otherStore,{clock:f.clock}));
  f.advance(61000);assert.equal((await other.runOnce()).claimed,false);assert.equal(other.status(accepted.response.job_id).status,'needs_attention');assert.equal(f.calls,1);
  release(response());await execution;
  assert.equal(other.get(accepted.response.job_id).status,'needs_attention');assert.equal(other.get(accepted.response.job_id).results.length,0);assert.equal((await other.runOnce()).claimed,false);
});

test('Network failure after dispatch records unknown usage and never automatically reissues the generation',async t=> {
  const f=await fixture(t,{fetchImpl:async()=>{throw Error('secret upstream failure');}}),a=f.jobs.submit(f.input());
  await f.jobs.runOnce();const job=f.jobs.get(a.response.job_id);assert.equal(job.status,'needs_attention');assert.equal(job.calls_used,1);assert.equal(job.attempts[0].request_sent,1);
  assert.equal(job.attempts[0].response_received,0);assert.equal(job.attempts[0].usage,'unknown');assert.ok(!JSON.stringify(job).includes('secret upstream'));
  f.advance(600000);assert.equal((await f.jobs.runOnce()).claimed,false);assert.equal(f.calls,1);
});

test('429 waits for persisted Retry-After across worker restart and consumes the shared two-call budget',async t=> {
  let sent=0;const f=await fixture(t,{fetchImpl:async()=>++sent===1?new Response('private upstream message',{status:429,headers:{'retry-after':'30'}}):response()}),a=f.jobs.submit(f.input());
  await f.jobs.runOnce();assert.equal(f.jobs.status(a.response.job_id).status,'waiting_retry');assert.equal(f.calls,1);
  const restarted=f.create();assert.equal((await restarted.runOnce()).claimed,false);f.advance(29999);assert.equal((await restarted.runOnce()).claimed,false);
  f.advance(1);await restarted.runOnce();const job=restarted.get(a.response.job_id);assert.equal(job.status,'completed');assert.equal(job.calls_used,2);assert.equal(job.attempts.length,2);
  assert.equal(f.calls,2);assert.ok(!JSON.stringify(job).includes('private upstream'));assert.equal((await restarted.runOnce()).claimed,false);
});

test('429 followed by invalid JSON cannot obtain a third format-repair call',async t=> {
  let sent=0;const f=await fixture(t,{fetchImpl:async()=>++sent===1?new Response('',{status:429,headers:{'retry-after':'1'}}):response({})}),a=f.jobs.submit(f.input());
  await f.jobs.runOnce();f.advance(1000);await f.jobs.runOnce();assert.equal(f.jobs.status(a.response.job_id).status,'failed');assert.equal(f.calls,2);assert.equal((await f.jobs.runOnce()).claimed,false);
});

test('One invalid structured result can be repaired once; repeated invalid citations fail visibly',async t=> {
  let sent=0;const f=await fixture(t,{fetchImpl:async()=>response(++sent===1?{}:valid())}),a=f.jobs.submit(f.input());
  await f.jobs.runOnce();assert.equal(f.jobs.status(a.response.job_id).status,'completed');assert.equal(f.calls,2);assert.equal(f.jobs.get(a.response.job_id).attempts[0].error_code,'INVALID_RESULT');
  const g=await fixture(t,{fetchImpl:async()=>{const result=valid();result.watch_brief.bullets[0].citation_ids=['E404'];return response(result);}}),b=g.jobs.submit(g.input());
  await g.jobs.runOnce();assert.equal(g.jobs.status(b.response.job_id).status,'failed');assert.equal(g.calls,2);assert.equal(g.jobs.get(b.response.job_id).results.length,0);
});

test('Cancellation commits before Abort and a late valid response cannot write a result',async t=> {
  let release,entered,signal;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{fetchImpl:async(url,options)=>{signal=options.signal;entered();return new Promise(resolve=>{release=resolve;});}}),a=f.jobs.submit(f.input());
  const execution=f.jobs.runOnce();await started;assert.equal(f.jobs.cancel(a.response.job_id).status,'cancelled');assert.equal(signal.aborted,true);
  release(response(valid(),{usage:{prompt_tokens:10,completion_tokens:12,total_tokens:22}}));await execution;
  const job=f.jobs.get(a.response.job_id);assert.equal(job.status,'cancelled');assert.equal(job.results.length,0);assert.equal(job.attempts[0].usage.total_tokens,22);
});

test('Deleting a running Ask erases private rows and the tombstone prevents resurrection after a late response',async t=> {
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{fetchImpl:async()=>{entered();return new Promise(resolve=>{release=resolve;});}}),input=f.input(),a=f.jobs.submit(input);
  const execution=f.jobs.runOnce();await started;f.jobs.remove(a.response.job_id);release(response());await execution;
  assert.throws(()=>f.jobs.get(a.response.job_id),e=>e.code==='JOB_NOT_FOUND');
  assert.throws(()=>f.jobs.submit({...input,deviceId:'repaired-device'}),e=>e.code==='RESOURCE_DELETED');
  assert.throws(()=>f.jobs.submit({...input,question:'另一个正文'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  for(const table of ['research_job_evidence','research_job_attempts','research_job_events','research_results','research_jobs']) assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.jobs.remove(a.response.job_id).status,'deleted');assert.equal(f.calls,1);
});

test('Cross-space or stale evidence cannot reach the model or become a result',async t=> {
  const f=await fixture(t),original=f.knowledge.evidence.bind(f.knowledge);
  f.knowledge.evidence=(...args)=>original(...args).map(e=>({...e,workspace_id:'foreign-space'}));const a=f.jobs.submit(f.input());
  await f.jobs.runOnce();assert.equal(f.jobs.status(a.response.job_id).failure_code,'INVALID_EVIDENCE');assert.equal(f.calls,0);
  f.knowledge.evidence=(...args)=>original(...args).map(e=>({...e,text:'篡改后的原文'}));const b=f.jobs.submit(f.input());await f.jobs.runOnce();assert.equal(f.jobs.status(b.response.job_id).failure_code,'INVALID_EVIDENCE');assert.equal(f.calls,0);
});

test('Daily and queue limits reject new IDs but idempotent replay remains available; Unicode input is bounded',async t=> {
  const f=await fixture(t,{config:{dailyLimit:2,queueLimit:1}}),input=f.input(),a=f.jobs.submit(input);
  assert.throws(()=>f.jobs.submit(f.input()),e=>e.code==='ASK_QUEUE_FULL');assert.equal(f.jobs.submit(input).response.job_id,a.response.job_id);
  f.jobs.cancel(a.response.job_id);f.jobs.submit(f.input());assert.throws(()=>f.jobs.submit(f.input()),e=>e.code==='DAILY_ASK_LIMIT');
  assert.throws(()=>f.jobs.submit(f.input({question:'🙂'.repeat(1001)})),e=>e.code==='INVALID_ASK');
  f.advance(86400000);f.jobs.cancel(f.jobs.list({workspaceIds:[f.workspace.id]}).items.find(r=>r.status==='queued').id);assert.equal(f.jobs.submit(f.input()).replayed,false);
});

test('Reading status, brief, feed, usage and readiness never invokes a model; pagination is stable',async t=> {
  const f=await fixture(t),a=f.jobs.submit(f.input()),b=f.jobs.submit(f.input());
  for(let i=0;i<3;i++) {f.jobs.get(a.response.job_id);f.jobs.status(a.response.job_id);f.jobs.brief(a.response.job_id);f.jobs.usage();f.jobs.readiness();}
  const first=f.jobs.list({workspaceIds:[f.workspace.id],limit:1}),second=f.jobs.list({workspaceIds:[f.workspace.id],limit:1,cursor:first.next_cursor});
  assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);assert.deepEqual(f.jobs.list({workspaceIds:[]}).items,[]);
  assert.throws(()=>f.jobs.list({workspaceIds:['foreign'],cursor:first.next_cursor}),e=>e.code==='INVALID_CURSOR');assert.equal(f.calls,0);
  assert.equal(f.jobs.brief(b.response.job_id).watch_brief,null);
});

test('Manual edits create immutable revisions with optimistic hash checks and server-owned citation metadata',async t=> {
  const f=await fixture(t),a=f.jobs.submit(f.input());await f.jobs.runOnce();const initial=f.jobs.get(a.response.job_id),first=initial.results[0],edited=structuredClone(first.result);
  edited.watch_brief.headline='人工核对后的标题';const next=f.jobs.edit(a.response.job_id,{result_revision:1,expected_content_hash:first.content_hash,result:edited});
  assert.equal(next.current_revision,2);assert.equal(next.results[0].content_hash,first.content_hash);assert.equal(next.results[1].editor,'owner');assert.notEqual(next.results[1].content_hash,first.content_hash);
  assert.throws(()=>f.jobs.edit(a.response.job_id,{result_revision:1,expected_content_hash:first.content_hash,result:edited}),e=>e.code==='REVISION_CONFLICT');
  const spoof=structuredClone(next.results[1].result);spoof.citations[0].title='伪造来源';
  assert.throws(()=>f.jobs.edit(a.response.job_id,{result_revision:2,expected_content_hash:next.results[1].content_hash,result:spoof}),e=>e.code==='INVALID_CITATION_METADATA');assert.equal(f.calls,1);
});

test('Model config changes are visible and cannot silently execute queued jobs against a different model',async t=> {
  const f=await fixture(t),input=f.input(),a=f.jobs.submit(input);f.setConfig({model:'different-model'});await f.jobs.runOnce();assert.equal(f.jobs.status(a.response.job_id).failure_code,'MODEL_CONFIG_CHANGED');assert.equal(f.calls,0);
  f.setConfig({inputTokens:999999});assert.equal(f.jobs.submit(input).response.job_id,a.response.job_id);
  const g=await fixture(t,{config:{provider:'unconfigured'}});assert.equal(g.jobs.readiness().code,'MODEL_NOT_CONFIGURED');assert.throws(()=>g.jobs.submit(g.input()),e=>e.code==='MODEL_NOT_CONFIGURED');
});
