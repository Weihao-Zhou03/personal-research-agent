import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../lib/store/sqlite.mjs';
import { CaptureService } from '../lib/auth/capture-service.mjs';
import { KnowledgeStore } from '../lib/kb/knowledge-store.mjs';
import { chunkText, hashText, INDEX_VERSION, literalMatch, queryTerms } from '../lib/kb/text.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'research-kb-'));
  const store = new SQLiteStore({ filename: path.join(directory, 'workspace.sqlite') });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const capture = new CaptureService(store, { clock: () => Date.parse('2026-10-21T12:00:00Z') });
  const workspace = capture.createWorkspace('公开研究资料'), other = capture.createWorkspace('隔离空间');
  const kb = new KnowledgeStore(store, { clock: () => Date.parse('2026-10-21T12:00:00Z') });
  return { store, capture, workspace: workspace.id, other: other.id, kb };
}

test('KB preserves raw source, Unicode offsets, hashes and 600–1000 point chunks with 100 overlap', t => {
  const { kb, store, workspace } = fixture(t);
  const text = `  # 中文章节\n\n${'研究 AI 🙂。'.repeat(500)}\n\n末尾空白  \n`;
  const imported = kb.importText({ workspaceId: workspace, title: '中文材料', text });
  const version = kb.getVersion(imported.source_version_id);
  assert.equal(version.text, text); assert.equal(version.sha256, hashText(text));
  const chunks = store.db.prepare('SELECT * FROM chunks WHERE source_version_id=? ORDER BY ordinal').all(version.id);
  assert.ok(chunks.length > 3);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.text, [...text].slice(chunk.start, chunk.end).join(''));
    assert.equal(chunk.sha256, hashText(chunk.text));
    assert.equal(chunk.index_version, INDEX_VERSION);
    assert.ok(chunk.end - chunk.start <= 1000);
    if (index < chunks.length - 1) assert.ok(chunk.end - chunk.start >= 600);
    if (index) assert.equal(chunks[index - 1].end - chunk.start, 100);
  }
  assert.equal(chunks.at(-1).end, [...text].length);
  assert.throws(() => store.db.prepare('UPDATE source_versions SET text=? WHERE id=?').run('改变原文', version.id), /immutable/);
  assert.throws(() => store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('改变切块', chunks[0].id), /immutable/);
});

test('KB unchanged imports reuse immutable version/corpus and changed imports preserve historical evidence', t => {
  const { kb, workspace, store } = fixture(t);
  const before = kb.importText({ workspaceId: workspace, externalId: 'paper-1', title: '模型论文', text: '模型使用旧方法，条件为小样本。' });
  assert.deepEqual(kb.importText({ workspaceId: workspace, externalId: 'paper-1', title: '模型论文', text: '模型使用旧方法，条件为小样本。' }), before);
  const after = kb.importText({ workspaceId: workspace, sourceId: before.source_id, title: '模型论文', text: '模型使用新方法，条件为大样本。' });
  assert.equal(after.source_id, before.source_id); assert.notEqual(after.source_version_id, before.source_version_id);
  assert.notEqual(after.corpus_revision_id, before.corpus_revision_id);
  assert.equal(kb.evidence(workspace, before.corpus_revision_id, '模型方法')[0].text, '模型使用旧方法，条件为小样本。');
  assert.equal(kb.evidence(workspace, after.corpus_revision_id, '模型方法')[0].text, '模型使用新方法，条件为大样本。');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_versions').get().n, 2);
});

test('KB scope and frozen membership filter before top K, not after global retrieval', t => {
  const { kb, workspace, other, store } = fixture(t);
  for (let i = 0; i < 25; i++) kb.importText({ workspaceId: other, title: `隔离${i}`, text: `量子研究 模型 AI ${'量子研究 '.repeat(20)}` });
  const allowed = kb.importText({ workspaceId: workspace, title: '授权资料', text: '量子研究中的模型使用 AI，限于本研究条件。' });
  const evidence = kb.evidence(workspace, allowed.corpus_revision_id, '量子研究 AI');
  assert.equal(evidence.length, 1); assert.equal(evidence[0].source_id, allowed.source_id);
  assert.equal(evidence[0].workspace_id, workspace);
  assert.throws(() => kb.evidence(other, allowed.corpus_revision_id, '量子研究'), error => error.code === 'CORPUS_NOT_AVAILABLE');
  store.db.prepare("UPDATE workspaces SET owner_id='another-owner' WHERE id=?").run(other);
  assert.throws(() => kb.currentRevision(other), error => error.code === 'WORKSPACE_NOT_AVAILABLE');
});

