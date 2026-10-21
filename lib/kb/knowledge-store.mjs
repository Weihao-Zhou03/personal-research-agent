import { randomUUID } from 'node:crypto';
import { INDEX_VERSION, hashText, codePoints, tokenize, queryTerms, literalMatch, substringTerms, chunkText } from './text.mjs';

const id = prefix => `${prefix}_${randomUUID()}`;
const iso = value => new Date(value).toISOString();
export class KnowledgeError extends Error {
  constructor(code, message, status = 422, retryable = false) { super(message); Object.assign(this, { code, status, retryable }); }
}
const need = (condition, code, message, status = 422) => { if (!condition) throw new KnowledgeError(code, message, status); };
const kinds = new Set(['import', 'note', 'thinkflow']);

/** The store receives already-authorized workspace IDs; every query still scopes before LIMIT. */
export class KnowledgeStore {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store; this.db = store.db; this.clock = clock;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,current_version_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,kind,external_id));
      CREATE TABLE IF NOT EXISTS source_versions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),title TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,sha256 TEXT NOT NULL,read_at TEXT NOT NULL,UNIQUE(source_id,sha256));
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,source_version_id TEXT NOT NULL REFERENCES source_versions(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),ordinal INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,text TEXT NOT NULL,sha256 TEXT NOT NULL,heading TEXT NOT NULL,tokens TEXT NOT NULL,index_version TEXT NOT NULL,UNIQUE(source_version_id,ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED,tokens,tokenize='unicode61 remove_diacritics 0');
      CREATE TABLE IF NOT EXISTS corpus_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),created_at TEXT NOT NULL,index_version TEXT NOT NULL,membership_hash TEXT NOT NULL,UNIQUE(workspace_id,membership_hash,index_version));
      CREATE TABLE IF NOT EXISTS corpus_members(corpus_revision_id TEXT NOT NULL REFERENCES corpus_revisions(id),source_version_id TEXT NOT NULL REFERENCES source_versions(id),PRIMARY KEY(corpus_revision_id,source_version_id));
      CREATE TABLE IF NOT EXISTS workspace_kb(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),current_revision_id TEXT REFERENCES corpus_revisions(id),sync_status TEXT NOT NULL DEFAULT 'never',sync_run_id TEXT,last_successful_sync_at TEXT,last_sync_error TEXT);
      CREATE TABLE IF NOT EXISTS thinkflow_bindings(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),notebook_id TEXT NOT NULL,base_url TEXT NOT NULL,user_id TEXT NOT NULL,bound_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunk_version ON chunks(source_version_id,ordinal);
      CREATE INDEX IF NOT EXISTS source_workspace ON sources(workspace_id,status);
      CREATE TRIGGER IF NOT EXISTS immutable_source_versions BEFORE UPDATE ON source_versions BEGIN SELECT RAISE(ABORT,'Source versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_chunk_body BEFORE UPDATE OF source_version_id,workspace_id,ordinal,start,end,text,sha256 ON chunks BEGIN SELECT RAISE(ABORT,'Chunk source and positions are immutable'); END;
    `);
    this.store.transaction(() => {
      const stale = this.db.prepare('SELECT * FROM chunks WHERE index_version<>?').all(INDEX_VERSION);
      for (const chunk of stale) {
        const tokens = tokenize(`${chunk.heading}\n${chunk.text}`).join(' ');
        this.db.prepare('UPDATE chunks SET tokens=?,index_version=? WHERE id=?').run(tokens, INDEX_VERSION, chunk.id);
        this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id=?').run(chunk.id);
        this.db.prepare('INSERT INTO chunks_fts(chunk_id,tokens) VALUES(?,?)').run(chunk.id, tokens);
      }
      if (stale.length) {
        const workspaces = this.db.prepare("SELECT k.workspace_id FROM workspace_kb k JOIN workspaces w ON w.id=k.workspace_id WHERE w.status='active' AND k.current_revision_id IS NOT NULL").all();
        for (const workspace of workspaces) this.publish(workspace.workspace_id);
      }
    });
  }

  workspace(workspaceId) {
    const owner = this.db.prepare("SELECT value FROM app_meta WHERE key='owner_id'").get()?.value;
    const workspace = this.db.prepare("SELECT * FROM workspaces WHERE id=? AND owner_id=? AND status='active'").get(workspaceId, owner);
    need(workspace, 'WORKSPACE_NOT_AVAILABLE', '研究空间不存在或已停用', 404);
    return workspace;
  }

  currentRevision(workspaceId) {
    this.workspace(workspaceId);
    return this.db.prepare('SELECT current_revision_id FROM workspace_kb WHERE workspace_id=?').get(workspaceId)?.current_revision_id || null;
  }

  ensureState(workspaceId) { this.db.prepare('INSERT OR IGNORE INTO workspace_kb(workspace_id) VALUES(?)').run(workspaceId); }

  saveSource({ workspaceId, title, text, kind, externalId, sourceId, readAt }) {
    this.workspace(workspaceId);
    need(kinds.has(kind), 'INVALID_SOURCE_KIND', '只有原始导入、个人笔记和 ThinkFlow 资料可以作为证据');
    need(typeof title === 'string' && title.trim() && codePoints(title).length <= 200, 'INVALID_SOURCE_TITLE', '资料标题需要1至200字符');
    need(typeof text === 'string' && text.isWellFormed() && text.trim() && codePoints(text).length <= 100000, 'INVALID_SOURCE_TEXT', '原始资料需要1至100000字符');
    need(externalId === undefined || (typeof externalId === 'string' && externalId.length > 0 && externalId.length <= 400), 'INVALID_EXTERNAL_ID', '来源标识格式不正确');
    let source;
    if (sourceId !== undefined) {
      source = this.db.prepare('SELECT * FROM sources WHERE id=? AND workspace_id=? AND kind=?').get(sourceId, workspaceId, kind);
      need(source && (externalId === undefined || externalId === source.external_id), 'SOURCE_NOT_AVAILABLE', '来源不属于该研究空间或类型不一致', 404);
    } else if (externalId !== undefined) source = this.db.prepare('SELECT * FROM sources WHERE workspace_id=? AND kind=? AND external_id=?').get(workspaceId, kind, externalId);
    if (!source) {
      source = { id: id('src'), external_id: externalId ?? id('local') };
      this.db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,NULL,'active',?)").run(source.id, workspaceId, kind, source.external_id, title, iso(this.clock()));
    }
    const digest = hashText(text);
    let version = this.db.prepare('SELECT * FROM source_versions WHERE source_id=? AND sha256=?').get(source.id, digest);
    if (!version) {
      version = { id: id('sv'), source_id: source.id, workspace_id: workspaceId, title, kind, text, sha256: digest, read_at: readAt || iso(this.clock()) };
      this.db.prepare('INSERT INTO source_versions VALUES(?,?,?,?,?,?,?,?)').run(version.id, source.id, workspaceId, title, kind, text, digest, version.read_at);
      for (const chunk of chunkText(text)) {
        const chunkId = id('chk'), tokens = tokenize(`${title}\n${chunk.heading}\n${chunk.text}`).join(' ');
        this.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(chunkId, version.id, workspaceId, chunk.ordinal, chunk.start, chunk.end, chunk.text, chunk.sha256, chunk.heading, tokens, INDEX_VERSION);
        this.db.prepare('INSERT INTO chunks_fts(chunk_id,tokens) VALUES(?,?)').run(chunkId, tokens);
      }
    }
    this.db.prepare("UPDATE sources SET title=?,current_version_id=?,status='active' WHERE id=?").run(title, version.id, source.id);
    return { source_id: source.id, source_version_id: version.id };
  }

  publish(workspaceId) {
    this.ensureState(workspaceId);
    const members = this.db.prepare("SELECT current_version_id FROM sources WHERE workspace_id=? AND status='active' AND current_version_id IS NOT NULL ORDER BY current_version_id").all(workspaceId).map(row => row.current_version_id);
    const digest = hashText(JSON.stringify(members));
    let revision = this.db.prepare('SELECT id FROM corpus_revisions WHERE workspace_id=? AND membership_hash=? AND index_version=?').get(workspaceId, digest, INDEX_VERSION);
    if (!revision) {
      revision = { id: id('corpus') };
      this.db.prepare('INSERT INTO corpus_revisions VALUES(?,?,?,?,?)').run(revision.id, workspaceId, iso(this.clock()), INDEX_VERSION, digest);
      for (const versionId of members) this.db.prepare('INSERT INTO corpus_members VALUES(?,?)').run(revision.id, versionId);
    }
    this.db.prepare('UPDATE workspace_kb SET current_revision_id=? WHERE workspace_id=?').run(revision.id, workspaceId);
    return revision.id;
  }

  importText({ workspaceId, title, text, kind = 'import', externalId, sourceId }) {
    return this.store.transaction(() => ({ ...this.saveSource({ workspaceId, title, text, kind, externalId, sourceId }), corpus_revision_id: this.publish(workspaceId) }));
  }

  listSources(workspaceId) {
    this.workspace(workspaceId);
    return this.db.prepare('SELECT s.id,s.id AS source_id,s.workspace_id,s.kind,s.external_id,s.title,s.status,s.current_version_id AS source_version_id,v.sha256,v.read_at,(SELECT count(*) FROM chunks c WHERE c.source_version_id=v.id) AS chunk_count FROM sources s LEFT JOIN source_versions v ON s.current_version_id=v.id WHERE s.workspace_id=? ORDER BY s.created_at,s.id').all(workspaceId);
  }

  deleteSource(workspaceId, sourceId) {
    return this.store.transaction(() => {
      this.workspace(workspaceId);
      const source = this.db.prepare('SELECT id FROM sources WHERE id=? AND workspace_id=?').get(sourceId, workspaceId);
      need(source, 'SOURCE_NOT_AVAILABLE', '来源不属于该研究空间', 404);
      this.db.prepare("UPDATE sources SET status='deleted' WHERE id=?").run(sourceId);
      return { source_id: sourceId, status: 'deleted', corpus_revision_id: this.publish(workspaceId) };
    });
  }

  /** Caller first removes that workspace's jobs/results/captures; FK failures roll everything back. */
  purgeWorkspace(workspaceId) {
    return this.store.transaction(() => {
      this.workspace(workspaceId);
      this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN(SELECT id FROM chunks WHERE workspace_id=?)').run(workspaceId);
      this.db.prepare('DELETE FROM chunks WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM workspace_kb WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM thinkflow_bindings WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM corpus_members WHERE corpus_revision_id IN(SELECT id FROM corpus_revisions WHERE workspace_id=?)').run(workspaceId);
      this.db.prepare('DELETE FROM corpus_revisions WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM source_versions WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM sources WHERE workspace_id=?').run(workspaceId);
      return { workspace_id: workspaceId, purged: true };
    });
  }

  getVersion(versionId) {
    const version = this.db.prepare('SELECT *,id AS source_version_id FROM source_versions WHERE id=?').get(versionId);
    return version || null;
  }

  report(workspaceId) {
    this.workspace(workspaceId);
    const state = this.db.prepare('SELECT * FROM workspace_kb WHERE workspace_id=?').get(workspaceId);
    const binding = this.db.prepare('SELECT notebook_id,base_url,user_id FROM thinkflow_bindings WHERE workspace_id=?').get(workspaceId);
    const sourceCount = this.db.prepare("SELECT count(*) AS n FROM sources WHERE workspace_id=? AND status='active'").get(workspaceId).n;
    return { workspace_id: workspaceId, corpus_revision_id: state?.current_revision_id || null, index_version: INDEX_VERSION, source_count: sourceCount, sync_status: state?.sync_status || 'never', last_successful_sync_at: state?.last_successful_sync_at || null, last_sync_error: state?.last_sync_error || null, thinkflow: binding || null };
  }

  evidence(workspaceId, corpusRevisionId, question, { limit = 8, maxContextCodePoints = 6000 } = {}) {
    this.workspace(workspaceId);
    need(typeof question === 'string' && question.isWellFormed() && codePoints(question).length <= 1000, 'INVALID_QUESTION', '问题最多1000字符');
    need(Number.isInteger(limit) && limit >= 1 && limit <= 8 && Number.isInteger(maxContextCodePoints) && maxContextCodePoints >= 100 && maxContextCodePoints <= 8000, 'INVALID_RETRIEVAL_LIMIT', '检索预算不正确');
    if (!corpusRevisionId) return [];
    need(this.db.prepare('SELECT id FROM corpus_revisions WHERE id=? AND workspace_id=?').get(corpusRevisionId, workspaceId), 'CORPUS_NOT_AVAILABLE', '资料版本不属于该研究空间', 404);
    const terms = queryTerms(question), exactTerms = substringTerms(question), candidates = new Map();
    const columns = 'c.*,v.source_id,v.title,v.kind,v.sha256 AS source_sha256,v.read_at';
    const joins = 'JOIN source_versions v ON v.id=c.source_version_id JOIN corpus_members m ON m.source_version_id=v.id JOIN corpus_revisions r ON r.id=m.corpus_revision_id';
    if (terms.length) {
      // Authorization, corpus membership and workspace filtering are inside the query, before LIMIT.
      const hits = this.db.prepare(`SELECT ${columns},bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id ${joins} WHERE chunks_fts MATCH ? AND r.workspace_id=? AND r.id=? AND c.workspace_id=? ORDER BY rank,c.id LIMIT 20`).all(literalMatch(terms), workspaceId, corpusRevisionId, workspaceId);
      for (const row of hits) candidates.set(row.id, { ...row, score: Math.max(0, -row.rank), ranking_reason: 'fts_bm25_literal' });
    }
    if (exactTerms.length) {
      const predicate = exactTerms.map(() => 'instr(lower(c.text),?)>0').join(' OR ');
      const rank = exactTerms.map(() => 'CASE WHEN instr(lower(c.text),?)>0 THEN 1 ELSE 0 END').join('+');
      const rows = this.db.prepare(`SELECT ${columns},(${rank}) AS exact_rank FROM chunks c ${joins} WHERE r.workspace_id=? AND r.id=? AND c.workspace_id=? AND (${predicate}) ORDER BY exact_rank DESC,c.id LIMIT 20`).all(...exactTerms, workspaceId, corpusRevisionId, workspaceId, ...exactTerms);
      for (const row of rows) {
        const found = exactTerms.filter(term => row.text.toLowerCase().includes(term));
        const score = found.reduce((total, term) => total + Math.min(12, codePoints(term).length), 0) / 100;
        const previous = candidates.get(row.id);
        candidates.set(row.id, { ...row, score: (previous?.score || 0) + score, ranking_reason: `${previous ? 'fts_bm25_literal+' : ''}exact_substring` });
      }
    }
    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20);
    // Adjacent context remains in the same immutable version and frozen corpus.
    const expanded = new Map(ranked.map(row => [row.id, row]));
    for (const row of ranked.slice(0, 8)) {
      for (const ordinal of [row.ordinal - 1, row.ordinal + 1]) {
        const neighbor = this.db.prepare(`SELECT ${columns} FROM chunks c ${joins} WHERE r.workspace_id=? AND r.id=? AND c.workspace_id=? AND c.source_version_id=? AND c.ordinal=?`).get(workspaceId, corpusRevisionId, workspaceId, row.source_version_id, ordinal);
        if (neighbor && !expanded.has(neighbor.id)) expanded.set(neighbor.id, { ...neighbor, score: row.score * 0.35, ranking_reason: `adjacent_to:${row.id}` });
      }
    }
    const sorted = [...expanded.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const selected = [], sourceCounts = new Map(), bodyHashes = new Set();
    let used = 0;
    for (const row of sorted) {
      const length = codePoints(row.text).length;
      if (selected.length >= limit) break;
      if (used + length > maxContextCodePoints || bodyHashes.has(row.sha256) || (sourceCounts.get(row.source_id) || 0) >= Math.max(1, Math.floor(limit / 2))) continue;
      if (selected.some(other => other.source_version_id === row.source_version_id && Math.max(0, Math.min(other.end, row.end) - Math.max(other.start, row.start)) > Math.min(other.end - other.start, row.end - row.start) * 0.5)) continue;
      selected.push(row); bodyHashes.add(row.sha256); used += length; sourceCounts.set(row.source_id, (sourceCounts.get(row.source_id) || 0) + 1);
    }
    return selected.map((row, index) => ({ id: `E${index + 1}`, chunk_id: row.id, source_id: row.source_id, source_version_id: row.source_version_id, workspace_id: workspaceId, corpus_revision_id: corpusRevisionId, title: row.title, kind: row.kind, text: row.text, start: row.start, end: row.end, sha256: row.source_sha256, chunk_sha256: row.sha256, read_at: row.read_at, score: row.score, ranking_reason: row.ranking_reason }));
  }

  validateEvidence(workspaceId, corpusRevisionId, evidence) {
    this.workspace(workspaceId);
    if (!Array.isArray(evidence) || evidence.length > 8) return false;
    const seen = new Set();
    return evidence.every((item, index) => {
      if (!item || item.id !== `E${index + 1}` || seen.has(item.chunk_id)) return false;
      seen.add(item.chunk_id);
      const row = this.db.prepare('SELECT c.*,v.source_id,v.title,v.kind,v.sha256 AS source_sha256,v.read_at FROM chunks c JOIN source_versions v ON v.id=c.source_version_id JOIN corpus_members m ON m.source_version_id=v.id JOIN corpus_revisions r ON r.id=m.corpus_revision_id WHERE c.id=? AND c.workspace_id=? AND r.workspace_id=? AND r.id=?').get(item.chunk_id, workspaceId, workspaceId, corpusRevisionId);
      return Boolean(row && item.workspace_id === workspaceId && item.corpus_revision_id === corpusRevisionId && item.source_id === row.source_id && item.source_version_id === row.source_version_id && item.text === row.text && item.start === row.start && item.end === row.end && item.sha256 === row.source_sha256 && item.chunk_sha256 === row.sha256 && item.title === row.title && item.kind === row.kind && item.read_at === row.read_at);
    });
  }

  indexCapture(captureId) {
    return this.store.transaction(() => {
      const capture = this.db.prepare('SELECT * FROM captures WHERE id=?').get(captureId);
      need(capture, 'CAPTURE_NOT_FOUND', '原文记录不存在', 404);
      const result = this.importText({ workspaceId: capture.workspace_id, title: codePoints(capture.text.trim().replace(/[\r\n]/g, ' ')).slice(0, 40).join('') || '个人笔记', text: capture.text, kind: 'note', externalId: `capture:${capture.id}` });
      this.db.prepare("UPDATE captures SET index_status='indexed' WHERE id=?").run(capture.id);
      this.db.prepare("UPDATE jobs SET status='completed' WHERE operation='index_capture' AND resource_id=?").run(capture.id);
      return result;
    });
  }

  indexPendingCaptures({ limit = 20, includeFailed = true } = {}) {
    need(Number.isInteger(limit) && limit > 0 && limit <= 100, 'INVALID_LIMIT', '索引批次大小不正确');
    const pending = this.db.prepare(`SELECT resource_id FROM jobs WHERE operation='index_capture' AND status IN (${includeFailed?"'queued','failed'":"'queued'"}) ORDER BY created_at,id LIMIT ?`).all(limit);
    const report = { indexed: 0, failed: 0, errors: [] };
    for (const job of pending) {
      try { this.indexCapture(job.resource_id); report.indexed++; }
      catch (error) {
        this.store.transaction(() => {
          this.db.prepare("UPDATE captures SET index_status='failed' WHERE id=? AND index_status<>'indexed'").run(job.resource_id);
          this.db.prepare("UPDATE jobs SET status='failed' WHERE operation='index_capture' AND resource_id=?").run(job.resource_id);
        });
        report.failed++; report.errors.push({ capture_id: job.resource_id, code: error instanceof KnowledgeError ? error.code : 'INDEX_FAILED' });
      }
    }
    return report;
  }

  async bindThinkFlow(workspaceId, { notebookId, client }) {
    this.workspace(workspaceId);
    need(typeof notebookId === 'string' && notebookId && notebookId.length <= 200 && client && typeof client.notebook === 'function', 'INVALID_THINKFLOW_BINDING', 'ThinkFlow 绑定参数不正确');
    const notebook = await client.notebook(notebookId);
    need(notebook?.id === notebookId, 'THINKFLOW_MEMBERSHIP_MISMATCH', 'ThinkFlow 笔记本归属核对失败', 409);
    const baseUrl = client.baseUrl || 'local-adapter', userId = client.userId || 'local';
    return this.store.transaction(() => {
      this.workspace(workspaceId); this.ensureState(workspaceId);
      this.db.prepare('INSERT INTO thinkflow_bindings VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET notebook_id=excluded.notebook_id,base_url=excluded.base_url,user_id=excluded.user_id,bound_at=excluded.bound_at').run(workspaceId, notebookId, baseUrl, userId, iso(this.clock()));
      return this.report(workspaceId);
    });
  }

  async syncThinkFlow(workspaceId, { notebookId, sourceIds, client }) {
    this.workspace(workspaceId);
    need(typeof notebookId === 'string' && client && typeof client.sources === 'function' && typeof client.readSources === 'function', 'INVALID_THINKFLOW_SYNC', 'ThinkFlow 同步参数不正确');
    const binding = this.db.prepare('SELECT * FROM thinkflow_bindings WHERE workspace_id=?').get(workspaceId);
    need(binding && binding.notebook_id === notebookId && binding.base_url === (client.baseUrl || 'local-adapter') && binding.user_id === (client.userId || 'local'), 'THINKFLOW_BINDING_REQUIRED', '请先核对并绑定该 ThinkFlow 笔记本', 409);
    const runId = id('sync');
    this.db.prepare("UPDATE workspace_kb SET sync_status='running',sync_run_id=?,last_sync_error=NULL WHERE workspace_id=?").run(runId, workspaceId);
    try {
      const listing = await client.sources(notebookId);
      need(listing?.notebook?.id === notebookId && Array.isArray(listing.sources), 'INVALID_THINKFLOW_LIST', 'ThinkFlow 来源列表核对失败', 502);
      const listed = new Map();
      for (const source of listing.sources) {
        need(typeof source.id === 'string' && source.id && !listed.has(source.id), 'INVALID_THINKFLOW_LIST', 'ThinkFlow 来源列表标识无效', 502);
        listed.set(source.id, source);
      }
      const selected = sourceIds === undefined ? [...listed.keys()] : sourceIds;
      need(Array.isArray(selected) && selected.length <= 200 && new Set(selected).size === selected.length && selected.every(value => typeof value === 'string' && listed.has(value)), 'INVALID_THINKFLOW_SELECTION', '选定来源不在已核对的完整列表内', 409);
      const prepared = [];
      for (const sourceId of selected) {
        const response = await client.readSources(notebookId, [sourceId], { preserveWhitespace: true });
        const source = response?.sources?.[0];
        need(response?.notebook?.id === notebookId && response.sources.length === 1 && source?.id === sourceId && typeof source.content === 'string', 'INVALID_THINKFLOW_SOURCE', 'ThinkFlow 原文归属核对失败', 502);
        const digest = hashText(source.content);
        need(source.sha256 === undefined || source.sha256 === digest, 'THINKFLOW_HASH_MISMATCH', 'ThinkFlow 原文哈希核对失败', 409);
        prepared.push({ workspaceId, title: source.name || listed.get(sourceId).name || 'ThinkFlow 资料', text: source.content, kind: 'thinkflow', externalId: `${notebookId}:${sourceId}`, readAt: iso(this.clock()) });
      }
      return this.store.transaction(() => {
        this.workspace(workspaceId);
        const current = this.db.prepare('SELECT * FROM thinkflow_bindings WHERE workspace_id=?').get(workspaceId);
        need(current && current.notebook_id === binding.notebook_id && current.base_url === binding.base_url && current.user_id === binding.user_id && this.db.prepare('SELECT sync_run_id FROM workspace_kb WHERE workspace_id=?').get(workspaceId)?.sync_run_id === runId, 'STALE_SYNC', '绑定或同步已变化，请重新同步', 409);
        for (const source of prepared) this.saveSource(source);
        // Only a successful complete list can remove membership. Historical snapshots remain intact.
        const validIds = new Set([...listed.keys()].map(sourceId => `${notebookId}:${sourceId}`));
        for (const source of this.db.prepare("SELECT id,external_id FROM sources WHERE workspace_id=? AND kind='thinkflow' AND status='active'").all(workspaceId)) {
          if (!validIds.has(source.external_id)) this.db.prepare("UPDATE sources SET status='deleted' WHERE id=?").run(source.id);
        }
        this.publish(workspaceId);
        this.db.prepare("UPDATE workspace_kb SET sync_status='ready',last_successful_sync_at=?,last_sync_error=NULL WHERE workspace_id=?").run(iso(this.clock()), workspaceId);
        return this.report(workspaceId);
      });
    } catch (error) {
      this.db.prepare("UPDATE workspace_kb SET sync_status='failed',last_sync_error=? WHERE workspace_id=? AND sync_run_id=?").run(error instanceof KnowledgeError ? error.code : 'THINKFLOW_UNAVAILABLE', workspaceId, runId);
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('THINKFLOW_UNAVAILABLE', 'ThinkFlow 同步失败；继续使用上次成功快照', 502, true);
    }
  }
}
