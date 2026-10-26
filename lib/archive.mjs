import {randomUUID} from 'node:crypto';
import {APIError,requireValue} from './auth/capture-service.mjs';
import {canonicalJSON,sha256} from './store/sqlite.mjs';
import {enrichResult} from './llm/structured.mjs';
import {ThinkFlowWriteback,WritebackError} from './thinkflow-writeback.mjs';

const iso=value=>new Date(value).toISOString(),parse=JSON.parse,json=JSON.stringify;
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}\[\]()#+.!|:~-])/g,'\\$1');
const lines=value=>escape(value).replace(/\r\n/g,'\n');
const code=error=>error instanceof WritebackError?error.code:'THINKFLOW_UNAVAILABLE';

/** Deterministic plain Markdown: every model/user field is escaped, source quotes come from frozen evidence. */
export function resultMarkdown(job,result) {
  const out=[`# ${lines(result.watch_brief.headline)}`,'',`问题：${lines(job.question)}`,'',`任务：${escape(job.job_id)} · 修订：${job.result_revision}`,''];
  for(const bullet of result.watch_brief.bullets) out.push(`- ${lines(bullet.text)} ${bullet.citation_ids.map(id=>`[${id}]`).join(' ')}`);
  for(const section of result.sections) {
    out.push('',`## ${lines(section.heading)}`,'');
    for(const statement of section.statements) out.push(`- ${({fact:'资料事实',inference:'依据资料的推论',suggestion:'建议'})[statement.kind]}：${lines(statement.text)} ${statement.citation_ids.map(id=>`[${id}]`).join(' ')}`);
  }
  if(result.limitations.length) { out.push('','## 限制与待核对','');for(const limit of result.limitations) out.push(`- ${lines(limit)}`); }
  out.push('','## 原始证据','');
  for(const citation of result.citations) {
    out.push(`### ${citation.id} · ${lines(citation.title)}`,'',`来源：${escape(citation.source_id)}；快照：${escape(citation.source_version_id)}`,
      `正文 SHA-256：${citation.sha256}；Unicode 位置：[${citation.start}, ${citation.end})；读取时间：${escape(citation.read_at)}`,'',
      ...lines(citation.quote).split('\n').map(line=>`> ${line}`),'');
  }
  return out.join('\n').trimEnd()+'\n';
}

