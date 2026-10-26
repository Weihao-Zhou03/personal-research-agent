import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server.mjs';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {passwordHash,randomSecret,sha256} from '../lib/auth/security.mjs';
import {ThinkFlowClient} from '../lib/thinkflow.mjs';

const password='research-http-fixture-password',encoded=passwordHash(password),clientTime='2026-10-21T09:00:00Z';
const answer=()=>({schema_version:'1',answer_status:'answered',watch_brief:{headline:'中文模型研究',bullets:[{text:'中文模型依据检索资料回答。',citation_ids:['E1']}]},
  sections:[{heading:'资料说明',statements:[{kind:'fact',text:'模型使用中文资料检索。',citation_ids:['E1']}]}],limitations:[]});

test('Invalid cloud configuration degrades Ask without blocking pairing, Capture, identity, feed or readiness',async t=>{
  const f=await fixture(t),c=await f.start({researchModelConfig:{provider:'openai',baseUrl:'http://remote.invalid/v1',model:'broken'}}),owner=await c.owner(),device=await f.pair(c,owner);
  const me=await c.request('/api/v1/watch/me',undefined,{headers:device.headers});assert.equal(me.status,200);assert.equal(me.body.capabilities.capture,true);assert.equal(me.body.capabilities.ask,false);
  const saved=await c.request('/api/v1/watch/captures',{workspace_id:f.workspace.id,text:'模型配置坏了也保留原文。',created_at_client:clientTime},{headers:{...device.headers,'Idempotency-Key':randomUUID()}});assert.equal(saved.status,201);
  assert.equal((await c.request('/api/v1/watch/feed',undefined,{headers:device.headers})).status,200);
  const readiness=await owner.request('/readiness');assert.equal(readiness.status,200);assert.equal(readiness.body.capture.ready,true);assert.equal(readiness.body.ask.ready,false);
  assert.equal((await f.ask(c,device,{workspace_id:f.workspace.id,question:'模型资料？',created_at_client:clientTime})).status,503);assert.equal(f.native.modelCalls,0);
  const config=await owner.request('/model');assert.equal(config.body.code,'INVALID_MODEL_CONFIG');assert.doesNotMatch(config.text,/remote\.invalid/);
});
async function until(operation,predicate,label) {
  for(let i=0;i<500;i++) {const value=await operation();if(predicate(value)) return value;await delay(20);}
  assert.fail(`Timed out: ${label}`);
}

