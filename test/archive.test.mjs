import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {KnowledgeStore} from '../lib/kb/knowledge-store.mjs';
import {ResearchJobs} from '../lib/jobs/research-jobs.mjs';
import {ResearchArchive} from '../lib/archive.mjs';
import {ThinkFlowClient} from '../lib/thinkflow.mjs';

const valid=()=>({schema_version:'1',answer_status:'answered',watch_brief:{headline:'研究简报',bullets:[{text:'中文模型使用资料检索。',citation_ids:['E1']}]},
  sections:[{heading:'依据',statements:[{kind:'fact',text:'中文模型依据资料回答。',citation_ids:['E1']}]}],limitations:[]});
async function fixture(t) {
  const native={docs:[],calls:[],loseAfterCreate:false,readMismatch:false,listMore:false,hold:null,entered:null};
  const upstream=http.createServer(async(req,res)=> {
    let raw='';for await(const chunk of req) raw+=chunk;const body=raw?JSON.parse(raw):null,url=new URL(req.url,'http://localhost');
    native.calls.push({method:req.method,path:url.pathname,body});assert.equal(req.headers['x-api-key'],'test-only-upstream-key');
    let data={success:true};
    if(url.pathname==='/api/v1/kb/notebooks') data.notebooks=[{id:'nb_1',name:'研究笔记'}];
    else if(url.pathname==='/api/v1/kb/documents' && req.method==='GET') {data.documents=native.docs.map(d=>({...d,content:''}));if(native.listMore) data.has_more=true;}
    else if(url.pathname==='/api/v1/kb/documents' && req.method==='POST') {
      if(native.entered) native.entered();if(native.hold) await native.hold;
      const document={...body,id:`doc_${native.docs.length+1}`};native.docs.push(document);data.document=document;
      if(native.loseAfterCreate) {native.loseAfterCreate=false;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"private raw failure"}');return;}
    } else if(url.pathname.startsWith('/api/v1/kb/documents/')) {
      const document=native.docs.find(d=>d.id===decodeURIComponent(url.pathname.split('/').at(-1)));
      data.document=native.readMismatch?{...document,content:'external change'}:document;
    } else {res.writeHead(404);res.end('{}');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const client=new ThinkFlowClient({baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'test-only-upstream-key'});
  const dir=await mkdtemp(path.join(os.tmpdir(),'research-archive-')),filename=path.join(dir,'archive.sqlite'),store=new SQLiteStore({filename});store.initializeEmptyLegacyState();
  let now=Date.parse('2026-10-21T09:00:00Z');const clock=()=>now,capture=new CaptureService(store,{clock}),workspace=capture.createWorkspace('研究空间'),knowledge=new KnowledgeStore(store,{clock});
  knowledge.importText({workspaceId:workspace.id,title:'原文<script>标题',text:'中文模型依据资料检索回答。',externalId:'original'});
  await knowledge.bindThinkFlow(workspace.id,{notebookId:'nb_1',client});
  const jobs=new ResearchJobs(store,{knowledge,clock,modelConfig:{provider:'openai',baseUrl:'https://model.example.invalid/v1',model:'test-model'},
    fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(valid())}}]}),{status:200}),autoStart:false});
  const accepted=jobs.submit({ownerId:capture.ownerId,deviceId:'test-device',workspaceId:workspace.id,requestId:randomUUID(),question:'中文模型如何回答？',createdAtClient:'2026-10-21T08:00:00Z'});
  await jobs.runOnce();const jobId=accepted.response.job_id,archives=[],stores=[store];
  const create=(targetStore=store,targetJobs=jobs,targetKnowledge=knowledge)=>{if(!stores.includes(targetStore)) stores.push(targetStore);const archive=new ResearchArchive(targetStore,{jobs:targetJobs,knowledge:targetKnowledge,thinkflowClient:client,clock});archives.push(archive);return archive;};
  const archive=create();
  t.after(async()=>{for(const a of archives) await a.stop();await jobs.stop();for(const s of stores) s.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  const confirmation=(overrides={})=>{const job=jobs.get(jobId),result=job.results.at(-1);return {result_revision:result.result_revision,expected_content_hash:result.content_hash,write_to_thinkflow:true,...overrides};};
  return {native,client,store,filename,capture,workspace,knowledge,jobs,jobId,archive,create,confirmation,clock,advance:ms=>{now+=ms;}};
}

test('Completed answers never write until confirmation; local archive and verified upstream state are separate',async t=> {
  const f=await fixture(t);await f.archive.drainOnce();assert.equal(f.native.docs.length,0);assert.deepEqual(f.archive.getForJob(f.jobId).archives,[]);
  const local=f.archive.confirm(f.jobId,f.confirmation({write_to_thinkflow:false}));assert.equal(local.status,'archived');assert.equal(local.writeback_status,'not_requested');await f.archive.drainOnce();assert.equal(f.native.docs.length,0);
  const queued=f.archive.confirm(f.jobId,f.confirmation());assert.equal(queued.archive_id,local.archive_id);assert.equal(queued.writeback_status,'queued');assert.equal(f.native.docs.length,0);
  await f.archive.drainOnce();const saved=f.archive.getForJob(f.jobId).archives[0];assert.equal(saved.writeback_status,'verified');assert.equal(f.native.docs.length,1);
  assert.equal(f.native.docs[0].metadata.personal_agent_writeback_intent_id,queued.intent_id);assert.equal(f.native.docs[0].metadata.result_revision,1);assert.equal(f.native.docs[0].metadata.source_refs[0].source_version_id,f.jobs.get(f.jobId).evidence[0].source_version_id);
  assert.equal(saved.markdown,f.native.docs[0].content);assert.ok(!JSON.stringify(saved).includes('test-only-upstream-key'));assert.ok(!saved.markdown.includes('<script>'));assert.ok(saved.markdown.includes('&lt;script&gt;'));
});

test('Repeated confirmation reuses one intent; editing creates a new revision and a new document',async t=> {
  const f=await fixture(t),first=f.archive.confirm(f.jobId,f.confirmation());assert.deepEqual(f.archive.confirm(f.jobId,f.confirmation()),first);
  await f.archive.drainOnce();assert.equal(f.native.docs.length,1);
  const job=f.jobs.get(f.jobId),record=job.results[0],result=structuredClone(record.result);result.watch_brief.headline='人工核对的新版本';
  f.jobs.edit(f.jobId,{result_revision:1,expected_content_hash:record.content_hash,result});const second=f.archive.confirm(f.jobId,f.confirmation());assert.notEqual(second.intent_id,first.intent_id);
  await f.archive.drainOnce();assert.equal(f.native.docs.length,2);assert.notEqual(f.native.docs[0].metadata.personal_agent_writeback_intent_id,f.native.docs[1].metadata.personal_agent_writeback_intent_id);
  assert.equal(f.native.docs[0].metadata.result_revision,1);assert.equal(f.native.docs[1].metadata.result_revision,2);assert.equal(f.archive.getForJob(f.jobId).archives.length,2);
});

test('Lost write response survives restart and explicit reconciliation verifies one real document without another POST',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());f.native.loseAfterCreate=true;
  await f.archive.drainOnce();assert.equal(f.native.docs.length,1);assert.equal(f.archive.getForJob(f.jobId).archives[0].writeback_status,'reconciliation_required');
  const restarted=f.create();assert.equal((await restarted.drainOnce()).claimed,false);const result=await restarted.reconcile(receipt.intent_id);
  assert.equal(result.status,'verified');assert.equal(f.native.docs.length,1);assert.equal(f.native.calls.filter(c=>c.method==='POST' && c.path.endsWith('/documents')).length,1);
  assert.ok(!JSON.stringify(result).includes('private raw failure'));
});

