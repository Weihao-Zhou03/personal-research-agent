import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {ResearchConfig,environmentKey} from '../lib/research-config.mjs';
test('Model configuration freezes non-secret revisions, keeps keys in memory and scopes environment keys to their endpoint',async t=> {
  const dir=await mkdtemp(path.join(tmpdir(),'pa-model-')),store=new SQLiteStore({filename:path.join(dir,'s.sqlite')});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const config=new ResearchConfig(store),body={baseUrl:'https://model.test/v1',model:'fixture',api_key:'fixture-key-only'};
  const a=config.update(body);assert.equal(a.has_api_key,true);assert.equal(config.resolveKey(a),body.api_key);
  const b=config.update({...body,model:'second',api_key:''});assert.notEqual(a.version,b.version);
  assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM research_model_configs').all()),/fixture-key-only|api_key/);
  assert.equal(new ResearchConfig(store).public().has_api_key,false);
  assert.equal(environmentKey({baseUrl:'https://other.test'},{PERSONAL_AGENT_MODEL_BASE_URL:body.baseUrl,PERSONAL_AGENT_MODEL_KEY:'x'}),'');
  for(const baseUrl of ['http://remote.test','https://u:p@model.test','https://model.test/?key=x']) assert.throws(()=>config.update({...body,baseUrl}),e=>e.code==='INVALID_MODEL_CONFIG');
  assert.throws(()=>config.update({...body,inputTokens:9000}),e=>e.code==='INVALID_MODEL_CONFIG');
});
