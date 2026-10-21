import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {freezeModelConfig,validateEvidence,validateResult,enrichResult,buildGeneration,generate,parseRetryAfter,explicitGenerateCheck} from '../lib/llm/structured.mjs';

const config=()=>freezeModelConfig({provider:'openai',baseUrl:'https://model.example.invalid/v1',model:'test-model',apiKey:'never-persist-this'});
const evidence=()=>[{id:'E1',chunk_id:'c1',source_id:'s1',source_version_id:'v1',workspace_id:'ws1',corpus_revision_id:'cr1',title:'原文标题',kind:'import',
  text:'研究资料：模型通过中文资料检索生成简报。',start:0,end:22,sha256:createHash('sha256').update('原文').digest('hex'),read_at:'2026-10-21T09:00:00Z'}];
const result=()=>({schema_version:'1',answer_status:'answered',watch_brief:{headline:'中文资料检索',bullets:[{text:'简报基于检索资料。',citation_ids:['E1']}]},
  sections:[{heading:'解释',statements:[{kind:'fact',text:'模型使用检索到的资料。',citation_ids:['E1']},{kind:'suggestion',text:'可以补充资料。',citation_ids:[]}]}],limitations:[]});
const reply=(value,extra={})=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],...extra}),{status:200,headers:{'content-type':'application/json'}});

test('Frozen model config strips credentials and rejects remote cleartext, credentials in URL and unbounded budgets',()=> {
  const c=config();assert.equal(c.apiKey,undefined);assert.ok(!JSON.stringify(c).includes('never-persist'));
  for(const override of [{baseUrl:'http://remote.invalid/v1'},{baseUrl:'https://user:secret@model.invalid/v1'},{maxCalls:3},{inputTokens:8001},{outputTokens:2501}])
    assert.throws(()=>freezeModelConfig({...c,...override}),/INVALID_MODEL_CONFIG/);
  assert.equal(freezeModelConfig({...c,baseUrl:'http://127.0.0.1:8317/v1'}).baseUrl,'http://127.0.0.1:8317/v1');
});

test('Evidence and structured results reject foreign spaces, invented citations and unsupported result fields',()=> {
  const e=evidence();validateEvidence(e,'ws1','cr1');
  assert.throws(()=>validateEvidence(e,'ws2','cr1'),/INVALID_EVIDENCE/);
  assert.throws(()=>validateEvidence(e,'ws1','cr2'),/INVALID_EVIDENCE/);
  assert.deepEqual(validateResult(result(),e),result());
  const invented=result();invented.watch_brief.bullets[0].citation_ids=['E99'];assert.throws(()=>validateResult(invented,e),/INVALID_RESULT/);
  const uncited=result();uncited.sections[0].statements[0].citation_ids=[];assert.throws(()=>validateResult(uncited,e),/INVALID_RESULT/);
  assert.throws(()=>validateResult({...result(),citations:[{title:'fake'}]},e),/INVALID_RESULT/);
  const enriched=enrichResult(result(),e);assert.equal(enriched.citations[0].quote,e[0].text);assert.equal(enriched.citations[0].title,e[0].title);
});

test('Unicode limits and brief facts are checked independently of byte limits',()=> {
  const long=result();long.watch_brief.headline='🙂'.repeat(41);assert.throws(()=>validateResult(long,evidence()),/INVALID_RESULT/);
  long.watch_brief.headline='🙂'.repeat(40);validateResult(long,evidence());
  const tooMany=result();tooMany.watch_brief.bullets=Array.from({length:4},()=>({text:'结论',citation_ids:['E1']}));assert.throws(()=>validateResult(tooMany,evidence()),/INVALID_RESULT/);
  const shortage=result();shortage.answer_status='insufficient_evidence';assert.throws(()=>validateResult(shortage,evidence()),/INVALID_RESULT/);
});

test('Generation uses a conservative UTF8 byte bound and freezes the actual evidence subset',()=> {
  const c=config(),e=evidence();const large=Array.from({length:8},(_,i)=>({...e[0],id:`E${i+1}`,text:'中文'.repeat(800)}));
  const prepared=buildGeneration('中文研究',large,c);assert.ok(prepared.evidence.length<8);assert.ok(prepared.inputTokenUpperBound<=8000);
  assert.ok(prepared.inputTokenUpperBound>=Buffer.byteLength(JSON.stringify(prepared.body),'utf8'));
  assert.throws(()=>buildGeneration('中文问题'.repeat(1000),e,c),/CONTEXT_BUDGET_EXCEEDED/);
  assert.throws(()=>buildGeneration('问题',large,c,{frozen:true}),/CONTEXT_BUDGET_EXCEEDED/);
});

test('OpenAI adapter records actual usage, marks absent usage unknown and never follows redirects or sends tools',async()=> {
  const c=config(),body=buildGeneration('问题',evidence(),c).body;let request;
  const a=await generate({config:c,body,key:'only-in-memory',fetchImpl:async(url,options)=>{request={url,...options};return reply(result());}});
  assert.equal(a.usage,null);assert.equal(request.redirect,'error');assert.equal(JSON.parse(request.body).tools,undefined);assert.equal(request.headers.Authorization,'Bearer only-in-memory');
  const b=await generate({config:c,body,fetchImpl:async()=>reply(result(),{usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17,secret:'ignored'}})});
  assert.deepEqual(b.usage,{prompt_tokens:12,completion_tokens:5,total_tokens:17});
});

test('Retry-After seconds and HTTP-date are honored; network ambiguity and truncated results are explicit',async()=> {
  const now=Date.parse('2026-10-21T09:00:00Z');assert.equal(parseRetryAfter('17',now),now+17000);assert.equal(parseRetryAfter('Wed, 21 Oct 2026 09:00:20 GMT',now),now+20000);
  const args={config:config(),body:{},clock:()=>now};
  await assert.rejects(generate({...args,fetchImpl:async()=>new Response('sensitive upstream body',{status:429,headers:{'retry-after':'17'}})}),e=>e.code==='MODEL_RATE_LIMITED' && e.retryAt===now+17000 && !String(e).includes('sensitive'));
  await assert.rejects(generate({...args,fetchImpl:async()=>{throw Error('credential or private failure');}}),e=>e.code==='MODEL_REQUEST_UNKNOWN' && e.unknown && !String(e).includes('private'));
  await assert.rejects(generate({...args,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.error(Error('connection dropped after headers'));}}),{status:200})}),e=>e.code==='MODEL_REQUEST_UNKNOWN' && e.unknown);
  await assert.rejects(generate({...args,fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}),{status:200})}),/MODEL_OUTPUT_INCOMPLETE/);
});

test('Explicit generation check makes exactly one public fixture call without retrying a bad format',async()=> {
  let calls=0;const checked=await explicitGenerateCheck(config(),{fetchImpl:async(url,options)=>{calls++;assert.ok(options.body.includes('公开连接检查样本'));return reply(result());}});
  assert.equal(calls,1);assert.equal(checked.ok,true);assert.equal(checked.usage,'unknown');
  await assert.rejects(explicitGenerateCheck(config(),{fetchImpl:async()=>{calls++;return reply({});}}),/INVALID_RESULT/);assert.equal(calls,2);
});