test('A dispatched intent missing upstream requires attention and never blindly creates again',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());f.native.loseAfterCreate=true;await f.archive.drainOnce();f.native.docs=[];
  const restarted=f.create();assert.equal((await restarted.reconcile(receipt.intent_id)).status,'needs_attention');assert.equal((await restarted.reconcile(receipt.intent_id)).status,'needs_attention');
  assert.equal(f.native.calls.filter(c=>c.method==='POST' && c.path.endsWith('/documents')).length,1);assert.equal(f.native.docs.length,0);
});

test('Multiple markers, changed metadata and readback mismatch remain explicit conflicts',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());await f.archive.drainOnce();
  f.native.docs.push({...f.native.docs[0],id:'duplicate'});assert.equal((await f.archive.reconcile(receipt.intent_id)).error_code,'MULTIPLE_WRITEBACK_DOCUMENTS');
  f.native.docs.pop();f.native.docs[0].metadata.result_revision=99;assert.equal((await f.archive.reconcile(receipt.intent_id)).error_code,'WRITEBACK_METADATA_CONFLICT');
  f.native.docs[0].metadata.result_revision=1;f.native.readMismatch=true;assert.equal((await f.archive.reconcile(receipt.intent_id)).error_code,'WRITEBACK_CONTENT_CONFLICT');
  f.native.readMismatch=false;assert.equal((await f.archive.reconcile(receipt.intent_id)).status,'verified');assert.equal(f.native.docs.length,1);
});

