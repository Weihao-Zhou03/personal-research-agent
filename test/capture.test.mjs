import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {migrateWorkspace} from '../lib/store/migrate.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {passwordHash,randomSecret,sha256} from '../lib/auth/security.mjs';

const password='fixture-only-password-123';
const encodedPassword=passwordHash(password);
const clientTime='2026-10-21T09:00:00Z';
async function fixture(t,{serverMode=false}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'pa-capture-'));
  let instant=Date.parse(clientTime); const clock=()=>instant;
  const control=new SQLiteStore({filename:path.join(dir,'workspace.sqlite')});
  control.initializeEmptyLegacyState({provider:'extractive',model:'',baseUrl:''});
  const service=new CaptureService(control,{clock});service.setPasswordHash(await encodedPassword);
  const workspace=service.createWorkspace('中文研究');
  const apps=[];
  t.after(async()=> { for(const app of apps) await app.close();control.close();await rm(dir,{recursive:true,force:true}); });
  async function start(overrides={}) {
    const options={dataDir:dir,storage:'sqlite',clock,processor:{processTask(){throw Error('M1 Capture must not generate');}},
      ...(serverMode?{mode:'server',publicOrigin:'https://research.example',trustedProxyAddresses:['127.0.0.1']}:{}),...overrides};
    const app=await createApp(options);apps.push(app);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const port=app.server.address().port;
    const origin=serverMode?'https://research.example':`http://127.0.0.1:${port}`;
    async function request(route,body,{method=body===undefined?'GET':'POST',headers={},raw}={}) {
      const bytes=raw===undefined?(body===undefined?undefined:JSON.stringify(body)):raw;
      return new Promise((resolve,reject)=> {
        const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:serverMode?'research.example':`127.0.0.1:${port}`,...(serverMode?{'X-Forwarded-Proto':'https'}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...headers}},res=> {
          let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=> {let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,body:data,text,headers:res.headers});});
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
  async function pair(client,{spaceIds=[workspace.id],defaultId=workspace.id,name='测试手表'}={}) {
    const secret=randomSecret(),pairing_request_id=randomUUID();
    const body={pairing_request_id,device_secret_hash:sha256(secret),device_name:name};
    const pending=await client.request('/api/v1/pairings',body);assert.equal(pending.status,201);
    const owner=await client.owner();
    const approval=await owner.request(`/pairings/${pending.body.pairing_id}/approve`,{allowed_workspace_ids:spaceIds,default_workspace_id:defaultId});assert.equal(approval.status,200);
    return {secret,headers:{Authorization:`Bearer ${secret}`},pending:pending.body,body,owner};
  }
  return {dir,service,control,workspace,start,pair,advance:ms=>{instant+=ms;}};
}
const captureBody=(workspace,text='  中文模型与 AI 方法。\n原文🙂  ')=>({workspace_id:workspace.id,text,created_at_client:clientTime});
const submit=(client,device,key,body)=>client.request('/api/v1/watch/captures',body,{headers:{...device.headers,'Idempotency-Key':key}});

test('An in-flight login cannot create a session after administrator credential rotation',async t=> {
  const f=await fixture(t),replacement=await passwordHash('replacement-fixture-password');
  const attempt=f.service.login(password);
  f.service.setPasswordHash(replacement,{replace:true});
  await assert.rejects(attempt,error=>error.status===401 && error.code==='INVALID_CREDENTIALS');
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM owner_sessions').get().n,0);
});

test('An older Capture service refuses an unknown database schema without rewriting it',async t=> {
  const f=await fixture(t);f.control.db.prepare("UPDATE app_meta SET value='2' WHERE key='capture_schema_version'").run();
  assert.throws(()=>new CaptureService(f.control),/explicit version migration/);
  assert.equal(f.control.db.prepare("SELECT value FROM app_meta WHERE key='capture_schema_version'").get().value,'2');
  assert.equal(f.service.workspaces().length,1);
});