/** Real HTTP and SQLite. Model and ThinkFlow endpoints here are explicitly controlled substitutes. */
async function fixture(t) {
  const native={modelCalls:0,modelChecks:0,docs:[],requests:[],failAfterWrite:false,source:'  中文模型资料：模型依据资料检索生成简报。\n保留这份原始材料。  ',failSources:false};
  const upstream=http.createServer(async(req,res)=> {
    let raw='';for await(const part of req) raw+=part;const body=raw?JSON.parse(raw):null,url=new URL(req.url,'http://localhost');
    native.requests.push({path:url.pathname,method:req.method,body});let data={success:true};
    if(url.pathname==='/v1/models') {assert.equal(req.headers.authorization,'Bearer test-only-model-secret');native.modelChecks++;data={data:[{id:'fixture-cloud'}]};}
    else if(url.pathname==='/v1/chat/completions') {
      assert.equal(req.headers.authorization,'Bearer test-only-model-secret');native.modelCalls++;
      assert.equal(body.tools,undefined);const supplied=JSON.parse(body.messages[1].content);assert.ok(supplied.evidence.length>0);
      data={choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer())}}],usage:{prompt_tokens:120,completion_tokens:60,total_tokens:180}};
    } else {
      assert.equal(req.headers['x-api-key'],'test-only-thinkflow-secret');
      if(url.pathname==='/api/v1/kb/notebooks') data.notebooks=[{id:'nb_http',name:'HTTP研究笔记'}];
      else if(url.pathname==='/api/v1/kb/files') {if(native.failSources) {res.writeHead(503);res.end('private listing failure');return;}data.files=[{id:'source_http',name:'中文资料.md',static_url:'/outputs/local/nb_http/source.md',file_type:'md'}];}
      else if(url.pathname==='/api/v1/kb/get-source-display-content') data.content=native.source;
      else if(url.pathname==='/api/v1/kb/documents' && req.method==='GET') data.documents=native.docs.map(d=>({...d,content:''}));
      else if(url.pathname==='/api/v1/kb/documents' && req.method==='POST') {
        const document={...body,id:`doc_http_${native.docs.length+1}`};native.docs.push(document);data.document=document;
        if(native.failAfterWrite) {native.failAfterWrite=false;res.writeHead(503);res.end('private write response failure');return;}
      } else if(url.pathname.startsWith('/api/v1/kb/documents/')) data.document=native.docs.find(d=>d.id===decodeURIComponent(url.pathname.split('/').at(-1)));
      else {res.writeHead(404);res.end('{}');return;}
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
  const dir=await mkdtemp(path.join(tmpdir(),'research-api-')),control=new SQLiteStore({filename:path.join(dir,'workspace.sqlite')});
  control.initializeEmptyLegacyState({provider:'extractive',model:'',baseUrl:''});let now=Date.parse(clientTime);const clock=()=>now;
  const capture=new CaptureService(control,{clock});capture.setPasswordHash(await encoded);const workspace=capture.createWorkspace('中文模型空间'),apps=[];
  const thinkflow=new ThinkFlowClient({baseUrl:upstreamOrigin,apiKey:'test-only-thinkflow-secret'});
  t.after(async()=>{for(const app of apps) await app.close();control.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  async function start(overrides={}) {
    const app=await createApp({dataDir:dir,storage:'sqlite',clock,thinkflowClient:thinkflow,autoStartResearch:true,
      researchModelConfig:{provider:'openai',baseUrl:`${upstreamOrigin}/v1`,model:'fixture-cloud'},researchResolveKey:()=> 'test-only-model-secret',...overrides});apps.push(app);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const port=app.server.address().port,origin=`http://127.0.0.1:${port}`;
    function request(route,body,{method=body===undefined?'GET':'POST',headers={},raw}={}) {
      const bytes=raw??(body===undefined?undefined:JSON.stringify(body));
      return new Promise((resolve,reject)=> {
        const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:`127.0.0.1:${port}`,...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin,'Content-Length':Buffer.byteLength(bytes)}),...headers}},res=> {
          let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,body:data,text,headers:res.headers});});
        });req.on('error',reject);req.end(bytes);
      });
    }
    async function owner() {
      const login=await request('/api/v1/owner/login',{password});assert.equal(login.status,200);
      const headers={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':login.body.csrf_token};
      return {headers,request:(route,body,extra={})=>request(`/api/v1/owner${route}`,body,{...extra,headers:{...headers,...extra.headers}})};
    }
    return {app,request,owner,port,origin};
  }
  async function pair(client,owner,{workspaceIds=[workspace.id]}={}) {
    const secret=randomSecret(),pending=await client.request('/api/v1/pairings',{pairing_request_id:randomUUID(),device_secret_hash:sha256(secret),device_name:'HTTP测试手表'});assert.equal(pending.status,201);
    assert.equal((await owner.request(`/pairings/${pending.body.pairing_id}/approve`,{allowed_workspace_ids:workspaceIds,default_workspace_id:workspaceIds[0]})).status,200);
    const identity=await client.request('/api/v1/watch/me',undefined,{headers:{Authorization:`Bearer ${secret}`}});assert.equal(identity.status,200);
    return {headers:{Authorization:`Bearer ${secret}`},id:identity.body.device_id,identity:identity.body};
  }
  async function importSource(owner,space=workspace,text='中文模型研究资料：模型使用中文资料检索来回答问题。') {
    const imported=await owner.request(`/workspaces/${space.id}/sources`,{title:'原始中文研究资料',text});assert.equal(imported.status,201);return imported.body;
  }
  const ask=(client,device,body,key=randomUUID())=>client.request('/api/v1/watch/asks',body,{headers:{...device.headers,'Idempotency-Key':key}});
  async function completed(owner,id) {const result=await until(()=>owner.request(`/jobs/${id}`),r=>['completed','failed','needs_attention'].includes(r.body.status),'Ask completion');assert.equal(result.status,200);assert.equal(result.body.status,'completed',JSON.stringify(result.body));return result.body;}
  return {native,dir,control,capture,workspace,start,pair,importSource,ask,completed,advance:ms=>{now+=ms;}};
}