test('KB handles Chinese two-character terms, AI and hostile FTS syntax as literals', t => {
  const { kb, workspace, store } = fixture(t);
  const imported = kb.importText({ workspaceId: workspace, title: '材料', text: '研究采用模型分析与 AI 辅助，量子态有明确条件。' });
  // Remove FTS tokens to exercise exact substring fallback independently of Intl.Segmenter.
  store.db.prepare('DELETE FROM chunks_fts').run();
  for (const question of ['模型', '研究', 'AI']) {
    const found = kb.evidence(workspace, imported.corpus_revision_id, question);
    assert.equal(found.length, 1); assert.match(found[0].ranking_reason, /exact_substring/);
  }
  for (const question of ['模型 " OR NEAR(研究,2) : -* ^', '"', 'OR', 'AI") OR workspace_id:*']) {
    assert.doesNotThrow(() => kb.evidence(workspace, imported.corpus_revision_id, question));
  }
  assert.ok(!literalMatch(queryTerms('" OR NEAR(模型,2)')).includes('NEAR('));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_versions').get().n, 1);
});

test('KB evidence has at most 8 unique bounded chunks, source caps, context budget and provenance', t => {
  const { kb, workspace } = fixture(t);
  for (let i = 0; i < 3; i++) kb.importText({ workspaceId: workspace, title: `研究${i}`, text: (`研究模型阶段${i}：${'资料 '.repeat(80)}\n\n`).repeat(20) });
  const revision = kb.currentRevision(workspace), evidence = kb.evidence(workspace, revision, '研究模型阶段', { maxContextCodePoints: 5000 });
  assert.ok(evidence.length > 1 && evidence.length <= 8);
  assert.ok(evidence.reduce((sum, row) => sum + [...row.text].length, 0) <= 5000);
  assert.equal(new Set(evidence.map(row => row.chunk_id)).size, evidence.length);
  for (const sourceId of new Set(evidence.map(row => row.source_id))) assert.ok(evidence.filter(row => row.source_id === sourceId).length <= 4);
  assert.ok(kb.validateEvidence(workspace, revision, evidence));
  assert.equal(kb.validateEvidence(workspace, revision, [{ ...evidence[0], text: '模型篡改文本' }]), false);
  assert.equal(kb.validateEvidence(workspace, revision, [{ ...evidence[0], source_version_id: 'missing' }]), false);
  assert.equal(kb.validateEvidence(workspace, revision, [{ ...evidence[0], workspace_id: 'other' }]), false);
});

test('KB duplicate raw blocks do not count twice and invalid configuration/derived content is rejected', t => {
  const { kb, workspace, other } = fixture(t);
  const original = kb.importText({ workspaceId: workspace, title: '原文1', text: '模型引用必须可追溯。' });
  kb.importText({ workspaceId: workspace, title: '原文2', text: '模型引用必须可追溯。' });
  assert.equal(kb.evidence(workspace, kb.currentRevision(workspace), '模型引用').length, 1);
  assert.throws(() => kb.importText({ workspaceId: workspace, title: 'AI生成', text: '模型生成内容', kind: 'derived' }), error => error.code === 'INVALID_SOURCE_KIND');
  assert.throws(() => kb.importText({ workspaceId: other, sourceId: original.source_id, title: '越权', text: '不能跨空间' }), error => error.code === 'SOURCE_NOT_AVAILABLE');
  assert.throws(() => kb.importText({ workspaceId: workspace, title: '空白', text: ' \n ' }), error => error.code === 'INVALID_SOURCE_TEXT');
  assert.throws(() => kb.evidence(workspace, original.corpus_revision_id, '模型', { limit: 9 }), error => error.code === 'INVALID_RETRIEVAL_LIMIT');
  assert.deepEqual(kb.evidence(workspace, original.corpus_revision_id, '完全不存在的斑马星球'), []);
  assert.throws(() => chunkText('资料', { overlap: 1 }), /configuration/);
});

