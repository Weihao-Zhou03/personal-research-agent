import {randomUUID,createHash} from 'node:crypto';
import {APIError,requireValue} from '../auth/capture-service.mjs';
import {explicitGenerateCheck,GenerationError} from '../llm/structured.mjs';
import {backupWorkspace} from '../store/backup.mjs';
const parse=JSON.parse;
const safeBody=(body,keys)=>{requireValue(body && Object.keys(body).every(k=>keys.includes(k)),422,'UNKNOWN_FIELD','请求包含未知字段');return body;};

export function createResearchAPI({store,capture,knowledge,jobs,models,archive,thinkflow,fetchImpl=fetch,clock=()=>Date.now(),backupDir}) {
  const db=store.db;
  const reply=(data,status=200,headers={})=>({data,status,headers});
  function workspace(id) {const row=db.prepare("SELECT * FROM workspaces WHERE id=? AND owner_id=? AND status='active'").get(id,capture.ownerId);requireValue(row,404,'WORKSPACE_UNAVAILABLE','研究空间不可用');return row;}
  function ownedJob(id) {const job=jobs.get(id);requireValue(job.owner_id===capture.ownerId,404,'JOB_NOT_FOUND','问题不存在');workspace(job.workspace_id);return job;}
  function permission(device,id,scope) {
    const fresh=db.prepare('SELECT * FROM devices WHERE id=?').get(device.id);
    requireValue(fresh && fresh.owner_id===capture.ownerId && fresh.status==='active' && !fresh.revoked_at && fresh.expires_at>new Date(clock()).toISOString(),401,'DEVICE_AUTH_REQUIRED','设备已过期或撤销');
    requireValue(parse(fresh.scopes_json).includes(scope),403,'SCOPE_DENIED','设备没有此操作权限');
    requireValue(parse(fresh.allowed_json).includes(id),403,'WORKSPACE_FORBIDDEN','设备没有原研究空间权限');workspace(id);return fresh;
  }
  function deviceJob(device,id) {const job=jobs.get(id);permission(device,job.workspace_id,'ask');return job;}
  async function owner(req,url,body) {
    const path=url.pathname.replace('/api/v1/owner',''),method=req.method;
    if(path==='/model') {
      if(method==='GET')return reply(models.public());
      if(method==='POST')return reply(models.update(body));
    }
    if(path==='/model/connection-check' && method==='POST') {safeBody(body,[]);return reply(await models.connectionCheck());}
    if(path==='/model/generation-check' && method==='POST') {
      safeBody(body,[]);
      try{return reply(await explicitGenerateCheck(models.current(),{apiKey:models.resolveKey(models.current()),fetchImpl}));}
      catch(e){throw new APIError(e instanceof GenerationError?502:503,e.code || 'MODEL_CHECK_FAILED','公开样本生成检查未通过，请检查模型服务；本次调用可能产生用量');}
    }
    if(path==='/usage' && method==='GET')return reply(jobs.usage({ownerId:capture.ownerId}));
    if(path==='/readiness' && method==='GET') {
      let writable=false;try{db.exec('SAVEPOINT readiness_probe');db.prepare("INSERT OR REPLACE INTO app_meta VALUES('readiness_probe',?)").run(randomUUID());db.exec('ROLLBACK TO readiness_probe; RELEASE readiness_probe');writable=true;}catch{try{db.exec('ROLLBACK TO readiness_probe; RELEASE readiness_probe');}catch{}}
      let tf={ready:false};try{await thinkflow.notebooks();tf={ready:true};}catch{tf.code='THINKFLOW_UNAVAILABLE';}
      const worker=jobs.readiness();return reply({database:{writable},worker,capture:{ready:writable},ask:{ready:writable&&models.public().configured&&worker.ready!==false,model_configured:models.public().configured},thinkflow:tf});
    }
    if(path==='/thinkflow/notebooks' && method==='GET')return reply({notebooks:await thinkflow.notebooks()});
    const tfSources=path.match(/^\/thinkflow\/notebooks\/([^/]+)\/sources$/);
    if(tfSources&&method==='GET')return reply(await thinkflow.sources(decodeURIComponent(tfSources[1])));
    const ws=path.match(/^\/workspaces\/([^/]+)(?:\/(sources|sync|bind|search|asks))?$/);
    if(ws) {
      const id=decodeURIComponent(ws[1]),row=workspace(id),action=ws[2];
      if(!action && method==='GET')return reply({...row,...knowledge.report(id)});
      if(!action && method==='POST'){safeBody(body,['name']);requireValue(typeof body.name==='string'&&body.name.trim()&&[...body.name].length<=120,422,'INVALID_WORKSPACE','空间名称需要1至120字符');db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(body.name.trim(),id);return reply({...row,name:body.name.trim()});}
      if(!action && method==='DELETE') {
        store.transaction(()=> {
          for(const job of db.prepare('SELECT id FROM research_jobs WHERE workspace_id=?').all(id)){archive.removeForJob(job.id);jobs.remove(job.id);}
          db.prepare("UPDATE idempotency_records SET tombstone=1 WHERE resource_id IN(SELECT id FROM captures WHERE workspace_id=?)").run(id);
          db.prepare('DELETE FROM jobs WHERE resource_id IN(SELECT id FROM captures WHERE workspace_id=?)').run(id);db.prepare('DELETE FROM captures WHERE workspace_id=?').run(id);
          knowledge.purgeWorkspace(id);db.prepare("UPDATE workspaces SET status='deleted',name='已删除空间' WHERE id=?").run(id);
        });return reply({status:'deleted',remote_and_backup_erasure:false});
      }
      if(action==='sources'&&method==='GET')return reply({...knowledge.report(id),sources:knowledge.listSources(id)});
      if(action==='sources'&&method==='POST'){safeBody(body,['title','text','source_id']);return reply(knowledge.importText({workspaceId:id,title:body.title,text:body.text,sourceId:body.source_id}),201);}
      if(action==='bind'&&method==='POST'){safeBody(body,['notebook_id']);return reply(await knowledge.bindThinkFlow(id,{notebookId:body.notebook_id,client:thinkflow}));}
      if(action==='sync'&&method==='POST'){safeBody(body,['notebook_id','source_ids']);return reply(await knowledge.syncThinkFlow(id,{notebookId:body.notebook_id,sourceIds:body.source_ids,client:thinkflow}));}
      if(action==='search'&&method==='POST'){safeBody(body,['question']);return reply({corpus_revision_id:knowledge.currentRevision(id),evidence:knowledge.evidence(id,knowledge.currentRevision(id),body.question)});}
      if(action==='asks'&&method==='POST'){safeBody(body,['question','created_at_client','request_id','retry_of']);const result=jobs.submit({ownerId:capture.ownerId,deviceId:'owner-web',workspaceId:id,requestId:body.request_id || req.headers['idempotency-key'],question:body.question,createdAtClient:body.created_at_client,retryOf:body.retry_of});return reply(result.response,result.replayed?200:202);}
    }
    const source=path.match(/^\/sources\/([^/]+)$/);
    if(source&&method==='DELETE') {safeBody(body,['workspace_id']);workspace(body.workspace_id);return reply(knowledge.deleteSource(body.workspace_id,source[1]));}
    const version=path.match(/^\/source-versions\/([^/]+)$/);
    if(version&&method==='GET') {const row=knowledge.getVersion(version[1]);requireValue(row,404,'SOURCE_NOT_FOUND','来源快照不存在');workspace(row.workspace_id);return reply(row);}
    if(path==='/jobs'&&method==='GET'){const selected=url.searchParams.get('workspace_id');if(selected)workspace(selected);return reply(jobs.list({workspaceIds:selected?[selected]:capture.workspaces().map(w=>w.id),cursor:url.searchParams.get('cursor'),limit:url.searchParams.get('limit') || 20}));}
    const captureRetry=path.match(/^\/captures\/([^/]+)\/retry-index$/);
    if(captureRetry&&method==='POST'){safeBody(body,[]);const row=db.prepare('SELECT * FROM captures WHERE id=? AND owner_id=?').get(captureRetry[1],capture.ownerId);requireValue(row,404,'CAPTURE_NOT_FOUND','原文不存在');workspace(row.workspace_id);store.transaction(()=>{db.prepare("UPDATE jobs SET status='queued' WHERE operation='index_capture' AND resource_id=? AND status='failed'").run(row.id);db.prepare("UPDATE captures SET index_status='pending' WHERE id=? AND index_status='failed'").run(row.id);});return reply({status:'queued'});}
    const job=path.match(/^\/jobs\/(job_[a-f0-9-]+)(?:\/(cancel|result|confirm|archives))?$/);
    if(job) {
      ownedJob(job[1]);const action=job[2];
      if(!action&&method==='GET')return reply({...jobs.get(job[1]),...archive.getForJob(job[1])});
      if(!action&&method==='DELETE'){archive.removeForJob(job[1]);jobs.remove(job[1]);return reply({status:'deleted',remote_and_backup_erasure:false});}
      if(action==='cancel'&&method==='POST'){safeBody(body,[]);return reply(jobs.cancel(job[1]));}
      if(action==='result'&&method==='POST'){safeBody(body,['result_revision','expected_content_hash','result']);return reply(jobs.edit(job[1],body));}
      if(action==='confirm'&&method==='POST'){safeBody(body,['result_revision','expected_content_hash','write_to_thinkflow']);return reply(archive.confirm(job[1],body),201);}
      if(action==='archives'&&method==='GET')return reply(archive.getForJob(job[1]));
    }
    const intent=path.match(/^\/writebacks\/([^/]+)\/reconcile$/);
    if(intent&&method==='POST'){safeBody(body,[]);return reply(await archive.reconcile(intent[1]));}
    const device=path.match(/^\/devices\/(dev_[a-f0-9-]+)\/settings$/);
    if(device&&method==='POST'){
      safeBody(body,['allowed_workspace_ids','default_workspace_id','enable_ask']);const row=db.prepare('SELECT * FROM devices WHERE id=? AND owner_id=?').get(device[1],capture.ownerId);
      requireValue(row && row.status==='active'&&!row.revoked_at&&row.expires_at>new Date(clock()).toISOString(),409,'DEVICE_NOT_ACTIVE','请为失效设备重新配对');
      const allowed=body.allowed_workspace_ids;requireValue(Array.isArray(allowed)&&allowed.length>0&&new Set(allowed).size===allowed.length&&allowed.includes(body.default_workspace_id),422,'INVALID_SCOPE','请选择允许和默认空间');allowed.forEach(workspace);
      const scopes=parse(row.scopes_json).filter(x=>x!=='ask');if(body.enable_ask===true)scopes.push('ask');
      db.prepare('UPDATE devices SET allowed_json=?,default_workspace_id=?,scopes_json=? WHERE id=?').run(JSON.stringify(allowed),body.default_workspace_id,JSON.stringify(scopes),row.id);return reply({status:'updated'});
    }
    if(path==='/backup'&&method==='POST'){safeBody(body,[]);requireValue(backupDir,503,'BACKUP_NOT_CONFIGURED','请在服务端配置私有备份目录');const result=await backupWorkspace({store,backupDir});return reply({status:'saved',created_at:result.created_at || new Date(clock()).toISOString(),includes_auth_verifiers:true,includes_thinkflow_files:false});}
    if(path==='/export'&&method==='GET'){
      const ids=capture.workspaces().map(w=>w.id),jobList=ids.flatMap(id=>db.prepare('SELECT id FROM research_jobs WHERE workspace_id=?').all(id).map(r=>jobs.get(r.id)));
      return reply({schema_version:'1',exported_at:new Date(clock()).toISOString(),workspaces:capture.workspaces(),captures:db.prepare('SELECT * FROM captures WHERE owner_id=? ORDER BY accepted_at,id').all(capture.ownerId),sources:ids.flatMap(id=>knowledge.listSources(id)),source_versions:ids.flatMap(id=>db.prepare('SELECT id FROM source_versions WHERE workspace_id=?').all(id).map(r=>knowledge.getVersion(r.id))),jobs:jobList,archives:jobList.flatMap(j=>archive.getForJob(j.job_id).archives),includes_thinkflow_original_files:false,includes_authentication:false},200,{'Content-Disposition':'attachment; filename="research-business-export.json"'});
    }
    return null;
  }
  function submitAsk(device,key,body) {
    safeBody(body,['workspace_id','question','created_at_client']);return store.transaction(()=>{const fresh=permission(device,body.workspace_id,'ask');return jobs.submit({ownerId:capture.ownerId,deviceId:fresh.id,workspaceId:body.workspace_id,requestId:key,question:body.question,createdAtClient:body.created_at_client});});
  }
  function feed(device,{cursor,limit='20'}={}) {
    requireValue(/^\d{1,2}$/.test(String(limit))&&Number(limit)>0&&Number(limit)<=50,422,'INVALID_PAGINATION','每页1至50项');const spaces=capture.identity(device).allowed_workspaces.map(w=>w.id);if(!spaces.length)return{schema_version:'1',items:[],next_cursor:null};
    const scope=createHash('sha256').update(JSON.stringify({owner:capture.ownerId,device:device.id,spaces:[...spaces].sort()})).digest('hex');let after;
    if(cursor){try{requireValue(cursor.length<=500,422,'INVALID_CURSOR','分页游标无效');after=parse(Buffer.from(cursor,'base64url').toString());}catch{throw new APIError(422,'INVALID_CURSOR','分页游标无效');}requireValue(after&&after.scope===scope&&typeof after.at==='string'&&typeof after.id==='string',422,'INVALID_CURSOR','分页游标与身份或空间不一致');}
    const marks=spaces.map(()=>'?').join(','),condition=after?' AND (accepted_at<? OR (accepted_at=? AND id<?))':'';
    const rows=db.prepare(`SELECT * FROM (SELECT id,'capture' type,workspace_id,text title,'saved' status,index_status,accepted_at FROM captures WHERE owner_id=? AND workspace_id IN(${marks}) UNION ALL SELECT id,'ask' type,workspace_id,question title,status,NULL index_status,accepted_at FROM research_jobs WHERE owner_id=? AND workspace_id IN(${marks})) WHERE 1=1${condition} ORDER BY accepted_at DESC,id DESC LIMIT ?`).all(capture.ownerId,...spaces,capture.ownerId,...spaces,...(after?[after.at,after.at,after.id]:[]),Number(limit)+1);
    const items=rows.slice(0,Number(limit)).map(r=>({...r,title:[...r.title.trim()].slice(0,40).join('')})),last=items.at(-1);return{schema_version:'1',items,next_cursor:rows.length>Number(limit)?Buffer.from(JSON.stringify({scope,at:last.accepted_at,id:last.id})).toString('base64url'):null};
  }
  return {owner,submitAsk,feed,deviceStatus(device,id){deviceJob(device,id);const s=jobs.status(id);return {...s,error:s.failure_code?{code:s.failure_code,message:'请在网页查看失败与重做说明',retryable:false}:null,brief_ready:s.status==='completed'&&s.result_revision>0};},deviceBrief(device,id){deviceJob(device,id);const b=jobs.brief(id);if(!b.watch_brief)return reply({schema_version:'1',status:'not_ready',job_id:id,poll_after_seconds:5},202);return reply(b);}};
}