test('HTTP Capture indexes asynchronously and a durable Watch Ask returns a structured brief with zero-call reads',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner(),device=await f.pair(c,owner),text='  中文模型资料：模型依据资料检索生成简报。\n保留原文🙂  ';
  const saved=await c.request('/api/v1/watch/captures',{workspace_id:f.workspace.id,text,created_at_client:clientTime},{headers:{...device.headers,'Idempotency-Key':randomUUID()}});
  assert.equal(saved.status,201);assert.equal(saved.body.status,'saved');assert.equal(f.native.modelCalls,0);
  await until(()=>owner.request('/captures'),r=>r.body.captures[0]?.index_status==='indexed','Capture index worker');
  const key=randomUUID(),body={workspace_id:f.workspace.id,question:'中文模型如何使用资料？',created_at_client:clientTime},accepted=await f.ask(c,device,body,key);
  assert.equal(accepted.status,202);assert.match(accepted.body.job_id,/^job_/);assert.equal(accepted.body.question,undefined);
  const job=await f.completed(owner,accepted.body.job_id);assert.equal(job.evidence[0].text,text);assert.equal(job.evidence[0].kind,'note');assert.equal(f.native.modelCalls,1);
  const brief=await c.request(`/api/v1/watch/jobs/${job.job_id}/brief`,undefined,{headers:device.headers});assert.equal(brief.status,200);assert.equal(brief.body.result_revision,1);assert.equal(brief.body.source_count,1);assert.equal(brief.body.citations[0].quote,undefined);
  for(const route of ['/usage','/readiness','/export','/jobs',`/jobs/${job.job_id}`,`/workspaces/${f.workspace.id}/sources`]) assert.equal((await owner.request(route)).status,200);
  assert.equal((await c.request('/api/v1/watch/feed',undefined,{headers:device.headers})).body.items.length,2);
  const again=await f.ask(c,device,body,key);assert.equal(again.status,200);assert.equal(again.body.job_id,job.job_id);assert.equal(f.native.modelCalls,1);
  const conflict=await f.ask(c,device,{...body,question:'不同问题'},key);assert.equal(conflict.status,409);
});