test('KB corpus publication rolls back new snapshots/chunks/index atomically on failure', t => {
  const { kb, workspace, store } = fixture(t);
  const before = kb.importText({ workspaceId: workspace, title: '旧资料', text: '模型旧快照。' });
  store.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON corpus_revisions BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END;");
  assert.throws(() => kb.importText({ workspaceId: workspace, title: '新资料', text: '模型新快照。' }), /synthetic publish/);
  assert.equal(kb.currentRevision(workspace), before.corpus_revision_id);
  for (const table of ['sources', 'source_versions', 'chunks', 'chunks_fts', 'corpus_revisions']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1);
});

function upstream() {
  const state = { list: [{ id: 'one', name: '中文论文' }, { id: 'two', name: 'AI 文献' }], bodies: { one: '  模型旧结论。\n ', two: 'AI 只在给定资料范围使用。' }, failList: false, failBody: false, badHash: false };
  const client = {
    baseUrl: 'http://127.0.0.1:8437', userId: 'local',
    async notebook(id) { return { id, name: '研究笔记本' }; },
    async sources(id) { if (state.failList) throw new Error('upstream SECRET PRIVATE'); return { notebook: { id }, sources: state.list }; },
    async readSources(id, selected, options) {
      assert.equal(options?.preserveWhitespace, true);
      if (state.failBody) throw new Error('body SECRET PRIVATE');
      return { notebook: { id }, sources: selected.map(sourceId => ({ ...state.list.find(row => row.id === sourceId), content: state.bodies[sourceId], sha256: state.badHash ? 'invalid' : hashText(state.bodies[sourceId]) })) };
    },
  };
  return { state, client };
}

test('KB ThinkFlow binding, full-list sync and unchanged source reuse preserve per-source read snapshots', async t => {
  const { kb, workspace, store } = fixture(t), { client } = upstream();
  await assert.rejects(() => kb.syncThinkFlow(workspace, { notebookId: 'book', client }), error => error.code === 'THINKFLOW_BINDING_REQUIRED');
  await kb.bindThinkFlow(workspace, { notebookId: 'book', client });
  const first = await kb.syncThinkFlow(workspace, { notebookId: 'book', client });
  assert.equal(first.sync_status, 'ready'); assert.equal(first.source_count, 2);
  assert.equal(kb.getVersion(kb.listSources(workspace).find(row => row.external_id === 'book:one').source_version_id).text, '  模型旧结论。\n ');
  const second = await kb.syncThinkFlow(workspace, { notebookId: 'book', client });
  assert.equal(second.corpus_revision_id, first.corpus_revision_id);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_versions').get().n, 2);
  assert.ok(kb.evidence(workspace, first.corpus_revision_id, '模型')[0].read_at);
});

test('KB failed complete list or partial read retains previous corpus; confirmed deletion removes only new corpus', async t => {
  const { kb, workspace } = fixture(t), { client, state } = upstream();
  await kb.bindThinkFlow(workspace, { notebookId: 'book', client });
  const first = await kb.syncThinkFlow(workspace, { notebookId: 'book', client });
  state.failList = true;
  await assert.rejects(() => kb.syncThinkFlow(workspace, { notebookId: 'book', client }), error => error.code === 'THINKFLOW_UNAVAILABLE' && !error.message.includes('SECRET'));
  assert.equal(kb.currentRevision(workspace), first.corpus_revision_id);
  assert.equal(kb.report(workspace).last_sync_error, 'THINKFLOW_UNAVAILABLE');
  state.failList = false; state.bodies.one = '模型全新结论。'; state.failBody = true;
  await assert.rejects(() => kb.syncThinkFlow(workspace, { notebookId: 'book', client }));
  assert.equal(kb.evidence(workspace, first.corpus_revision_id, '模型')[0].text, '  模型旧结论。\n ');
  state.failBody = false; state.list = state.list.filter(row => row.id !== 'one');
  const after = await kb.syncThinkFlow(workspace, { notebookId: 'book', client });
  assert.equal(after.source_count, 1);
  assert.deepEqual(kb.evidence(workspace, after.corpus_revision_id, '模型'), []);
  assert.equal(kb.evidence(workspace, first.corpus_revision_id, '模型')[0].text, '  模型旧结论。\n ');
  assert.equal(kb.listSources(workspace).find(row => row.external_id === 'book:one').status, 'deleted');
});

