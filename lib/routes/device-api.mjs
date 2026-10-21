import {randomUUID} from 'node:crypto';
import {APIError,requireValue} from '../auth/capture-service.mjs';

function fields(body,names) { requireValue(Object.keys(body).every(k=>names.includes(k)),422,'UNKNOWN_FIELD','请求包含未支持字段'); return body; }
async function readJSON(req) {
  requireValue((req.headers['content-type'] || '').split(';')[0].trim()==='application/json',415,'JSON_REQUIRED','请求需要JSON格式');
  const chunks=[]; let length=0;
  for await(const chunk of req) { length+=chunk.length; if(length>32768) throw new APIError(413,'BODY_TOO_LARGE','请求最多32 KiB UTF-8'); chunks.push(chunk); }
  let body;
  try { body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); } catch { throw new APIError(400,'INVALID_JSON','JSON或UTF-8格式不正确'); }
  requireValue(body && typeof body==='object' && !Array.isArray(body),422,'JSON_OBJECT_REQUIRED','请求需要JSON对象'); return body;
}
function bearer(req) { return (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] || ''; }
function sessionCookie(req) { return (req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('pa_owner='))?.slice(9) || ''; }

export function createDeviceAPI({service,config,clock=()=>Date.now(),json}) {
  const rateBuckets=new Map();
  function limit(req,operation,max,windowMs=60000) {
    const now=clock(),key=`${operation}:${req.socket.remoteAddress}`;
    if(rateBuckets.size>2000) for(const [k,v] of rateBuckets) if(v.end<=now) rateBuckets.delete(k);
    let bucket=rateBuckets.get(key);
    if(!bucket || bucket.end<=now) { bucket={count:0,end:now+windowMs};rateBuckets.set(key,bucket); }
    bucket.count++;
    if(bucket.count>max) { const e=new APIError(429,'RATE_LIMITED','请求过于频繁，请稍后重试',true); e.retryAfter=Math.ceil((bucket.end-now)/1000);throw e; }
  }
  const cookie=(secret,clear=false)=>`pa_owner=${clear?'':secret}; HttpOnly; SameSite=Strict; Path=/api/v1/owner; ${config.mode==='server'?'Secure; ':''}Max-Age=${clear?0:43200}`;
  return async function route(req,res,url) {
    const route=url.pathname;
    if(!route.startsWith('/api/v1/')) return false;
    const requestId=`req_${randomUUID()}`;
    const origin=config.mode==='server'?config.publicOrigin:url.origin;
    function send(body,status=200,headers={}) { json(res,body,status,{'X-Request-Id':requestId,...headers}); return true; }
    try {
      if(route==='/api/v1/diagnostics' && req.method==='GET') return send({schema_version:'1',version:'0.2.0',request_id:requestId});
      requireValue(service?.configured(),503,'CAPTURE_NOT_CONFIGURED','请先在本机初始化SQLite和管理员身份');
      if(route==='/api/v1/pairings' && req.method==='POST') {
        limit(req,'pairing-create',10,600000);
        return send(service.pair(fields(await readJSON(req),['pairing_request_id','device_secret_hash','device_name']),origin),201);
      }
      const pairing=route.match(/^\/api\/v1\/pairings\/(pair_[a-f0-9-]+)$/);
      if(pairing && req.method==='GET') { limit(req,'pairing-status',120);return send(service.status(pairing[1],bearer(req),origin)); }
      if(route.startsWith('/api/v1/owner/')) {
        const write=!['GET','HEAD'].includes(req.method);
        if(write) requireValue(req.headers.origin===origin,403,'ORIGIN_DENIED','管理员写请求需要同源Origin');
        if(route==='/api/v1/owner/login' && req.method==='POST') {
          limit(req,'owner-login',5);
          const body=fields(await readJSON(req),['password']);
          const session=await service.login(body.password);
          return send({schema_version:'1',csrf_token:session.csrf,expires_at:session.expires_at},200,{'Set-Cookie':cookie(session.secret)});
        }
        const secret=sessionCookie(req);
        function authorizeOwner() {
          const session=service.ownerSession(secret);
          if(write) requireValue(req.headers['x-csrf-token']===session.csrf,403,'CSRF_DENIED','管理员操作需要当前会话的CSRF token');
          return session;
        }
        const session=authorizeOwner();
        const body=write ? await readJSON(req) : undefined;
        // Uploading a body may outlive logout, expiry or credential rotation.
        if(write) authorizeOwner();
        if(route==='/api/v1/owner/session' && req.method==='GET') return send({schema_version:'1',csrf_token:session.csrf,expires_at:session.expires_at,owner_id:service.ownerId,deployment_id:service.deploymentId});
        if(route==='/api/v1/owner/logout' && req.method==='POST') { fields(body,[]);service.logout(secret);return send({status:'signed_out'},200,{'Set-Cookie':cookie('',true)}); }
        if(route==='/api/v1/owner/workspaces') {
          if(req.method==='GET') return send({workspaces:service.workspaces()});
          if(req.method==='POST') { fields(body,['name']);return send(service.createWorkspace(body.name),201); }
        }
        if(route==='/api/v1/owner/devices' && req.method==='GET') return send({devices:service.listDevices()});
        if(route==='/api/v1/owner/captures' && req.method==='GET') return send({captures:service.listCaptures()});
        if(route==='/api/v1/owner/pairings/lookup' && req.method==='POST') {
          limit(req,'pairing-lookup',10);
          fields(body,['user_code']);return send(service.lookup(body.user_code));
        }
        const approval=route.match(/^\/api\/v1\/owner\/pairings\/(pair_[a-f0-9-]+)\/(approve|deny)$/);
        if(approval && req.method==='POST') {
          limit(req,'pairing-approve',10);
          return send(service.approve(approval[1],fields(body,approval[2]==='deny'?[]:['allowed_workspace_ids','default_workspace_id']),approval[2]==='deny'));
        }
        const revoke=route.match(/^\/api\/v1\/owner\/devices\/(dev_[a-f0-9-]+)\/revoke$/);
        if(revoke && req.method==='POST') { fields(body,[]);return send(service.revoke(revoke[1])); }
        throw new APIError(404,'NOT_FOUND','管理接口不存在');
      }
      if(route.startsWith('/api/v1/watch/')) {
        const scope=route==='/api/v1/watch/captures'?'capture':route==='/api/v1/watch/feed'?'feed':null;
        const device=service.device(bearer(req),scope);
        if(route==='/api/v1/watch/me' && req.method==='GET') return send({schema_version:'1',...service.identity(device)});
        if(route==='/api/v1/watch/captures' && req.method==='POST') {
          limit(req,'capture',120);
          const result=service.capture(device,req.headers['idempotency-key'],fields(await readJSON(req),['workspace_id','text','created_at_client']));
          return send(result.response,result.replayed?200:201);
        }
        if(route==='/api/v1/watch/feed' && req.method==='GET') {
          requireValue([...url.searchParams.keys()].every(k=>['cursor','limit'].includes(k)),422,'UNKNOWN_FIELD','分页参数不支持');
          return send(service.feed(device,{cursor:url.searchParams.get('cursor'),limit:url.searchParams.get('limit') || '20'}));
        }
        throw new APIError(404,'CAPABILITY_NOT_AVAILABLE','M1尚未启用此设备接口');
      }
      throw new APIError(404,'NOT_FOUND','接口不存在');
    } catch(error) {
      const busy=/SQLITE_BUSY|database is locked/.test(error.code || error.message || '');
      const status=error instanceof APIError?error.status:busy?503:500;
      const envelope={error:{code:error instanceof APIError?error.code:busy?'STORE_BUSY':'INTERNAL_ERROR',message:error instanceof APIError?error.message:busy?'存储暂忙，请重试同一请求编号':'服务暂时出错，请保留原文并重试同一请求编号',retryable:error instanceof APIError?error.retryable:busy,request_id:requestId}};
      return send(envelope,status,error.retryAfter || busy || status===503?{'Retry-After':String(error.retryAfter || 5)}:{});
    }
  };
}