test('HTTP authentication separates owner and Watch scopes, filters spaces before feed and applies revocation',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner(),device=await f.pair(c,owner);await f.importSource(owner);
  const second=await owner.request('/workspaces',{name:'另一个私有空间'});assert.equal(second.status,201);await f.importSource(owner,second.body);
  const privateAsk=await owner.request(`/workspaces/${second.body.id}/asks`,{request_id:randomUUID(),question:'中文模型资料？',created_at_client:clientTime});assert.equal(privateAsk.status,202);
  assert.equal((await c.request(`/api/v1/watch/jobs/${privateAsk.body.job_id}`,undefined,{headers:device.headers})).status,403);
  assert.equal((await f.ask(c,device,{workspace_id:second.body.id,question:'读取其他空间',created_at_client:clientTime})).status,403);
  assert.ok(!(await c.request('/api/v1/watch/feed',undefined,{headers:device.headers})).body.items.some(item=>item.workspace_id===second.body.id));
  assert.equal((await c.request('/api/v1/owner/model',undefined,{headers:device.headers})).status,401);
  assert.equal((await c.request('/api/state',undefined,{headers:device.headers})).status,403);
  assert.equal((await c.request('/api/v1/owner/jobs')).status,401);
  assert.equal((await owner.request(`/workspaces/${f.workspace.id}/asks`,{question:'中文模型',created_at_client:clientTime,request_id:randomUUID()},{headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await owner.request('/model/connection-check',{}, {headers:{Origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await owner.request(`/devices/${device.id}/settings`,{allowed_workspace_ids:[f.workspace.id],default_workspace_id:f.workspace.id,enable_ask:false})).status,200);
  assert.equal((await f.ask(c,device,{workspace_id:f.workspace.id,question:'中文模型',created_at_client:clientTime})).status,403);
  assert.equal((await owner.request(`/devices/${device.id}/revoke`,{})).status,200);assert.equal((await c.request('/api/v1/watch/feed',undefined,{headers:device.headers})).status,401);
});

test('HTTP ThinkFlow sync publishes immutable exact snapshots and a failed listing retains the previous corpus',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner();
  assert.equal((await owner.request(`/workspaces/${f.workspace.id}/bind`,{notebook_id:'nb_http'})).status,200);
  const sync=await owner.request(`/workspaces/${f.workspace.id}/sync`,{notebook_id:'nb_http'});assert.equal(sync.status,200);const originalRevision=sync.body.corpus_revision_id;
  const sources=await owner.request(`/workspaces/${f.workspace.id}/sources`);assert.equal(sources.body.sources.length,1);
  const version=await owner.request(`/source-versions/${sources.body.sources[0].source_version_id}`);assert.equal(version.body.text,f.native.source);
  f.native.failSources=true;const failed=await owner.request(`/workspaces/${f.workspace.id}/sync`,{notebook_id:'nb_http'});assert.equal(failed.status,502);assert.equal((await owner.request(`/workspaces/${f.workspace.id}/sources`)).body.corpus_revision_id,originalRevision);assert.ok(!failed.text.includes('private listing failure'));
  const search=await owner.request(`/workspaces/${f.workspace.id}/search`,{question:'中文模型'});assert.ok(search.body.evidence.length>0);assert.equal(search.body.evidence[0].text,f.native.source);assert.equal(f.native.modelCalls,0);
});

test('HTTP edit, confirmation and lost write response recover after service restart; new revision creates a new document',async t=> {
  const f=await fixture(t);let c=await f.start(),owner=await c.owner();await f.importSource(owner);assert.equal((await owner.request(`/workspaces/${f.workspace.id}/bind`,{notebook_id:'nb_http'})).status,200);
  const a=await owner.request(`/workspaces/${f.workspace.id}/asks`,{request_id:randomUUID(),question:'中文模型使用什么资料？',created_at_client:clientTime});const job=await f.completed(owner,a.body.job_id),first=job.results[0];
  assert.equal((await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:1,expected_content_hash:'a'.repeat(64),write_to_thinkflow:true})).status,409);assert.equal(f.native.docs.length,0);
  const result=structuredClone(first.result);result.watch_brief.headline='人工核对版本';const edit=await owner.request(`/jobs/${job.job_id}/result`,{result_revision:1,expected_content_hash:first.content_hash,result});assert.equal(edit.status,200);assert.equal(edit.body.current_revision,2);
  assert.equal((await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:1,expected_content_hash:first.content_hash,write_to_thinkflow:true})).status,409);
  f.native.failAfterWrite=true;const second=edit.body.results[1],confirmed=await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:2,expected_content_hash:second.content_hash,write_to_thinkflow:true});assert.equal(confirmed.status,201);
  await until(()=>owner.request(`/jobs/${job.job_id}/archives`),r=>r.body.archives[0]?.writeback_status==='reconciliation_required','lost write response');assert.equal(f.native.docs.length,1);
  await c.app.close();c=await f.start();owner=await c.owner();const recovered=await owner.request(`/writebacks/${confirmed.body.intent_id}/reconcile`,{});assert.equal(recovered.status,200);assert.equal(recovered.body.status,'verified');assert.equal(f.native.docs.length,1);
  const repeat=await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:2,expected_content_hash:second.content_hash,write_to_thinkflow:true});assert.equal(repeat.body.intent_id,confirmed.body.intent_id);
  const nextResult=structuredClone(second.result);nextResult.watch_brief.headline='再次核对版本';const next=await owner.request(`/jobs/${job.job_id}/result`,{result_revision:2,expected_content_hash:second.content_hash,result:nextResult});assert.equal(next.status,200);
  const third=next.body.results[2];assert.equal((await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:3,expected_content_hash:third.content_hash,write_to_thinkflow:true})).status,201);
  await until(()=>owner.request(`/jobs/${job.job_id}/archives`),r=>r.body.archives[1]?.writeback_status==='verified','new revision writeback');assert.equal(f.native.docs.length,2);assert.equal(f.native.modelCalls,1);
});