test('Incomplete listings cannot justify creating a document and frozen service targets cannot silently change',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());f.native.listMore=true;await f.archive.drainOnce();assert.equal(f.native.docs.length,0);
  assert.equal(f.archive.getForJob(f.jobId).archives[0].writeback.error_code,'INCOMPLETE_THINKFLOW_LIST');
  f.native.listMore=false;const original=f.client.userId;f.client.userId='different-user';assert.equal((await f.archive.reconcile(receipt.intent_id)).error_code,'THINKFLOW_TARGET_CHANGED');assert.equal(f.native.docs.length,0);
  assert.throws(()=>f.archive.confirm(f.jobId,{...f.confirmation(),result_revision:999}),e=>e.code==='REVISION_CONFLICT');f.client.userId=original;
});

test('Manual reconciliation is GET-only even before a first POST',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());assert.equal((await f.archive.reconcile(receipt.intent_id)).status,'queued');assert.equal(f.native.docs.length,0);
  assert.equal(f.native.calls.filter(c=>c.method==='POST' && c.path.endsWith('/documents')).length,0);await f.archive.drainOnce();assert.equal(f.native.docs.length,1);
});

test('Unrelated documents without integration metadata do not prevent a complete-list lookup',async t=> {
  const f=await fixture(t);f.native.docs.push({id:'unrelated',title:'普通笔记',content:'普通内容'});
  const receipt=f.archive.confirm(f.jobId,f.confirmation());await f.archive.drainOnce();
  assert.equal(f.archive.getForJob(f.jobId).archives[0].writeback_status,'verified');assert.equal(f.native.docs.length,2);
  assert.equal(f.native.docs.filter(d=>d.metadata?.personal_agent_writeback_intent_id===receipt.intent_id).length,1);
});

test('Expired lease after dispatch cannot create again or accept a late result from its previous worker',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  f.native.hold=new Promise(resolve=>{release=resolve;});f.native.entered=entered;const operation=f.archive.drainOnce();await started;
  const otherStore=new SQLiteStore({filename:f.filename}),other=f.create(otherStore,f.jobs,f.knowledge);f.advance(61000);assert.equal((await other.drainOnce()).claimed,false);
  assert.equal(other.getForJob(f.jobId).archives[0].writeback_status,'reconciliation_required');release();await operation;
  assert.equal(other.getForJob(f.jobId).archives[0].writeback_status,'reconciliation_required');assert.equal(f.native.docs.length,1);
  assert.equal((await other.reconcile(receipt.intent_id)).status,'verified');assert.equal(f.native.docs.length,1);
});

test('Deletion erases private archive/task data, aborts work and retains only the Ask idempotency tombstone',async t=> {
  const f=await fixture(t),receipt=f.archive.confirm(f.jobId,f.confirmation());let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  f.native.hold=new Promise(resolve=>{release=resolve;});f.native.entered=entered;const operation=f.archive.drainOnce();await started;
  assert.equal(f.archive.removeForJob(f.jobId).remote_documents_deleted,false);f.jobs.remove(f.jobId);release();await operation;
  assert.deepEqual(f.archive.getForJob(f.jobId).archives,[]);assert.equal(f.store.db.prepare('SELECT count(*) n FROM research_writeback_intents').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM research_results').get().n,0);assert.equal(f.store.db.prepare("SELECT tombstone FROM idempotency_records WHERE operation='ask'").get().tombstone,1);
  assert.throws(()=>f.jobs.get(f.jobId),e=>e.code==='JOB_NOT_FOUND');await assert.rejects(f.archive.reconcile(receipt.intent_id),e=>e.code==='WRITEBACK_NOT_FOUND');
});