export class ResearchArchive {
  constructor(store,{jobs,knowledge,thinkflowClient,clock=()=>Date.now(),fetchImpl=fetch,autoStart=false}={}) {
    this.store=store;this.db=store.db;this.jobs=jobs;this.knowledge=knowledge;this.thinkflowClient=typeof thinkflowClient==='function'?thinkflowClient:()=>thinkflowClient;
    this.clock=clock;this.fetchImpl=fetchImpl;this.workerId=`archive_worker_${randomUUID()}`;this.controllers=new Map();this.timer=null;this.running=null;
    const schema=this.db.prepare("SELECT value FROM app_meta WHERE key='research_archive_schema_version'").get()?.value;
    if(schema && schema!=='1') throw new Error('Unsupported research archive schema; explicit migration required');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_archives(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,result_revision INTEGER NOT NULL,
        content_json TEXT NOT NULL,content_hash TEXT NOT NULL,markdown TEXT NOT NULL,markdown_hash TEXT NOT NULL,confirmed_at TEXT NOT NULL,UNIQUE(job_id,result_revision));
      CREATE TABLE IF NOT EXISTS research_writeback_intents(id TEXT PRIMARY KEY,archive_id TEXT NOT NULL UNIQUE REFERENCES research_archives(id),job_id TEXT NOT NULL,result_revision INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,target_json TEXT NOT NULL,status TEXT NOT NULL,confirmed_at TEXT NOT NULL,updated_at TEXT NOT NULL,request_sent_at TEXT,response_document_id TEXT,
        verified_document_id TEXT,verified_at TEXT,lease_owner TEXT,lease_version INTEGER NOT NULL DEFAULT 0,lease_expires_at TEXT,next_retry_at TEXT,error_code TEXT);
      CREATE INDEX IF NOT EXISTS research_writeback_queue ON research_writeback_intents(status,next_retry_at,confirmed_at,id);
    `);
    this.db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('research_archive_schema_version','1')").run();
    if(autoStart) this.start();
  }
  now() { return iso(this.clock()); }
  row(id) { return this.db.prepare('SELECT * FROM research_writeback_intents WHERE id=?').get(id); }
  receipt(archive) {
    const intent=this.db.prepare('SELECT * FROM research_writeback_intents WHERE archive_id=?').get(archive.id);
    return {archive_id:archive.id,intent_id:intent?.id || null,status:'archived',writeback_status:intent?.status || 'not_requested'};
  }
  getForJob(id) {
    return {archives:this.db.prepare('SELECT * FROM research_archives WHERE job_id=? ORDER BY result_revision').all(id).map(({content_json,...archive})=> {
      const intent=this.db.prepare('SELECT * FROM research_writeback_intents WHERE archive_id=?').get(archive.id);
      return {...this.receipt(archive),job_id:id,result_revision:archive.result_revision,content_hash:archive.content_hash,content:parse(content_json),markdown:archive.markdown,
        markdown_hash:archive.markdown_hash,confirmed_at:archive.confirmed_at,writeback:intent?this.intentView(intent):null};
    })};
  }
  intentView(row) {
    return {intent_id:row.id,archive_id:row.archive_id,job_id:row.job_id,result_revision:row.result_revision,status:row.status,target:parse(row.target_json),
      confirmed_at:row.confirmed_at,updated_at:row.updated_at,request_sent_at:row.request_sent_at,document_id:row.verified_document_id || row.response_document_id,
      verified_at:row.verified_at,error_code:row.error_code,next_retry_at:row.next_retry_at};
  }
  confirm(jobId,{result_revision:revision,expected_content_hash:expected,write_to_thinkflow:write=false}={}) {
    requireValue(Number.isInteger(revision) && revision>0 && /^[a-f0-9]{64}$/.test(expected || '') && typeof write==='boolean',422,'INVALID_CONFIRMATION','请提供核对过的结果修订、hash与写回选择');
    return this.store.transaction(()=> {
      const job=this.jobs.get(jobId),record=job.results.find(r=>r.result_revision===revision);
      requireValue(job.status==='completed' && record && record.content_hash===expected,409,'REVISION_CONFLICT','结果修订或内容已变化，请重新核对');
      let archive=this.db.prepare('SELECT * FROM research_archives WHERE job_id=? AND result_revision=?').get(jobId,revision);
      if(archive) {
        requireValue(archive.content_hash===expected,409,'REVISION_CONFLICT','已确认版本与本次内容不一致');
        if(!write || this.db.prepare('SELECT id FROM research_writeback_intents WHERE archive_id=?').get(archive.id)) return this.receipt(archive);
      } else {
        requireValue(job.current_revision===revision,409,'REVISION_CONFLICT','已有新修订，请刷新后核对');
        requireValue(this.knowledge.validateEvidence(job.workspace_id,job.corpus_revision_id,job.evidence),422,'INVALID_EVIDENCE','原始证据不可核对，不能确认');
        let content;try {const {citations,...base}=record.result;content=enrichResult(base,job.evidence);requireValue(canonicalJSON(content)===canonicalJSON(record.result),422,'INVALID_RESULT','引用元数据与快照不符');}
        catch(error) {if(error instanceof APIError) throw error;throw new APIError(422,'INVALID_RESULT','结果结构或引用未通过核对');}
        requireValue(sha256(canonicalJSON(content))===record.content_hash,409,'REVISION_CONFLICT','结果内容hash未通过核对');
        const markdown=resultMarkdown({...job,result_revision:revision},content);
        archive={id:`archive_${randomUUID()}`,job_id:jobId,owner_id:job.owner_id,workspace_id:job.workspace_id,result_revision:revision,content_json:json(content),content_hash:record.content_hash,
          markdown,markdown_hash:sha256(markdown),confirmed_at:this.now()};
        this.db.prepare('INSERT INTO research_archives VALUES(?,?,?,?,?,?,?,?,?,?)').run(...['id','job_id','owner_id','workspace_id','result_revision','content_json','content_hash','markdown','markdown_hash','confirmed_at'].map(k=>archive[k]));
      }
      if(write) {
        const binding=this.knowledge.report(job.workspace_id).thinkflow;
        requireValue(binding,409,'THINKFLOW_NOT_BOUND','请先绑定并核对空间的 ThinkFlow 笔记本');
        const adapter=new ThinkFlowWriteback(this.thinkflowClient(),{fetchImpl:this.fetchImpl});
        requireValue(adapter.matches(binding),409,'THINKFLOW_TARGET_CHANGED','当前 ThinkFlow 服务或用户与绑定不一致');
        const at=this.now();
        this.db.prepare('INSERT INTO research_writeback_intents(id,archive_id,job_id,result_revision,workspace_id,target_json,status,confirmed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(`intent_${randomUUID()}`,archive.id,jobId,revision,job.workspace_id,json({base_url:binding.base_url,user_id:binding.user_id,notebook_id:binding.notebook_id}),'queued',at,at);
      }
      return this.receipt(archive);
    });
  }

  recoverExpired() {
    this.db.prepare("UPDATE research_writeback_intents SET status=CASE WHEN request_sent_at IS NULL THEN 'queued' ELSE 'reconciliation_required' END,error_code=CASE WHEN request_sent_at IS NULL THEN NULL ELSE 'WRITEBACK_RESULT_UNKNOWN' END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=?")
      .run(this.now(),this.now());
  }
  claim(id=null) {
    return this.store.transaction(()=> {
      this.recoverExpired();
      const row=id?this.row(id):this.db.prepare("SELECT * FROM research_writeback_intents WHERE status='queued' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY confirmed_at,id LIMIT 1").get(this.now());
      if(!row) {if(id) throw new APIError(404,'WRITEBACK_NOT_FOUND','写回意图不存在');return null;}
      requireValue(row.status!=='running',409,'WRITEBACK_BUSY','写回核对正在进行，请稍后再试');
      this.db.prepare("UPDATE research_writeback_intents SET status='running',lease_owner=?,lease_version=lease_version+1,lease_expires_at=?,updated_at=? WHERE id=?")
        .run(this.workerId,iso(this.clock()+60000),this.now(),row.id);
      return this.row(row.id);
    });
  }
  fenced(row) {const current=this.row(row.id);return current?.status==='running' && current.lease_owner===this.workerId && current.lease_version===row.lease_version && current.lease_expires_at>this.now();}
  heartbeat(row) {
    return this.store.transaction(()=>this.db.prepare("UPDATE research_writeback_intents SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_version=? AND lease_expires_at>?")
      .run(iso(this.clock()+60000),row.id,this.workerId,row.lease_version,this.now()).changes===1);
  }
  finish(row,status,errorCode=null,{documentId=null,nextRetryAt=null}={}) {
    return this.store.transaction(()=> {
      if(!this.fenced(row)) return false;
      this.db.prepare('UPDATE research_writeback_intents SET status=?,error_code=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL,next_retry_at=?,verified_document_id=CASE WHEN ? IS NOT NULL THEN ? ELSE verified_document_id END,verified_at=CASE WHEN ?=\'verified\' THEN ? ELSE verified_at END WHERE id=?')
        .run(status,errorCode,this.now(),nextRetryAt,documentId,documentId,status,this.now(),row.id);return true;
    });
  }
  async execute(row,{manual=false}={}) {
    const controller=new AbortController();this.controllers.set(row.id,controller);
    const timer=setInterval(()=>{try {if(!this.heartbeat(row)) controller.abort();} catch {controller.abort();}},10000);timer.unref();
    try {
      const archive=this.db.prepare('SELECT * FROM research_archives WHERE id=?').get(row.archive_id);if(!archive || !this.fenced(row)) return;
      if(sha256(archive.markdown)!==archive.markdown_hash || sha256(canonicalJSON(parse(archive.content_json)))!==archive.content_hash) {this.finish(row,'conflict','ARCHIVE_CONTENT_CHANGED');return;}
      const target=parse(row.target_json),adapter=new ThinkFlowWriteback(this.thinkflowClient(),{fetchImpl:this.fetchImpl});
      if(!adapter.matches(target)) {this.finish(row,'needs_attention','THINKFLOW_TARGET_CHANGED');return;}
      let listing=await adapter.documents(target,{signal:controller.signal});if(!this.fenced(row)) return;
      let matches=listing.documents.filter(d=>d.metadata?.personal_agent_writeback_intent_id===row.id);
      if(matches.length>1) {this.finish(row,'conflict','MULTIPLE_WRITEBACK_DOCUMENTS');return;}
      if(!matches.length) {
        if(this.row(row.id).request_sent_at) {this.finish(row,'needs_attention','WRITEBACK_NOT_FOUND_AFTER_DISPATCH');return;}
        if(manual) {this.finish(row,'queued');return;}
        const content=parse(archive.content_json);
        const metadata={personal_agent_writeback_intent_id:row.id,personal_agent_job_id:row.job_id,personal_agent_task_id:row.job_id,result_revision:row.result_revision,
          content_sha256:archive.markdown_hash,result_content_sha256:archive.content_hash,confirmed_at:row.confirmed_at,workspace_id:row.workspace_id,
          source_refs:content.citations.map(c=>({...c})),integration_marker:`personal-agent-intent:${row.id}`};
        const marked=this.store.transaction(()=> {
          if(!this.fenced(row)) return false;
          this.db.prepare('UPDATE research_writeback_intents SET request_sent_at=?,updated_at=? WHERE id=?').run(this.now(),this.now(),row.id);return true;
        });if(!marked) return;
        const document=await adapter.create(target,listing.notebook,{title:content.watch_brief.headline,content:archive.markdown,metadata},{signal:controller.signal});
        if(!this.fenced(row)) return;
        this.store.transaction(()=> {if(this.fenced(row)) this.db.prepare('UPDATE research_writeback_intents SET response_document_id=?,updated_at=? WHERE id=?').run(document.id,this.now(),row.id);});
        listing=await adapter.documents(target,{signal:controller.signal});if(!this.fenced(row)) return;
        matches=listing.documents.filter(d=>d.metadata?.personal_agent_writeback_intent_id===row.id);
        if(matches.length!==1) {this.finish(row,matches.length>1?'conflict':'reconciliation_required',matches.length>1?'MULTIPLE_WRITEBACK_DOCUMENTS':'WRITEBACK_NOT_VISIBLE');return;}
      }
      const document=matches[0];
      if(document.metadata.content_sha256!==archive.markdown_hash || document.metadata.result_content_sha256!==archive.content_hash || document.metadata.result_revision!==row.result_revision ||
        document.metadata.personal_agent_job_id!==row.job_id || document.metadata.workspace_id!==row.workspace_id) {this.finish(row,'conflict','WRITEBACK_METADATA_CONFLICT');return;}
      const actual=await adapter.read(target,listing.notebook,document.id,{signal:controller.signal});if(!this.fenced(row)) return;
      if(actual.content!==archive.markdown || sha256(actual.content)!==archive.markdown_hash || actual.metadata?.personal_agent_writeback_intent_id!==row.id ||
        actual.metadata?.content_sha256!==archive.markdown_hash || actual.metadata?.result_content_sha256!==archive.content_hash ||
        actual.metadata?.result_revision!==row.result_revision || actual.metadata?.personal_agent_job_id!==row.job_id || actual.metadata?.workspace_id!==row.workspace_id ||
        actual.notebook_id!==undefined && actual.notebook_id!==target.notebook_id) {this.finish(row,'conflict','WRITEBACK_CONTENT_CONFLICT');return;}
      this.finish(row,'verified',null,{documentId:document.id});
    } catch(error) {
      if(this.fenced(row)) {
        const sent=this.row(row.id).request_sent_at;
        this.finish(row,sent?'reconciliation_required':'queued',code(error),{nextRetryAt:sent?null:iso(this.clock()+30000)});
      }
    } finally {clearInterval(timer);this.controllers.delete(row.id);}
  }
  async drainOnce() {
    if(this.running) return {claimed:false};const row=this.claim();if(!row) return {claimed:false};
    const operation=this.execute(row);this.running=operation;try {await operation;return {claimed:true,intent_id:row.id,status:this.row(row.id)?.status};}
    finally {if(this.running===operation) this.running=null;}
  }
  async reconcile(id) {
    requireValue(!this.running,409,'WRITEBACK_BUSY','写回核对正在进行，请稍后再试');const row=this.claim(id);
    const operation=this.execute(row,{manual:true});this.running=operation;try {await operation;const current=this.row(id);requireValue(current,404,'WRITEBACK_NOT_FOUND','写回意图已删除');return this.intentView(current);}
    finally {if(this.running===operation) this.running=null;}
  }
  start() {if(this.timer) return;this.timer=setInterval(()=>{this.drainOnce().catch(()=>{});},1000);this.timer.unref();queueMicrotask(()=>{if(this.timer) this.drainOnce().catch(()=>{});});}
  async stop() {if(this.timer) clearInterval(this.timer);this.timer=null;for(const controller of this.controllers.values()) controller.abort();if(this.running) await this.running.catch(()=>{});}
  removeForJob(jobId) {
    const ids=this.db.prepare('SELECT id FROM research_writeback_intents WHERE job_id=?').all(jobId).map(r=>r.id);
    this.store.transaction(()=>{this.db.prepare('DELETE FROM research_writeback_intents WHERE job_id=?').run(jobId);this.db.prepare('DELETE FROM research_archives WHERE job_id=?').run(jobId);});
    for(const id of ids) this.controllers.get(id)?.abort();return {job_id:jobId,status:'deleted',remote_documents_deleted:false};
  }
}
