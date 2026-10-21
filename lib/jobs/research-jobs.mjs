import {randomUUID} from 'node:crypto';
import {APIError,requireValue,UUID} from '../auth/capture-service.mjs';
import {canonicalJSON,sha256} from '../store/sqlite.mjs';
import {PROMPT_VERSION,GenerationError,freezeModelConfig,configured,validateEvidence,validateResult,enrichResult,insufficientResult,buildGeneration,generate} from '../llm/structured.mjs';

const iso=v=>new Date(v).toISOString();
const parse=JSON.parse,json=JSON.stringify;
const terminal=new Set(['completed','failed','cancelled','needs_attention']);
const safeCode=e=>e instanceof GenerationError || ['WORKSPACE_NOT_AVAILABLE','CORPUS_NOT_AVAILABLE'].includes(e?.code)?e.code:'EXECUTION_FAILED';
const cleanModel=config=>freezeModelConfig(config || {});
const jobId=()=>`job_${randomUUID()}`;
const validTime=v=>typeof v==='string' && v.length<=40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));

/** Durable, independent Ask worker. All SQLite transactions are short and synchronous. */
export class ResearchJobs {
  constructor(store,{knowledge,clock=()=>Date.now(),modelConfig=()=>({}),resolveKey=()=>'',fetchImpl=fetch,autoStart=true}={}) {
    this.store=store;this.db=store.db;this.knowledge=knowledge;this.clock=clock;this.modelConfig=typeof modelConfig==='function'?modelConfig:()=>modelConfig;
    this.resolveKey=resolveKey;this.fetchImpl=fetchImpl;this.workerId=`worker_${randomUUID()}`;this.controllers=new Map();this.running=null;this.timer=null;this.stopped=true;
    const version=this.db.prepare("SELECT value FROM app_meta WHERE key='research_jobs_schema_version'").get()?.value;
    if(version && version!=='1') throw new Error('Unsupported research jobs schema; explicit migration required');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_records(owner_id TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,body_hash TEXT NOT NULL,resource_id TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,operation,request_id));
      CREATE TABLE IF NOT EXISTS research_jobs(
        id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,device_id TEXT NOT NULL,workspace_id TEXT NOT NULL,question TEXT NOT NULL,created_at_client TEXT NOT NULL,
        accepted_at TEXT NOT NULL,updated_at TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,corpus_revision_id TEXT,model_config_json TEXT NOT NULL,
        prompt_version TEXT NOT NULL,calls_used INTEGER NOT NULL DEFAULT 0,max_calls INTEGER NOT NULL,lease_owner TEXT,lease_version INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,next_run_at TEXT,failure_code TEXT,retry_of TEXT,current_revision INTEGER NOT NULL DEFAULT 0,evidence_frozen INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS research_queue ON research_jobs(status,next_run_at,accepted_at,id);
      CREATE INDEX IF NOT EXISTS research_feed ON research_jobs(workspace_id,accepted_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS research_job_attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES research_jobs(id),ordinal INTEGER NOT NULL,lease_version INTEGER NOT NULL,
        provider TEXT NOT NULL,model TEXT NOT NULL,config_version TEXT NOT NULL,prompt_version TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,
        request_sent INTEGER NOT NULL DEFAULT 0,response_received INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,input_token_upper_bound INTEGER NOT NULL,
        usage_json TEXT,error_code TEXT,UNIQUE(job_id,ordinal));
      CREATE TABLE IF NOT EXISTS research_job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES research_jobs(id),at TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_job_evidence(job_id TEXT NOT NULL REFERENCES research_jobs(id),evidence_id TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(job_id,evidence_id));
      CREATE TABLE IF NOT EXISTS research_results(job_id TEXT NOT NULL REFERENCES research_jobs(id),result_revision INTEGER NOT NULL,content_json TEXT NOT NULL,content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,editor TEXT NOT NULL,PRIMARY KEY(job_id,result_revision));
    `);
    this.db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('research_jobs_schema_version','1')").run();
    if(autoStart) this.start();
  }

  now() { return iso(this.clock()); }
  config() { return cleanModel(this.modelConfig()); }
  row(id) { return this.db.prepare('SELECT * FROM research_jobs WHERE id=?').get(id); }
  event(id,type,message=type) { this.db.prepare('INSERT INTO research_job_events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,this.now(),type,message); }
  evidence(id) { return this.db.prepare('SELECT evidence_json FROM research_job_evidence WHERE job_id=? ORDER BY rowid').all(id).map(r=>parse(r.evidence_json)); }

  submit({ownerId,deviceId,workspaceId,requestId,question,createdAtClient,retryOf=null}={}) {
    requireValue(typeof ownerId==='string' && ownerId && typeof deviceId==='string' && deviceId && typeof workspaceId==='string' && workspaceId.length<=200 && workspaceId &&
      UUID.test(requestId || '') && typeof question==='string' && question.isWellFormed() && question.trim() && [...question].length<=1000 && validTime(createdAtClient) &&
      (retryOf===null || typeof retryOf==='string' && retryOf.length<=100),422,'INVALID_ASK','问题、空间、请求编号或客户端时间格式不正确');
    const bodyHash=sha256(canonicalJSON({workspace_id:workspaceId,question,created_at_client:createdAtClient,retry_of:retryOf}));
    return this.store.transaction(()=> {
      const prior=this.db.prepare("SELECT * FROM idempotency_records WHERE owner_id=? AND operation='ask' AND request_id=?").get(ownerId,requestId.toLowerCase());
      if(prior) {
        requireValue(prior.body_hash===bodyHash,409,'IDEMPOTENCY_CONFLICT','相同请求编号对应不同问题');
        requireValue(!prior.tombstone,409,'RESOURCE_DELETED','此前问题已被删除，不会重新创建');
        const existing=this.row(prior.resource_id);requireValue(existing,409,'RESOURCE_UNAVAILABLE','此前问题暂不可用，不会重复创建');
        return {replayed:true,response:this.accepted(existing)};
      }
      const config=this.config();
      requireValue(configured(config),503,'MODEL_NOT_CONFIGURED','请先配置云端生成模型；Capture仍可正常保存');
      requireValue(this.knowledge?.currentRevision && this.knowledge?.evidence && this.knowledge?.validateEvidence,503,'RETRIEVAL_NOT_CONFIGURED','资料检索尚未配置');
      if(retryOf) requireValue(this.db.prepare('SELECT id FROM research_jobs WHERE id=? AND owner_id=? AND workspace_id=?').get(retryOf,ownerId,workspaceId),422,'INVALID_RETRY_OF','重做问题不属于当前空间');
      const day=`${this.now().slice(0,10)}T00:00:00.000Z`;
      if(this.db.prepare('SELECT count(*) n FROM research_jobs WHERE owner_id=? AND accepted_at>=?').get(ownerId,day).n>=config.dailyLimit) {
        const error=new APIError(429,'DAILY_ASK_LIMIT','已达到每日问题上限，请稍后再试',true);error.retryAfter=Math.max(1,Math.ceil((Date.parse(day)+86400000-this.clock())/1000));throw error;
      }
      if(this.db.prepare("SELECT count(*) n FROM research_jobs WHERE owner_id=? AND status IN ('queued','running','waiting_retry')").get(ownerId).n>=config.queueLimit) {
        const error=new APIError(429,'ASK_QUEUE_FULL','待处理问题已满，请等待现有任务完成',true);error.retryAfter=5;throw error;
      }
      const id=jobId(),at=this.now(),corpus=this.knowledge.currentRevision(workspaceId);
      this.db.prepare(`INSERT INTO research_jobs(id,owner_id,device_id,workspace_id,question,created_at_client,accepted_at,updated_at,status,stage,corpus_revision_id,model_config_json,prompt_version,max_calls,retry_of)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerId,deviceId,workspaceId,question,createdAtClient,at,at,'queued','queued',corpus || null,json(config),PROMPT_VERSION,config.maxCalls,retryOf);
      this.db.prepare('INSERT INTO idempotency_records VALUES(?,?,?,?,?,0)').run(ownerId,'ask',requestId.toLowerCase(),bodyHash,id);
      this.event(id,'accepted');return {replayed:false,response:this.accepted(this.row(id))};
    });
  }

  accepted(row) { return {schema_version:'1',job_id:row.id,status:row.status,workspace_id:row.workspace_id,corpus_revision_id:row.corpus_revision_id,accepted_at:row.accepted_at,poll_after_seconds:5}; }
  required(id) { const row=this.row(id);requireValue(row,404,'JOB_NOT_FOUND','问题不存在');return row; }
  get(id) {
    const row=this.required(id),results=this.db.prepare('SELECT * FROM research_results WHERE job_id=? ORDER BY result_revision').all(id).map(({content_json,job_id,...r})=>({...r,result:parse(content_json)}));
    return {schema_version:'1',job_id:row.id,owner_id:row.owner_id,device_id:row.device_id,workspace_id:row.workspace_id,question:row.question,created_at_client:row.created_at_client,
      status:row.status,stage:row.stage,corpus_revision_id:row.corpus_revision_id,model_config:parse(row.model_config_json),prompt_version:row.prompt_version,
      accepted_at:row.accepted_at,updated_at:row.updated_at,next_retry_at:row.next_run_at,failure_code:row.failure_code,retry_of:row.retry_of,
      calls_used:row.calls_used,max_calls:row.max_calls,current_revision:row.current_revision,
      events:this.db.prepare('SELECT seq,at,type,message FROM research_job_events WHERE job_id=? ORDER BY seq').all(id),
      attempts:this.db.prepare('SELECT * FROM research_job_attempts WHERE job_id=? ORDER BY ordinal').all(id).map(({usage_json,...a})=>({...a,usage:usage_json?parse(usage_json):'unknown'})),
      evidence:this.evidence(id),results};
  }
  status(id) {
    const row=this.required(id);return {...this.accepted(row),stage:row.stage,updated_at:row.updated_at,result_revision:row.current_revision || null,
      next_retry_at:row.next_run_at,failure_code:row.failure_code};
  }
  brief(id) {
    const row=this.required(id),record=this.db.prepare('SELECT * FROM research_results WHERE job_id=? AND result_revision=?').get(id,row.current_revision);
    const result=record?parse(record.content_json):null;
    return {schema_version:'1',job_id:id,workspace_id:row.workspace_id,status:row.status,result_revision:row.current_revision || null,updated_at:row.updated_at,
      answer_status:result?.answer_status || null,watch_brief:result?.watch_brief || null,source_count:result?new Set(result.citations.map(c=>c.source_id)).size:0,
      citations:result?.citations.map(({quote,...c})=>c) || [],failure_code:row.failure_code,poll_after_seconds:5};
  }
  list({workspaceIds=[],cursor,limit=20}={}) {
    requireValue(Array.isArray(workspaceIds) && workspaceIds.length<=100 && workspaceIds.every(v=>typeof v==='string'),422,'INVALID_SCOPE','空间范围无效');
    requireValue(Number.isInteger(Number(limit)) && Number(limit)>=1 && Number(limit)<=50,422,'INVALID_PAGINATION','每页应为1至50项');
    if(!workspaceIds.length) return {schema_version:'1',items:[],next_cursor:null};
    const scope=sha256(canonicalJSON([...new Set(workspaceIds)].sort()));let after;
    if(cursor) {
      try { requireValue(typeof cursor==='string' && cursor.length<=500,422,'INVALID_CURSOR','分页游标无效');after=parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch { throw new APIError(422,'INVALID_CURSOR','分页游标无效'); }
      requireValue(after && after.scope===scope && typeof after.at==='string' && typeof after.id==='string',422,'INVALID_CURSOR','分页游标与当前空间不一致');
    }
    const rows=this.db.prepare(`SELECT * FROM research_jobs WHERE workspace_id IN(${workspaceIds.map(()=>'?').join(',')})${after?' AND (accepted_at<? OR (accepted_at=? AND id<?))':''} ORDER BY accepted_at DESC,id DESC LIMIT ?`)
      .all(...workspaceIds,...(after?[after.at,after.at,after.id]:[]),Number(limit)+1);
    const page=rows.slice(0,Number(limit)),last=page.at(-1);
    return {schema_version:'1',items:page.map(r=>({...this.status(r.id),id:r.id,type:'ask',title:[...r.question].slice(0,40).join('')})),
      next_cursor:rows.length>Number(limit)?Buffer.from(json({scope,at:last.accepted_at,id:last.id})).toString('base64url'):null};
  }

  cancel(id) {
    this.store.transaction(()=> {
      const row=this.required(id);if(['cancelled','completed','failed'].includes(row.status)) return;
      this.db.prepare("UPDATE research_jobs SET status='cancelled',stage='cancelled',updated_at=?,lease_owner=NULL,lease_expires_at=NULL,next_run_at=NULL WHERE id=?").run(this.now(),id);
      this.event(id,'cancelled','已取消；已经发出的请求可能仍产生用量');
    });
    this.controllers.get(id)?.abort();return this.status(id);
  }

  edit(id,{result_revision:revision,expected_content_hash:expected,result}={}) {
    requireValue(Number.isInteger(revision) && revision>0 && /^[a-f0-9]{64}$/.test(expected || ''),422,'INVALID_REVISION','需要当前修订编号与内容hash');
    const evidence=this.evidence(id);
    let enriched;
    try {
      const {citations,...content}=result || {};enriched=enrichResult(content,evidence);
      if(citations!==undefined) requireValue(canonicalJSON(citations)===canonicalJSON(enriched.citations),422,'INVALID_CITATION_METADATA','引用元数据必须与服务器快照一致');
    } catch(error) { if(error instanceof APIError) throw error;throw new APIError(422,'INVALID_RESULT','结果结构、长度或引用未通过验证'); }
    return this.store.transaction(()=> {
      const row=this.required(id),previous=this.db.prepare('SELECT * FROM research_results WHERE job_id=? AND result_revision=?').get(id,revision);
      requireValue(row.status==='completed' && previous && row.current_revision===revision && previous.content_hash===expected,409,'REVISION_CONFLICT','结果已变化，请刷新后重新编辑');
      requireValue(this.knowledge.validateEvidence(row.workspace_id,row.corpus_revision_id,evidence),422,'INVALID_EVIDENCE','历史证据快照不可核对');
      this.putResult(row,enriched,'owner');this.event(id,'edited');return this.get(id);
    });
  }

  putResult(row,result,editor) {
    const revision=row.current_revision+1,at=this.now(),hash=sha256(canonicalJSON(result));
    this.db.prepare('INSERT INTO research_results VALUES(?,?,?,?,?,?)').run(row.id,revision,json(result),hash,at,editor);
    this.db.prepare('UPDATE research_jobs SET current_revision=?,updated_at=? WHERE id=?').run(revision,at,row.id);
    return revision;
  }

  readiness() {
    let config;try { config=this.config(); } catch { return {ready:false,code:'INVALID_MODEL_CONFIG',capture_independent:true}; }
    return {ready:configured(config) && Boolean(this.knowledge?.validateEvidence),code:!configured(config)?'MODEL_NOT_CONFIGURED':this.knowledge?.validateEvidence?'READY':'RETRIEVAL_NOT_CONFIGURED',
      worker_running:!this.stopped,model:config.model,config_version:config.version,capture_independent:true};
  }
  usage({ownerId}={}) {
    const rows=this.db.prepare(`SELECT a.usage_json,a.request_sent,a.status FROM research_job_attempts a JOIN research_jobs j ON a.job_id=j.id${ownerId?' WHERE j.owner_id=?':''}`).all(...(ownerId?[ownerId]:[]));
    const sent=rows.filter(r=>r.request_sent),known=sent.filter(r=>r.usage_json).map(r=>parse(r.usage_json)),unknown=sent.length-known.length;
    const total=field=>known.every(v=>Number.isSafeInteger(v[field])) && known.length?known.reduce((n,v)=>n+v[field],0):null;
    return {calls:sent.length,known_usage_calls:known.length,unknown_usage_calls:unknown,usage_status:unknown?'unknown':known.length?'known':'unknown',
      measured_usage:{prompt_tokens:total('prompt_tokens'),completion_tokens:total('completion_tokens'),total_tokens:total('total_tokens')}};
  }

  start() {
    if(this.timer) return;this.stopped=false;
    this.timer=setInterval(()=>{this.runOnce().catch(()=>{});},1000);this.timer.unref();
    queueMicrotask(()=>{if(!this.stopped) this.runOnce().catch(()=>{});});
  }
  async stop() {
    this.stopped=true;if(this.timer) clearInterval(this.timer);this.timer=null;
    for(const controller of this.controllers.values()) controller.abort();
    if(this.running) await this.running.catch(()=>{});
  }

  recoverExpired() {
    const expired=this.db.prepare("SELECT * FROM research_jobs WHERE status='running' AND lease_expires_at<=?").all(this.now());
    for(const row of expired) {
      const attempt=this.db.prepare('SELECT * FROM research_job_attempts WHERE job_id=? ORDER BY ordinal DESC LIMIT 1').get(row.id);
      const unknown=attempt?.request_sent===1 && attempt.response_received===0;
      const status=unknown?'needs_attention':row.calls_used>=row.max_calls?'failed':'queued';
      this.db.prepare('UPDATE research_jobs SET status=?,stage=?,failure_code=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND status=\'running\' AND lease_version=?')
        .run(status,status,unknown?'MODEL_REQUEST_UNKNOWN':status==='failed'?'CALL_BUDGET_EXHAUSTED':null,this.now(),row.id,row.lease_version);
      if(unknown) this.db.prepare("UPDATE research_job_attempts SET status='unknown',error_code='MODEL_REQUEST_UNKNOWN' WHERE id=?").run(attempt.id);
      this.event(row.id,'recovered',unknown?'上次调用结果未知，可能已产生用量；不会自动重发':status);
    }
  }
  claim() {
    return this.store.transaction(()=> {
      this.recoverExpired();
      const row=this.db.prepare("SELECT * FROM research_jobs WHERE status='queued' OR (status='waiting_retry' AND next_run_at<=?) ORDER BY accepted_at,id LIMIT 1").get(this.now());
      if(!row) return null;
      this.db.prepare("UPDATE research_jobs SET status='running',stage='retrieving',lease_owner=?,lease_version=lease_version+1,lease_expires_at=?,next_run_at=NULL,updated_at=? WHERE id=?")
        .run(this.workerId,iso(this.clock()+60000),this.now(),row.id);
      this.event(row.id,'claimed');return this.row(row.id);
    });
  }
  fenced(row) { const current=this.row(row.id);return current?.status==='running' && current.lease_owner===this.workerId && current.lease_version===row.lease_version && current.lease_expires_at>this.now(); }
  heartbeat(row) {
    return this.store.transaction(()=>this.db.prepare("UPDATE research_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_version=? AND lease_expires_at>?")
      .run(iso(this.clock()+60000),this.now(),row.id,this.workerId,row.lease_version,this.now()).changes===1);
  }
  finish(row,status,code=null) {
    return this.store.transaction(()=> {
      if(!this.fenced(row)) return false;
      this.db.prepare('UPDATE research_jobs SET status=?,stage=?,failure_code=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?').run(status,status,code,this.now(),row.id);
      this.event(row.id,status,code || status);return true;
    });
  }

  async runOnce() {
    if(this.running) return {claimed:false};
    const row=this.claim();if(!row) return {claimed:false};
    const operation=this.execute(row);this.running=operation;
    try { await operation;return {claimed:true,job_id:row.id,status:this.row(row.id)?.status}; }
    finally { if(this.running===operation) this.running=null; }
  }

  async execute(row) {
    const controller=new AbortController();this.controllers.set(row.id,controller);
    const heartbeat=setInterval(()=>{try { if(!this.heartbeat(row)) controller.abort(); } catch { controller.abort(); }},10000);heartbeat.unref();
    try {
      const config=parse(row.model_config_json);
      if(!configured(config) || this.config().version!==config.version) throw new GenerationError('MODEL_CONFIG_CHANGED');
      if(row.prompt_version!==PROMPT_VERSION) throw new GenerationError('PROMPT_VERSION_UNAVAILABLE');
      let evidence=this.evidence(row.id);
      if(!row.evidence_frozen) {
        evidence=row.corpus_revision_id?await this.knowledge.evidence(row.workspace_id,row.corpus_revision_id,row.question):[];
        validateEvidence(evidence,row.workspace_id,row.corpus_revision_id);
        if(!await this.knowledge.validateEvidence(row.workspace_id,row.corpus_revision_id,evidence)) throw new GenerationError('INVALID_EVIDENCE');
        if(evidence.length) evidence=buildGeneration(row.question,evidence,config).evidence;
        this.store.transaction(()=> {
          if(!this.fenced(row)) return;
          const insert=this.db.prepare('INSERT INTO research_job_evidence VALUES(?,?,?)');for(const e of evidence) insert.run(row.id,e.id,json(e));
          this.db.prepare("UPDATE research_jobs SET evidence_frozen=1,stage='generating',updated_at=? WHERE id=?").run(this.now(),row.id);this.event(row.id,'retrieved',`${evidence.length} evidence blocks`);
        });
      }
      if(!this.fenced(row)) return;
      if(!evidence.length) { this.complete(row,enrichResult(insufficientResult(),[]));return; }
      validateEvidence(evidence,row.workspace_id,row.corpus_revision_id);
      if(!await this.knowledge.validateEvidence(row.workspace_id,row.corpus_revision_id,evidence)) throw new GenerationError('INVALID_EVIDENCE');
      const previous=this.db.prepare('SELECT error_code FROM research_job_attempts WHERE job_id=? ORDER BY ordinal DESC LIMIT 1').get(row.id);
      let repair=['INVALID_RESULT','MODEL_OUTPUT_INCOMPLETE'].includes(previous?.error_code);
      while(this.fenced(row)) {
        const prepared=buildGeneration(row.question,evidence,config,{repair,frozen:true});
        const key=await this.resolveKey(config);
        if(!this.fenced(row)) return;
        const attempt=this.store.transaction(()=> {
          if(!this.fenced(row)) return null;const fresh=this.row(row.id);
          if(fresh.calls_used>=fresh.max_calls) throw new GenerationError('CALL_BUDGET_EXHAUSTED');
          const a={id:`attempt_${randomUUID()}`,ordinal:fresh.calls_used+1};
          this.db.prepare(`INSERT INTO research_job_attempts(id,job_id,ordinal,lease_version,provider,model,config_version,prompt_version,started_at,status,input_token_upper_bound)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(a.id,row.id,a.ordinal,row.lease_version,config.provider,config.model,config.version,row.prompt_version,this.now(),'reserved',prepared.inputTokenUpperBound);
          this.db.prepare("UPDATE research_jobs SET calls_used=calls_used+1,stage='generating',updated_at=? WHERE id=?").run(this.now(),row.id);
          this.event(row.id,'generating',`attempt ${a.ordinal}`);return a;
        });
        if(!attempt) return;
        this.store.transaction(()=> {
          if(!this.fenced(row)) return;
          this.db.prepare("UPDATE research_job_attempts SET request_sent=1,status='sent' WHERE id=?").run(attempt.id);
        });
        if(!this.fenced(row)) return;
        let generated;
        try {
          generated=await generate({config,body:prepared.body,key,signal:controller.signal,fetchImpl:this.fetchImpl,clock:this.clock});
          this.recordResponse(attempt,'received',generated.usage);
          if(!this.fenced(row)) return;
          this.store.transaction(()=>{if(this.fenced(row)) {this.db.prepare("UPDATE research_jobs SET stage='validating',updated_at=? WHERE id=?").run(this.now(),row.id);this.event(row.id,'validating');}});
          const result=enrichResult(validateResult(generated.result,evidence),evidence);
          if(!await this.knowledge.validateEvidence(row.workspace_id,row.corpus_revision_id,evidence)) throw new GenerationError('INVALID_EVIDENCE');
          this.complete(row,result);return;
        } catch(error) {
          const code=safeCode(error),unknown=error instanceof GenerationError && error.unknown;
          this.recordResponse(attempt,unknown?'unknown':'rejected',error.usage ?? generated?.usage ?? null,code,!unknown);
          if(!this.fenced(row)) return;
          if(unknown) { this.finish(row,'needs_attention','MODEL_REQUEST_UNKNOWN');return; }
          if(error instanceof GenerationError && error.status===429) {
            this.store.transaction(()=> {
              if(!this.fenced(row)) return;
              if(this.row(row.id).calls_used>=row.max_calls) { this.finish(row,'failed','CALL_BUDGET_EXHAUSTED');return; }
              this.db.prepare("UPDATE research_jobs SET status='waiting_retry',stage='waiting_retry',next_run_at=?,failure_code='MODEL_RATE_LIMITED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
                .run(iso(error.retryAt || this.clock()+5000),this.now(),row.id);this.event(row.id,'waiting_retry','MODEL_RATE_LIMITED');
            });return;
          }
          if(['INVALID_RESULT','MODEL_OUTPUT_INCOMPLETE'].includes(code) && this.row(row.id).calls_used<row.max_calls) { repair=true;continue; }
          this.finish(row,'failed',code);return;
        }
      }
    } catch(error) { this.finish(row,'failed',safeCode(error)); }
    finally { clearInterval(heartbeat);this.controllers.delete(row.id); }
  }
  recordResponse(attempt,status,usage,errorCode=null,responseReceived=true) {
    this.db.prepare('UPDATE research_job_attempts SET status=?,response_received=?,usage_json=?,error_code=?,finished_at=? WHERE id=?')
      .run(status,responseReceived?1:0,usage?json(usage):null,errorCode,this.now(),attempt.id);
  }
  complete(row,result) {
    return this.store.transaction(()=> {
      if(!this.fenced(row)) return false;
      this.putResult(this.row(row.id),result,'generated');
      this.db.prepare("UPDATE research_jobs SET status='completed',stage='completed',failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(this.now(),row.id);
      this.event(row.id,'completed');return true;
    });
  }
}