test('HTTP business export excludes credentials; deleting a job preserves quotas and tombstone, workspace deletion cleans evidence',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner(),device=await f.pair(c,owner);await f.importSource(owner);
  const key=randomUUID(),body={workspace_id:f.workspace.id,question:'删除测试独特问题：中文模型依据什么？',created_at_client:clientTime},accepted=await f.ask(c,device,body,key),job=await f.completed(owner,accepted.body.job_id),record=job.results[0];
  assert.equal((await owner.request(`/jobs/${job.job_id}/confirm`,{result_revision:1,expected_content_hash:record.content_hash,write_to_thinkflow:false})).status,201);
  const before=await owner.request('/export');assert.equal(before.status,200);assert.equal(before.body.jobs.length,1);assert.equal(before.body.archives.length,1);assert.equal(before.body.includes_authentication,false);
  assert.ok(!/secret_hash|owner_password|csrf_token|test-only-model-secret|test-only-thinkflow-secret/.test(before.text));const usage=await owner.request('/usage');
  assert.equal((await owner.request(`/jobs/${job.job_id}`,{}, {method:'DELETE'})).status,200);assert.equal((await owner.request(`/jobs/${job.job_id}`)).status,404);
  const replay=await f.ask(c,device,body,key);assert.equal(replay.status,409);assert.equal(replay.body.error.code,'RESOURCE_DELETED');
  const after=await owner.request('/export');assert.equal(after.body.jobs.length,0);assert.equal(after.body.archives.length,0);assert.ok(!after.text.includes(body.question));assert.deepEqual((await owner.request('/usage')).body,usage.body);
  const removed=await owner.request(`/workspaces/${f.workspace.id}`,{}, {method:'DELETE'});assert.equal(removed.status,200);assert.equal(removed.body.remote_and_backup_erasure,false);
  for(const table of ['sources','source_versions','chunks','corpus_revisions']) assert.equal(f.control.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.deepEqual((await c.request('/api/v1/watch/feed',undefined,{headers:device.headers})).body.items,[]);assert.equal((await owner.request('/export')).body.workspaces.length,0);
});

test('An Ask HTTP response discarded at headers does not interrupt its durable worker and same-key replay returns its ID',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner(),device=await f.pair(c,owner);await f.importSource(owner);
  const key=randomUUID(),body={workspace_id:f.workspace.id,question:'中文模型的资料是什么？',created_at_client:clientTime};
  await new Promise((resolve,reject)=> {
    const req=http.request({hostname:'127.0.0.1',port:c.port,path:'/api/v1/watch/asks',method:'POST',headers:{...device.headers,'Idempotency-Key':key,Origin:c.origin,'Content-Type':'application/json'}},res=>{assert.equal(res.statusCode,202);res.destroy();resolve();});
    req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});req.end(JSON.stringify(body));
  });
  const persisted=f.control.db.prepare('SELECT id FROM research_jobs').get();assert.ok(persisted);await f.completed(owner,persisted.id);
  const replay=await f.ask(c,device,body,key);assert.equal(replay.status,200);assert.equal(replay.body.job_id,persisted.id);assert.equal(f.native.modelCalls,1);assert.equal(f.control.db.prepare('SELECT count(*) n FROM research_jobs').get().n,1);
});
