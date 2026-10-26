import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ThinkFlowClient} from '../lib/thinkflow.mjs';
import {createApp} from '../server.mjs';
import {processTask} from '../lib/processor.mjs';

async function fixture(t,{storage='json'}={}) {
  const native = {docs:[],text:'原文：缩放点积注意力除以 Key 维度的平方根。\n待验证：设备延迟需要实测。',failAfterWrite:false,holdWrite:null,calls:[],readBackMismatch:false};
  const upstream=http.createServer(async(req,res)=> {
    const url=new URL(req.url,'http://localhost');
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body=raw?JSON.parse(raw):null;
    native.calls.push({route:url.pathname,query:Object.fromEntries(url.searchParams),body});
    assert.equal(req.headers['x-api-key'],'test-key');
    let result={success:true};
    if (url.pathname==='/api/v1/kb/notebooks') result.notebooks=[{id:'nb1',name:'研究笔记'}];
    else if (url.pathname==='/api/v1/kb/files') result.files=[{id:'s1',name:'课堂笔记.md',static_url:'/outputs/local/nb1/source.md',file_type:'md'},
      {id:'duplicate',name:'重复记录',url:'/outputs/local/nb1/source.md'}, {id:'bad',name:'禁止路径',url:'/secret.txt'}];
    else if (url.pathname==='/api/v1/kb/get-source-display-content') {
      assert.equal(body.path,'/outputs/local/nb1/source.md'); assert.equal(body.notebook_id,'nb1'); result.content=native.text;
    } else if (url.pathname==='/api/v1/kb/documents' && req.method==='GET') result.documents=native.docs.map(d=>({...d,content:''}));
    else if (url.pathname==='/api/v1/kb/documents' && req.method==='POST') {
      if (native.holdWrite) await native.holdWrite;
      const document={...body,id:`doc${native.docs.length+1}`}; native.docs.push(document); result.document=document;
      if (native.failAfterWrite) { native.failAfterWrite=false; res.writeHead(503,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'private upstream diagnostic must not leak'})); }
    } else if (url.pathname.startsWith('/api/v1/kb/documents/')) {
      const document=native.docs.find(d=>d.id===url.pathname.split('/').at(-1));
      result.document=native.readBackMismatch?{...document,content:'changed elsewhere'}:document;
    } else { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(result));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const adapter=new ThinkFlowClient({baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'test-key'});
  const dir=await mkdtemp(path.join(tmpdir(),'pa-thinkflow-'));
  const apps=[];
  async function start() {
    const app=await createApp({dataDir:dir,thinkflowClient:adapter,storage}); apps.push(app);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${app.server.address().port}`;
    async function request(route,body,method=body===undefined?'GET':'POST') {
      const response=await fetch(url+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    }
    return {app,request};
  }
  t.after(async()=> { for(const a of apps) await a.close(); await new Promise(resolve=>upstream.close(resolve)); await rm(dir,{recursive:true,force:true}); });
  return {native,adapter,start};
}
async function completed(client) {
  const response=await client.request('/api/tasks',{title:'注意力机制复习',instruction:'提炼要点并保留来源',sourceText:'客户端伪造正文必须被替换',sources:[],thinkflow:{notebookId:'nb1',sourceIds:['s1']}});
  assert.equal(response.status,201);
  const task=response.body;
  await client.request(`/api/tasks/${task.id}/run`,{});
  for(let i=0;i<100;i++) {
    const state=(await client.request('/api/state')).body;
    const next=state.tasks.find(t=>t.id===task.id);
    if (next.status==='completed') return next;
    await delay(10);
  }
  assert.fail('Task did not complete');
}

test('ThinkFlow native contract: source membership, real text, deduplication and SHA snapshots',async t=> {
  const {adapter,native}=await fixture(t);
  assert.equal((await adapter.sources('nb1')).sources.length,1);
  const snapshot=await adapter.readSources('nb1',['s1']);
  assert.match(snapshot.sourceText,/平方根/); assert.match(snapshot.sourceText,/TF1/);
  assert.match(snapshot.sources[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(snapshot.sources[0].passageStart,1); assert.equal(snapshot.sources[0].passageEnd,3);
  const before=native.calls.length;
  await assert.rejects(adapter.readSources('nb1',['/outputs/another/source.md']),/不属于/);
  assert.equal(native.calls.slice(before).filter(c=>c.route.endsWith('get-source-display-content')).length,0);
  await assert.rejects(adapter.readSources('other',['s1']),/不存在/);
  await assert.rejects(adapter.readSources('nb1',['s1','s1']),/不同/);
  native.text=''; await assert.rejects(adapter.readSources('nb1',['s1']),/没有可读取/);
  native.text='长'.repeat(100001); await assert.rejects(adapter.readSources('nb1',['s1']),/超过/);
});
test('Bound tasks re-read upstream material and never write before manual confirmation',async t=> {
  const {start,native}=await fixture(t); const client=await start();
  const task=await completed(client);
  assert.doesNotMatch(task.sourceText,/客户端伪造/); assert.match(task.result.markdown,/已通过接口读取正文/);
  assert.doesNotMatch(task.result.markdown,/未抓取或阅读/); assert.equal(native.docs.length,0);
  assert.equal(task.thinkflow.notebookId,'nb1');
  const archive=await client.request(`/api/tasks/${task.id}/archive`,{content:'# 人工审阅\n\n除以维度的平方根。'});
  assert.equal(archive.status,201); assert.equal(native.docs.length,1);
  assert.equal(native.docs[0].document_type,'summary_doc'); assert.equal(native.docs[0].metadata.personal_agent_task_id,task.id);
  assert.equal(native.docs[0].metadata.source_refs[0].sha256,task.thinkflow.sources[0].sha256);
  assert.equal(native.docs[0].metadata.source_text_snapshot,task.sourceText);
  const reread=await client.request(`/api/tasks/${task.id}/thinkflow-result`);
  assert.equal(reread.body.document.content,archive.body.content);
  const repeat=await client.request(`/api/tasks/${task.id}/archive`,{});
  assert.equal(repeat.body.id,archive.body.id); assert.equal(native.docs.length,1);
});
test('Lost write response recovers after restart without duplicate documents or false local success',async t=> {
  const {start,native}=await fixture(t); let client=await start(); const task=await completed(client);
  native.failAfterWrite=true;
  const failed=await client.request(`/api/tasks/${task.id}/archive`,{});
  assert.equal(failed.status,502); assert.doesNotMatch(failed.body.error,/private upstream/);
  assert.equal(native.docs.length,1); assert.equal((await client.request('/api/state')).body.knowledge.length,0);
  assert.equal((await client.request(`/api/tasks/${task.id}/result`,{markdown:'changed'},'PUT')).status,409);
  await client.app.close(); client=await start();
  assert.equal((await client.request(`/api/tasks/${task.id}/archive`,{content:'different'})).status,409);
  const recovered=await client.request(`/api/tasks/${task.id}/archive`,{});
  assert.equal(recovered.status,201); assert.equal(native.docs.length,1);
  assert.equal((await client.request('/api/state')).body.knowledge.length,1);
});
test('Concurrent confirmations create one document; read-back mismatch never records success',async t=> {
  const {start,native}=await fixture(t); const client=await start(); const task=await completed(client);
  let release; native.holdWrite=new Promise(resolve=>{release=resolve;});
  const first=client.request(`/api/tasks/${task.id}/archive`,{});
  for(let i=0;i<100 && !native.calls.some(c=>c.route.endsWith('/documents') && c.body);i++) await delay(5);
  const second=await client.request(`/api/tasks/${task.id}/archive`,{});
  assert.equal(second.status,409); native.readBackMismatch=true; release();
  assert.equal((await first).status,502); assert.equal(native.docs.length,1);
  assert.equal((await client.request('/api/state')).body.knowledge.length,0);
  assert.equal((await client.request(`/api/tasks/${task.id}/archive`,{})).status,409);
  native.readBackMismatch=false;
  assert.equal((await client.request(`/api/tasks/${task.id}/archive`,{})).status,201);
  assert.equal(native.docs.length,1);
});

test('SQLite preserves source snapshots, confirmation lock and lost-write recovery across restart',async t=> {
  const {start,native}=await fixture(t,{storage:'sqlite'});let client=await start();const task=await completed(client);
  assert.equal(native.docs.length,0);
  const reviewed='# 人工确认\n\n保留平方根与来源。';native.failAfterWrite=true;
  assert.equal((await client.request(`/api/tasks/${task.id}/archive`,{content:reviewed})).status,502);
  assert.equal((await client.request('/api/state')).body.knowledge.length,0);
  await client.app.close();client=await start();
  const restored=(await client.request('/api/state')).body.tasks.find(item=>item.id===task.id);
  assert.deepEqual(restored.thinkflow.sources,task.thinkflow.sources);
  assert.equal(restored.writebackIntent.content,reviewed);
  assert.equal((await client.request(`/api/tasks/${task.id}/archive`,{content:'changed'})).status,409);
  const recovered=await client.request(`/api/tasks/${task.id}/archive`,{});
  assert.equal(recovered.status,201);assert.equal(recovered.body.content,reviewed);assert.equal(native.docs.length,1);
  assert.equal((await client.request('/api/state')).body.knowledge.length,1);
});
test('Changed sources invalidate the preview, and service or content conflicts cannot overwrite documents',async t=> {
  const {start,adapter,native}=await fixture(t); const client=await start();
  const preview=await adapter.readSources('nb1',['s1']); native.text+='新内容';
  const response=await client.request('/api/tasks',{title:'测试',instruction:'整理',thinkflow:{notebookId:'nb1',sourceIds:['s1'],sourceHashes:{s1:preview.sources[0].sha256}}});
  assert.equal(response.status,409); assert.equal((await client.request('/api/state')).body.tasks.length,0);
  const task=await completed(client); await client.request(`/api/tasks/${task.id}/archive`,{});
  await assert.rejects(adapter.writeResult({...task,thinkflow:{...task.thinkflow,userId:'another'}},task.result.markdown),/不一致/);
  await assert.rejects(adapter.writeResult(task,'different'),/不同内容/);
  assert.equal(native.docs.length,1);
});
test('ThinkFlow provenance appendix identifies the actual snapshot and source passage range',async()=> {
  const task={title:'研究',kind:'research',instruction:'仅整理事实',sourceText:'【ThinkFlow 来源 TF1：笔记】\n资料文字。',sources:[],thinkflow:{notebookName:'研究资料',sources:[{ref:'TF1',name:'笔记',sha256:'a'.repeat(64),passageStart:1,passageEnd:2}]}};
  const result=await processTask(task,{provider:'extractive'});
  assert.match(result.markdown,/ThinkFlow 笔记本/); assert.match(result.markdown,/TF1/); assert.match(result.markdown,/不代表向量检索/);
  assert.match(result.markdown,/材料 1 至 2/);
  assert.throws(()=>new ThinkFlowClient({baseUrl:'https://remote.example'}),/仅支持本机/);
});

test('M2 raw snapshots preserve whitespace while legacy source hashes keep their original trim behavior',async t=> {
  const {adapter,native}=await fixture(t);native.text='  原始资料\n保留边界🙂  \n';
  const raw=await adapter.readSources('nb1',['s1'],{preserveWhitespace:true});
  const legacy=await adapter.readSources('nb1',['s1']);
  assert.equal(raw.sources[0].content,native.text);assert.equal(legacy.sources[0].content,native.text.trim());
  assert.notEqual(raw.sources[0].sha256,legacy.sources[0].sha256);
});