test('KB ThinkFlow hash and notebook mismatches fail closed without publishing partial sources', async t => {
  const { kb, workspace, store } = fixture(t), { client, state } = upstream();
  await kb.bindThinkFlow(workspace, { notebookId: 'book', client });
  state.badHash = true;
  await assert.rejects(() => kb.syncThinkFlow(workspace, { notebookId: 'book', client }), error => error.code === 'THINKFLOW_HASH_MISMATCH');
  assert.equal(kb.currentRevision(workspace), null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  state.badHash = false;
  await assert.rejects(() => kb.syncThinkFlow(workspace, { notebookId: 'wrong', client }), error => error.code === 'THINKFLOW_BINDING_REQUIRED');
});

test('KB Capture index intent creates one personal note without modifying raw capture and retries safely', t => {
  const { kb, workspace, capture, store } = fixture(t);
  store.db.prepare("INSERT INTO devices(id,owner_id,secret_hash,name,status) VALUES('device',?,'hash','fixture','active')").run(capture.ownerId);
  const text = `${' '.repeat(45)}研究模型原文🙂\n  `;
  store.db.prepare("INSERT INTO captures VALUES('capture',?,?,'device',?,'2026-10-21T10:00:00Z','2026-10-21T10:00:01Z','pending')").run(capture.ownerId, workspace, text);
  store.db.prepare("INSERT INTO jobs VALUES('index','index_capture','capture','queued','2026-10-21T10:00:01Z')").run();
  assert.deepEqual(kb.indexPendingCaptures(), { indexed: 1, failed: 0, errors: [] });
  const first = kb.currentRevision(workspace);
  kb.indexCapture('capture');
  assert.equal(kb.currentRevision(workspace), first);
  assert.equal(kb.listSources(workspace).length, 1); assert.equal(kb.listSources(workspace)[0].kind, 'note');
  assert.equal(kb.getVersion(kb.listSources(workspace)[0].source_version_id).text, text);
  assert.equal(store.db.prepare("SELECT text,index_status FROM captures WHERE id='capture'").get().text, text);
  assert.equal(store.db.prepare("SELECT status FROM jobs WHERE id='index'").get().status, 'completed');
});

test('KB indexing failure keeps original capture and queued intent becomes explicitly retryable failed', t => {
  const { kb, workspace, capture, store } = fixture(t);
  store.db.prepare("INSERT INTO devices(id,owner_id,secret_hash,name,status) VALUES('device',?,'hash','fixture','active')").run(capture.ownerId);
  store.db.prepare("INSERT INTO captures VALUES('capture',?,?,'device','模型原文','2026-10-21T10:00:00Z','2026-10-21T10:00:01Z','pending')").run(capture.ownerId, workspace);
  store.db.prepare("INSERT INTO jobs VALUES('index','index_capture','capture','queued','2026-10-21T10:00:01Z')").run();
  store.db.prepare("UPDATE workspaces SET status='archived' WHERE id=?").run(workspace);
  assert.equal(kb.indexPendingCaptures().failed, 1);
  assert.equal(store.db.prepare("SELECT text FROM captures WHERE id='capture'").get().text, '模型原文');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_versions').get().n, 0);
  store.db.prepare("UPDATE workspaces SET status='active' WHERE id=?").run(workspace);
  assert.equal(kb.indexPendingCaptures().indexed, 1);
});