test('Logout during an administrator body upload prevents the pending mutation',async t=> {
  const f=await fixture(t),c=await f.start(),owner=await c.owner();
  const body=JSON.stringify({name:'must not exist'});let req;
  const response=new Promise((resolve,reject)=> {
    req=http.request({host:'127.0.0.1',port:c.port,path:'/api/v1/owner/workspaces',method:'POST',headers:{...owner.headers,Origin:c.origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=> {res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(body.slice(0,8));
  });
  await new Promise(resolve=>setTimeout(resolve,30));
  f.service.logout(owner.headers.Cookie.slice('pa_owner='.length));req.end(body.slice(8));
  assert.equal(await response,401);assert.equal(f.service.workspaces().length,1);
});

test('Revoking a pending device is terminal and later approval cannot restore it',async t=> {
  const f=await fixture(t),c=await f.start(),secret=randomSecret();
  const pending=await c.request('/api/v1/pairings',{pairing_request_id:randomUUID(),device_secret_hash:sha256(secret),device_name:'not approved'});
  const device=f.service.listDevices()[0];f.service.revoke(device.id);
  const owner=await c.owner();assert.equal((await owner.request(`/pairings/${pending.body.pairing_id}/approve`,{allowed_workspace_ids:[f.workspace.id],default_workspace_id:f.workspace.id})).status,409);
  const status=await c.request(`/api/v1/pairings/${pending.body.pairing_id}`,undefined,{headers:{Authorization:`Bearer ${secret}`}});
  assert.equal(status.body.status,'revoked');assert.equal(status.body.owner_id,undefined);
});

test('Capture commits original text, owner idempotency and durable indexing intent without any model or ThinkFlow',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c),key=randomUUID(),body=captureBody(f.workspace);
  const first=await submit(c,d,key,body);assert.equal(first.status,201);assert.equal(first.body.index_status,'pending');
  const row=f.control.db.prepare('SELECT * FROM captures').get();assert.equal(row.text,body.text);assert.equal(row.created_at_client,clientTime);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM idempotency_records').get().n,1);
  const again=await submit(c,d,key,body);assert.equal(again.status,200);assert.equal(again.body.capture_id,first.body.capture_id);
  assert.equal((await submit(c,d,key,{...body,text:'different'})).status,409);
  const me=await c.request('/api/v1/watch/me',undefined,{headers:d.headers});assert.equal(me.body.capabilities.ask,false);
  const admin=await d.owner.request('/captures');assert.equal(admin.body.captures[0].text,body.text);
  const exported=await c.request('/api/export');assert.doesNotMatch(exported.text,/owner_password_hash|secret_hash|csrf|pairing_sessions/);
});
test('Lost response, application restart and a new device credential recover the same Capture ID',async t=> {
  const f=await fixture(t);let c=await f.start();const first=await f.pair(c),key=randomUUID(),body=captureBody(f.workspace);
  // Disconnect at the response boundary without consuming any receipt/body.
  await new Promise((resolve,reject)=> {
    let headersReceived=false;
    const req=http.request({host:'127.0.0.1',port:c.port,path:'/api/v1/watch/captures',method:'POST',headers:{...first.headers,'Idempotency-Key':key,'Content-Type':'application/json'}},res=> {
      headersReceived=true;assert.equal(res.statusCode,201);res.destroy();resolve();
    });req.on('error',error=> {if(!headersReceived) reject(error);});req.end(JSON.stringify(body));
  });
  const committed=f.control.db.prepare('SELECT id FROM captures').get();assert.ok(committed);
  await c.app.close();c=await f.start();const replacement=await f.pair(c);
  const replay=await submit(c,replacement,key,body);assert.equal(replay.status,200);assert.equal(replay.body.capture_id,committed.id);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM captures').get().n,1);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});
test('Concurrent same-key requests create one row; transaction failures leave no partial Capture',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c),key=randomUUID(),body=captureBody(f.workspace);
  const responses=await Promise.all(Array.from({length:5},()=>submit(c,d,key,body)));
  assert.equal(responses.filter(r=>r.status===201).length,1);assert.equal(new Set(responses.map(r=>r.body.capture_id)).size,1);
  f.control.db.exec("CREATE TRIGGER fail_index BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'fixture internal detail'); END;");
  const fail=await submit(c,d,randomUUID(),body);assert.equal(fail.status,500);assert.doesNotMatch(fail.text,/fixture internal/);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM captures').get().n,1);assert.equal(f.control.db.prepare('SELECT count(*) n FROM idempotency_records').get().n,1);
});
test('Pairing first-response replay retains ID and code; altered content conflicts; expiry cannot revive a request',async t=> {
  const f=await fixture(t),c=await f.start(),secret=randomSecret();
  const body={pairing_request_id:randomUUID(),device_secret_hash:sha256(secret),device_name:'示例设备'};
  const first=await c.request('/api/v1/pairings',body),second=await c.request('/api/v1/pairings',body);
  assert.deepEqual(first.body,second.body);assert.match(first.body.user_code,/^[A-Z2-9]{8}$/);
  assert.equal((await c.request('/api/v1/pairings',{...body,device_name:'另一个'})).status,409);
  const pendingHeaders={Authorization:`Bearer ${secret}`};assert.equal((await c.request('/api/v1/watch/me',undefined,{headers:pendingHeaders})).status,401);
  assert.equal((await c.request(`/api/v1/pairings/${first.body.pairing_id}`,undefined,{headers:pendingHeaders})).body.status,'pending');
  f.advance(600001);const expired=await c.request('/api/v1/pairings',body);assert.equal(expired.body.status,'expired');assert.equal(expired.body.user_code,null);
  const owner=await c.owner();assert.equal((await owner.request(`/pairings/${first.body.pairing_id}/approve`,{allowed_workspace_ids:[f.workspace.id],default_workspace_id:f.workspace.id})).status,409);
});
test('Approval freezes scope; revoked, expired, unapproved and workspace-denied credentials fail closed',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c),other=f.service.createWorkspace('另一个空间');
  assert.equal((await d.owner.request(`/pairings/${d.pending.pairing_id}/approve`,{allowed_workspace_ids:[other.id],default_workspace_id:other.id})).status,409);
  assert.equal((await submit(c,d,randomUUID(),captureBody(other))).status,403);
  const me=(await c.request('/api/v1/watch/me',undefined,{headers:d.headers})).body;
  const lookup=await d.owner.request('/pairings/lookup',{user_code:d.pending.user_code});assert.equal(lookup.body.device_name,'测试手表');assert.ok(lookup.body.requested_at);
  await d.owner.request(`/devices/${me.device_id}/revoke`,{});
  assert.equal((await submit(c,d,randomUUID(),captureBody(f.workspace))).status,401);
  for(const response of [await c.request('/api/v1/pairings',d.body),await c.request(`/api/v1/pairings/${d.pending.pairing_id}`,undefined,{headers:d.headers})]) {
    assert.equal(response.body.status,'revoked');assert.equal(response.body.owner_id,undefined);assert.equal(response.body.capabilities,undefined);
  }
  const fresh=await f.pair(c);f.advance(90*24*60*60*1000+1);assert.equal((await c.request('/api/v1/watch/feed',undefined,{headers:fresh.headers})).status,401);
  const expired=await c.request('/api/v1/pairings',fresh.body);assert.equal(expired.body.status,'expired');assert.equal(expired.body.allowed_workspaces,undefined);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM captures').get().n,0);
});
test('Revocation during body upload is rechecked in the write transaction',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c),key=randomUUID();
  const body=JSON.stringify(captureBody(f.workspace));
  let req;
  const response=new Promise((resolve,reject)=> {
    req=http.request({host:'127.0.0.1',port:c.port,path:'/api/v1/watch/captures',method:'POST',headers:{Authorization:`Bearer ${d.secret}`,'Idempotency-Key':key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(body.slice(0,10));
  });
  await new Promise(resolve=>setTimeout(resolve,20));
  const row=f.service.device(d.secret,'capture');f.service.revoke(row.id);req.end(body.slice(10));
  assert.equal(await response,401);assert.equal(f.control.db.prepare('SELECT count(*) n FROM captures').get().n,0);
});
test('Owner session, same Origin and CSRF are separate from device Bearer; credentials never leak',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c);
  assert.equal((await c.request('/api/v1/owner/captures',undefined,{headers:d.headers})).status,401);
  assert.equal((await c.request('/api/state',undefined,{headers:d.headers})).status,403);
  const missing=await c.request('/api/v1/owner/workspaces',{name:'新空间'},{headers:{Cookie:d.owner.headers.Cookie}});assert.equal(missing.status,403);
  const foreign=await d.owner.request('/workspaces',{name:'跨站'},{headers:{Origin:'https://other.example'}});assert.equal(foreign.status,403);
  const list=await d.owner.request('/devices');assert.doesNotMatch(list.text,/secret_hash|scrypt|csrf|Bearer/);assert.ok(!list.text.includes(d.secret));
  assert.equal(f.control.db.prepare('SELECT secret_hash FROM devices').get().secret_hash,sha256(d.secret));
  assert.ok(!(await readFile(path.join(f.dir,'workspace.sqlite'))).includes(Buffer.from(d.secret)));
});
test('Body size, Unicode limits and exact original timestamps are validated without rewriting',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c);
  assert.equal((await submit(c,d,randomUUID(),captureBody(f.workspace,'🙂'.repeat(4000)))).status,201);
  assert.equal((await submit(c,d,randomUUID(),captureBody(f.workspace,'🙂'.repeat(4001)))).status,422);
  assert.equal((await submit(c,d,randomUUID(),captureBody(f.workspace,'\ud800'))).status,422);
  const huge=await c.request('/api/v1/watch/captures',{}, {headers:{...d.headers,'Idempotency-Key':randomUUID()},raw:' '.repeat(32769)});assert.equal(huge.status,413);
  assert.equal((await submit(c,d,randomUUID(),{...captureBody(f.workspace),extra:'not supported'})).status,422);
  assert.equal((await submit(c,d,randomUUID(),{...captureBody(f.workspace),created_at_client:'not-a-time'})).status,422);
});
test('Feed has stable pagination and current workspace filtering; tombstones prevent recreation',async t=> {
  const f=await fixture(t),c=await f.start(),d=await f.pair(c),b=captureBody(f.workspace);
  const keys=Array.from({length:3},()=>randomUUID());for(const key of keys) await submit(c,d,key,b);
  const first=await c.request('/api/v1/watch/feed?limit=2',undefined,{headers:d.headers});assert.equal(first.body.items.length,2);assert.doesNotMatch(first.text,/'text':|"text":|sourceText/);
  const second=await c.request(`/api/v1/watch/feed?limit=2&cursor=${first.body.next_cursor}`,undefined,{headers:d.headers});assert.equal(second.body.items.length,1);assert.equal(second.body.next_cursor,null);
  assert.equal(new Set([...first.body.items,...second.body.items].map(r=>r.id)).size,3);
  f.control.db.prepare('UPDATE idempotency_records SET tombstone=1 WHERE request_id=?').run(keys[0]);
  assert.equal((await submit(c,d,keys[0],b)).body.error.code,'RESOURCE_DELETED');
  f.control.db.prepare("UPDATE workspaces SET status='archived' WHERE id=?").run(f.workspace.id);
  assert.equal((await submit(c,d,randomUUID(),b)).body.error.code,'WORKSPACE_UNAVAILABLE');
  assert.equal((await c.request('/api/v1/watch/feed',undefined,{headers:d.headers})).body.items.length,0);
});
test('Pairing/login guessing is limited, and the shared UTF8-secret hash vector matches',async t=> {
  const fixtureVector=JSON.parse(await readFile(new URL('./fixtures/watch-contract.json',import.meta.url),'utf8')).pairing_vector;
  assert.equal(Buffer.from(fixtureVector.random_bytes_hex,'hex').toString('base64url'),fixtureVector.device_secret);assert.equal(sha256(fixtureVector.device_secret),fixtureVector.device_secret_hash);
  const f=await fixture(t),c=await f.start();let response;
  for(let i=0;i<6;i++) response=await c.request('/api/v1/owner/login',{password:'wrong'});
  assert.equal(response.status,429);assert.ok(response.headers['retry-after']);assert.equal(response.body.error.retryable,true);
});
test('Server mode requires configured owner and explicit TLS proxy; legacy routes stay inaccessible',async t=> {
  const f=await fixture(t,{serverMode:true}),c=await f.start(),d=await f.pair(c);
  assert.equal((await c.request('/api/v1/watch/me',undefined,{headers:d.headers})).status,200);
  const noTls=await c.request('/api/v1/diagnostics',undefined,{headers:{'X-Forwarded-Proto':'http'}});assert.equal(noTls.status,403);
  assert.equal((await c.request('/api/v1/diagnostics',undefined,{headers:{Host:'attacker.example'}})).status,403);
  for(const route of ['/api/state','/api/export','/api/settings','/api/thinkflow/notebooks']) assert.equal((await c.request(route,undefined,{headers:d.headers})).status,404);
  const untrusted=await f.start({trustedProxyAddresses:[]});assert.equal((await untrusted.request('/api/v1/diagnostics')).status,403);
  const owner=await c.request('/api/v1/owner/login',{password});assert.match(owner.headers['set-cookie'][0],/Secure/);
  await assert.rejects(createApp({dataDir:f.dir,storage:'sqlite',mode:'server'}),/HTTPS/);
});
test('SQLite does not silently replace JSON; migrated interrupted legacy tasks keep conservative recovery',async t=> {
  const dir=await mkdtemp(path.join(tmpdir(),'pa-migrate-server-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'workspace.json'),databasePath=path.join(dir,'workspace.sqlite');
  const task={id:'old-task',title:'旧任务',kind:'study',instruction:'原要求',sourceText:'旧正文',sources:[],status:'queued',createdAt:clientTime,updatedAt:clientTime,result:null,error:null,knowledgeId:null,conversation:[],events:[]};
  const state={version:1,tasks:[task],knowledge:[],settings:{provider:'extractive',model:'',baseUrl:''}};
  await writeFile(source,JSON.stringify(state));
  await assert.rejects(createApp({dataDir:dir,storage:'sqlite'}),/MIGRATION_REQUIRED/);
  await migrateWorkspace({sourcePath:source,databasePath,backupDir:path.join(dir,'private-backup')});
  let calls=0;const app=await createApp({dataDir:dir,storage:'sqlite',processor:{processTask(){calls++;}}});await app.close();
  const db=new SQLiteStore({filename:databasePath});assert.equal(db.readLegacyState().tasks[0].status,'failed');db.close();assert.equal(calls,0);
  assert.deepEqual(JSON.parse(await readFile(source,'utf8')),state);
  await writeFile(source,JSON.stringify({...state,knowledge:[],unexpected:'old writer changed source'}));
  await assert.rejects(createApp({dataDir:dir,storage:'sqlite'}),/旧JSON已变化/);
});
