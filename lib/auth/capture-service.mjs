import {randomInt,randomUUID} from 'node:crypto';
import {sha256,equalHash,randomSecret,verifyPassword} from './security.mjs';

export class APIError extends Error {
  constructor(status,code,message,retryable=false) { super(message); Object.assign(this,{status,code,retryable}); }
}
export function requireValue(condition,status,code,message) { if(!condition) throw new APIError(status,code,message); }
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=JSON.stringify;
const iso=value=>new Date(value).toISOString();
const id=prefix=>`${prefix}_${randomUUID()}`;
const parse=value=>JSON.parse(value);
const codeAlphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export class CaptureService {
  constructor(store,{clock=()=>Date.now(),askAvailable=()=>false}={}) {
    this.store=store; this.db=store.db; this.clock=clock;this.askAvailable=askAvailable;
    const schema=this.meta('capture_schema_version');
    if(schema && schema!=='1') throw new Error('Unsupported Capture database schema; explicit version migration is required');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', allowed_json TEXT NOT NULL DEFAULT '[]', default_workspace_id TEXT, expires_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pairing_sessions(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id), user_code TEXT UNIQUE, expires_at TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_sessions(secret_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),device_id TEXT NOT NULL REFERENCES devices(id),text TEXT NOT NULL,created_at_client TEXT NOT NULL,accepted_at TEXT NOT NULL,index_status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS idempotency_records(owner_id TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,body_hash TEXT NOT NULL,resource_id TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,operation,request_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,operation TEXT NOT NULL,resource_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capture_feed ON captures(owner_id,accepted_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS pairing_code ON pairing_sessions(user_code);
    `);
    this.store.transaction(()=> {
      for(const [key,value] of [['deployment_id',id('dep')],['owner_id',id('owner')],['capture_schema_version','1']]) this.db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(key,value);
    });
    this.ownerId=this.meta('owner_id'); this.deploymentId=this.meta('deployment_id');
  }
  meta(key) { return this.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value; }
  configured() { return Boolean(this.meta('owner_password_hash')); }
  setPasswordHash(value,{replace=false}={}) {
    requireValue(!this.configured() || replace,409,'ALREADY_INITIALIZED','管理员已初始化；重置需要显式操作');
    this.store.transaction(()=> {
      this.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('owner_password_hash',value);
      this.db.prepare('DELETE FROM owner_sessions').run();
    });
  }
  createWorkspace(name) {
    requireValue(typeof name==='string' && name.trim() && [...name].length<=120,422,'INVALID_WORKSPACE','空间名称需要1至120字符');
    const workspace={id:id('ws'),name:name.trim(),status:'active',created_at:iso(this.clock())};
    this.db.prepare('INSERT INTO workspaces(id,owner_id,name,status,created_at) VALUES(?,?,?,?,?)').run(workspace.id,this.ownerId,workspace.name,workspace.status,workspace.created_at);
    return workspace;
  }
  workspaces() { return this.db.prepare("SELECT id,name,status,created_at FROM workspaces WHERE owner_id=? AND status='active' ORDER BY created_at,id").all(this.ownerId); }
  async login(password) {
    const encoded=this.meta('owner_password_hash');
    requireValue(await verifyPassword(password,encoded),401,'INVALID_CREDENTIALS','登录失败，请检查密码');
    return this.store.transaction(()=> {
      requireValue(this.meta('owner_password_hash')===encoded,401,'INVALID_CREDENTIALS','管理员凭据已变化，请重新登录');
      const secret=randomSecret(), csrf=randomSecret(),expiresAt=iso(this.clock()+12*60*60*1000);
      this.db.prepare('DELETE FROM owner_sessions WHERE expires_at<=?').run(iso(this.clock()));
      this.db.prepare('INSERT INTO owner_sessions VALUES(?,?,?)').run(sha256(secret),csrf,expiresAt);
      return {secret,csrf,expires_at:expiresAt};
    });
  }
  ownerSession(secret) {
    const session=typeof secret==='string' && this.db.prepare('SELECT csrf,expires_at FROM owner_sessions WHERE secret_hash=?').get(sha256(secret));
    requireValue(session && session.expires_at>iso(this.clock()),401,'OWNER_AUTH_REQUIRED','请先登录管理员');
    return session;
  }
  logout(secret) { this.db.prepare('DELETE FROM owner_sessions WHERE secret_hash=?').run(sha256(secret)); }
  pair(body,origin) {
    const {pairing_request_id:requestId,device_secret_hash:hash,device_name:name}=body;
    requireValue(UUID.test(requestId || '') && /^[a-f0-9]{64}$/.test(hash || '') && typeof name==='string' && name.trim() && [...name].length<=80,422,'INVALID_PAIRING','配对请求格式不正确');
    const canonical=sha256(json({pairing_request_id:requestId.toLowerCase(),device_secret_hash:hash,device_name:name}));
    return this.store.transaction(()=> {
      this.expirePairings();
      let session=this.db.prepare('SELECT * FROM pairing_sessions WHERE request_id=?').get(requestId.toLowerCase());
      if(session) {
        requireValue(session.body_hash===canonical,409,'IDEMPOTENCY_CONFLICT','配对请求编号对应不同内容');
        return this.pairingResponse(session,origin);
      }
      requireValue(!this.db.prepare('SELECT id FROM devices WHERE secret_hash=?').get(hash),409,'CREDENTIAL_REUSED','请为新的配对生成独立设备凭据');
      const deviceId=id('dev');
      this.db.prepare('INSERT INTO devices(id,owner_id,secret_hash,name,status) VALUES(?,?,?,?,?)').run(deviceId,this.ownerId,hash,name,'pending');
      let userCode;
      do { userCode=Array.from({length:8},()=>codeAlphabet[randomInt(codeAlphabet.length)]).join(''); } while(this.db.prepare('SELECT id FROM pairing_sessions WHERE user_code=?').get(userCode));
      session={id:id('pair'),request_id:requestId.toLowerCase(),body_hash:canonical,device_id:deviceId,user_code:userCode,expires_at:iso(this.clock()+10*60*1000),status:'pending'};
      this.db.prepare('INSERT INTO pairing_sessions VALUES(?,?,?,?,?,?,?)').run(session.id,session.request_id,canonical,deviceId,userCode,session.expires_at,session.status);
      return this.pairingResponse(session,origin);
    });
  }
  expirePairings() {
    const now=iso(this.clock());
    this.db.prepare("UPDATE devices SET status='expired' WHERE status='pending' AND id IN(SELECT device_id FROM pairing_sessions WHERE status='pending' AND expires_at<=?)").run(now);
    this.db.prepare("UPDATE pairing_sessions SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
    this.db.prepare('UPDATE pairing_sessions SET user_code=NULL WHERE expires_at<=?').run(now);
  }
  pairingResponse(session,origin) {
    const device=this.db.prepare('SELECT * FROM devices WHERE id=?').get(session.device_id);
    let status=session.status;
    if(device.status==='revoked' || device.revoked_at) status='revoked';
    else if(device.status==='expired' || (device.expires_at && device.expires_at<=iso(this.clock()))) status='expired';
    const response={schema_version:'1',pairing_id:session.id,status,user_code:session.user_code,expires_at:session.expires_at,approval_url:`${origin}/owner#pair`};
    if(status==='approved' && device.status==='active') Object.assign(response,this.identity(device));
    return response;
  }
  status(pairingId,secret,origin) {
    this.expirePairings();
    const session=this.db.prepare('SELECT * FROM pairing_sessions WHERE id=?').get(pairingId);
    const device=session && this.db.prepare('SELECT * FROM devices WHERE id=?').get(session.device_id);
    requireValue(device && /^[A-Za-z0-9_-]{43}$/.test(secret || '') && equalHash(device.secret_hash,sha256(secret)),401,'DEVICE_AUTH_REQUIRED','设备凭据无效');
    return this.pairingResponse(session,origin);
  }
  lookup(code) {
    this.expirePairings();
    requireValue(typeof code==='string' && /^[A-Z2-9]{8}$/.test(code),422,'INVALID_PAIRING_CODE','配对码应为8位字符');
    const row=this.db.prepare('SELECT p.id AS pairing_id,p.status,p.expires_at,d.name AS device_name FROM pairing_sessions p JOIN devices d ON p.device_id=d.id WHERE p.user_code=?').get(code);
    requireValue(row,404,'PAIRING_NOT_FOUND','配对码不存在或已过期'); return {...row,requested_at:iso(Date.parse(row.expires_at)-600000)};
  }
  approve(pairingId,{allowed_workspace_ids:allowed,default_workspace_id:defaultId},denied=false) {
    return this.store.transaction(()=> {
      this.expirePairings();
      const pairing=this.db.prepare('SELECT * FROM pairing_sessions WHERE id=?').get(pairingId);
      requireValue(pairing,404,'PAIRING_NOT_FOUND','配对请求不存在');
      requireValue(pairing.status==='pending' && pairing.expires_at>iso(this.clock()),409,'PAIRING_NOT_PENDING','配对已处理或过期，不能更改权限');
      if(!denied) {
        const available=new Set(this.workspaces().map(w=>w.id));
        requireValue(Array.isArray(allowed) && allowed.length>0 && allowed.length<=50 && new Set(allowed).size===allowed.length && allowed.every(w=>available.has(w)) && allowed.includes(defaultId),422,'INVALID_SCOPE','请选择有效的允许空间及默认空间');
      }
      const status=denied?'denied':'approved';
      const result=this.db.prepare("UPDATE pairing_sessions SET status=? WHERE id=? AND status='pending' AND expires_at>?").run(status,pairingId,iso(this.clock()));
      requireValue(result.changes===1,409,'PAIRING_NOT_PENDING','配对状态已变化');
      this.db.prepare('UPDATE devices SET status=?,scopes_json=?,allowed_json=?,default_workspace_id=?,expires_at=? WHERE id=?').run(denied?'denied':'active',json(denied?[]:['capture','ask','feed']),json(denied?[]:allowed),denied?null:defaultId,denied?null:iso(this.clock()+90*24*60*60*1000),pairing.device_id);
      return {pairing_id:pairingId,status};
    });
  }
  device(secret,scope) {
    const device=/^[A-Za-z0-9_-]{43}$/.test(secret || '') && this.db.prepare('SELECT * FROM devices WHERE secret_hash=?').get(sha256(secret));
    requireValue(device && device.status==='active' && device.expires_at>iso(this.clock()) && !device.revoked_at,401,'DEVICE_AUTH_REQUIRED','设备未批准、已过期或已撤销');
    requireValue(!scope || parse(device.scopes_json).includes(scope),403,'SCOPE_DENIED','设备没有此操作权限');
    return device;
  }
  identity(device) {
    const allowed=parse(device.allowed_json);
    const spaces=this.workspaces().filter(w=>allowed.includes(w.id)).map(({id,name})=>({id,name}));
    return {owner_id:this.ownerId,deployment_id:this.deploymentId,device_id:device.id,default_workspace:spaces.find(w=>w.id===device.default_workspace_id) || null,allowed_workspaces:spaces,device_expires_at:device.expires_at,capabilities:{capture:parse(device.scopes_json).includes('capture'),ask:parse(device.scopes_json).includes('ask')&&Boolean(this.askAvailable()),feed:parse(device.scopes_json).includes('feed')}};
  }
  listDevices() { return this.db.prepare('SELECT id,name,status,scopes_json,allowed_json,default_workspace_id,expires_at,revoked_at FROM devices WHERE owner_id=? ORDER BY id').all(this.ownerId).map(({scopes_json,allowed_json,...d})=>({...d,scopes:parse(scopes_json),allowed_workspace_ids:parse(allowed_json)})); }
  revoke(deviceId) {
    return this.store.transaction(()=> {
      requireValue(this.db.prepare("UPDATE devices SET status='revoked',revoked_at=? WHERE id=? AND owner_id=?").run(iso(this.clock()),deviceId,this.ownerId).changes===1,404,'DEVICE_NOT_FOUND','设备不存在');
      this.db.prepare("UPDATE pairing_sessions SET status='revoked' WHERE device_id=? AND status='pending'").run(deviceId);
      return {id:deviceId,status:'revoked'};
    });
  }
  capture(device,key,body) {
    const {workspace_id:workspaceId,text,created_at_client:clientTime}=body;
    requireValue(UUID.test(key || '') && typeof workspaceId==='string' && workspaceId.length<=200 && typeof text==='string' && text.isWellFormed() && text.trim() && [...text].length<=4000 && typeof clientTime==='string' && clientTime.length<=40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(clientTime) && Number.isFinite(Date.parse(clientTime)),422,'INVALID_CAPTURE','正文、空间、请求编号或客户端时间格式不正确');
    const hash=sha256(json({workspace_id:workspaceId,text,created_at_client:clientTime}));
    return this.store.transaction(()=> {
      // Recheck after request-body I/O, in the same transaction as the write.
      const fresh=this.db.prepare('SELECT * FROM devices WHERE id=? AND owner_id=?').get(device.id,this.ownerId);
      requireValue(fresh && fresh.status==='active' && !fresh.revoked_at && fresh.expires_at>iso(this.clock()),401,'DEVICE_AUTH_REQUIRED','设备已过期或撤销，原文应继续保留在手表');
      requireValue(parse(fresh.scopes_json).includes('capture'),403,'SCOPE_DENIED','设备没有保存笔记的权限');
      requireValue(parse(fresh.allowed_json).includes(workspaceId),403,'WORKSPACE_FORBIDDEN','设备未获授权访问原研究空间，原文应继续保留在手表');
      requireValue(this.db.prepare("SELECT id FROM workspaces WHERE id=? AND owner_id=? AND status='active'").get(workspaceId,this.ownerId),409,'WORKSPACE_UNAVAILABLE','原研究空间不可用，内容仍保存在手表');
      const prior=this.db.prepare("SELECT * FROM idempotency_records WHERE owner_id=? AND operation='capture' AND request_id=?").get(this.ownerId,key.toLowerCase());
      if(prior) {
        requireValue(prior.body_hash===hash,409,'IDEMPOTENCY_CONFLICT','相同请求编号对应不同内容');
        requireValue(!prior.tombstone,409,'RESOURCE_DELETED','此前已保存的记录已被删除，不会重新创建');
        const capture=this.db.prepare('SELECT * FROM captures WHERE id=?').get(prior.resource_id);
        requireValue(capture,409,'RESOURCE_UNAVAILABLE','此前已保存的记录暂不可用，不会重复创建');
        return {replayed:true,response:this.captureResponse(capture)};
      }
      const capture={id:id('cap'),workspace_id:workspaceId,text,created_at_client:clientTime,accepted_at:iso(this.clock()),index_status:'pending'};
      this.db.prepare('INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)').run(capture.id,this.ownerId,workspaceId,device.id,text,clientTime,capture.accepted_at,'pending');
      this.db.prepare('INSERT INTO idempotency_records VALUES(?,?,?,?,?,0)').run(this.ownerId,'capture',key.toLowerCase(),hash,capture.id);
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(id('job'),'index_capture',capture.id,'queued',capture.accepted_at);
      return {replayed:false,response:this.captureResponse(capture)};
    });
  }
  captureResponse(capture) { return {schema_version:'1',capture_id:capture.id,workspace_id:capture.workspace_id,status:'saved',index_status:capture.index_status,accepted_at:capture.accepted_at}; }
  listCaptures() { return this.db.prepare('SELECT id,workspace_id,text,created_at_client,accepted_at,index_status FROM captures WHERE owner_id=? ORDER BY accepted_at DESC,id DESC LIMIT 200').all(this.ownerId); }
  feed(device,{cursor,limit='20'}={}) {
    requireValue(/^\d{1,2}$/.test(limit) && Number(limit)>=1 && Number(limit)<=50,422,'INVALID_PAGINATION','每页应为1至50项');
    const spaces=this.identity(device).allowed_workspaces.map(w=>w.id);
    if(!spaces.length) return {schema_version:'1',items:[],next_cursor:null};
    let after;
    if(cursor) {
      try { requireValue(cursor.length<=500,422,'INVALID_CURSOR','分页游标无效'); after=parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch { throw new APIError(422,'INVALID_CURSOR','分页游标无效'); }
      requireValue(after && typeof after.at==='string' && typeof after.id==='string' && after.owner===this.ownerId && after.device===device.id,422,'INVALID_CURSOR','分页游标与当前设备不一致');
    }
    const sql=`SELECT id,workspace_id,text,accepted_at,index_status FROM captures WHERE owner_id=? AND workspace_id IN(${spaces.map(()=>'?').join(',')})${after?' AND (accepted_at<? OR (accepted_at=? AND id<?))':''} ORDER BY accepted_at DESC,id DESC LIMIT ?`;
    const rows=this.db.prepare(sql).all(this.ownerId,...spaces,...(after?[after.at,after.at,after.id]:[]),Number(limit)+1);
    const page=rows.slice(0,Number(limit)),last=page.at(-1);
    return {schema_version:'1',items:page.map(({text,...r})=>({...r,type:'capture',title:[...text.trim()].slice(0,40).join(''),status:'saved'})),next_cursor:rows.length>Number(limit)?Buffer.from(json({at:last.accepted_at,id:last.id,owner:this.ownerId,device:device.id})).toString('base64url'):null};
  }
}
