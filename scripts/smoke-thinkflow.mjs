import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ThinkFlowClient, THINKFLOW_COMMIT } from '../lib/thinkflow.mjs';
import { SQLiteStore } from '../lib/store/sqlite.mjs';
import { CaptureService } from '../lib/auth/capture-service.mjs';
import { KnowledgeStore } from '../lib/kb/knowledge-store.mjs';
import { ResearchJobs } from '../lib/jobs/research-jobs.mjs';
import { ResearchArchive } from '../lib/archive.mjs';

async function researchArchiveSmoke(client, notebookId, marker) {
  const directory = mkdtempSync(path.join(tmpdir(), 'personal-agent-thinkflow-smoke-'));
  const store = new SQLiteStore({ filename: path.join(directory, 'smoke.sqlite') });
  let jobs, archive, mockCalls = 0;
  try {
    store.initializeEmptyLegacyState();
    const capture = new CaptureService(store), workspace = capture.createWorkspace('隔离真实上游同步');
    const knowledge = new KnowledgeStore(store);
    await knowledge.bindThinkFlow(workspace.id, { notebookId, client });
    const synced = await knowledge.syncThinkFlow(workspace.id, { notebookId, client });
    assert.equal(synced.source_count, 1);
    const source = knowledge.listSources(workspace.id)[0];
    assert.ok(knowledge.getVersion(source.source_version_id).text.includes(marker));
    const result = { schema_version: '1', answer_status: 'answered', watch_brief: { headline: '合成简报用于真实写回验证', bullets: [{ text: '中文原文涉及模型和 AI 检索。', citation_ids: ['E1'] }] }, sections: [{ heading: '资料依据', statements: [{ kind: 'fact', text: '原文用于验证真实读回。', citation_ids: ['E1'] }] }], limitations: ['生成内容来自测试替身，仅验证确认与真实上游写回，不代表模型质量。'] };
    jobs = new ResearchJobs(store, { knowledge, modelConfig: { provider: 'openai', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic-smoke-only' }, autoStart: false, fetchImpl: async () => { mockCalls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 }); } });
    const accepted = jobs.submit({ ownerId: capture.ownerId, deviceId: 'isolated-smoke', workspaceId: workspace.id, requestId: randomUUID(), question: '模型原文怎样验证读回？', createdAtClient: new Date().toISOString() });
    await jobs.runOnce();
    const jobId = accepted.response.job_id;
    assert.equal(jobs.get(jobId).status, 'completed');
    archive = new ResearchArchive(store, { jobs, knowledge, thinkflowClient: client, autoStart: false });
    const confirmation = () => {
      const record = jobs.get(jobId).results.at(-1);
      return { result_revision: record.result_revision, expected_content_hash: record.content_hash, write_to_thinkflow: true };
    };
    const receipt = archive.confirm(jobId, confirmation());
    assert.equal(archive.confirm(jobId, confirmation()).intent_id, receipt.intent_id);
    await archive.drainOnce();
    const first = archive.getForJob(jobId).archives[0];
    assert.equal(first.writeback_status, 'verified');
    assert.equal((await archive.reconcile(receipt.intent_id)).status, 'verified');
    const current = jobs.get(jobId).results.at(-1), edited = structuredClone(current.result);
    edited.watch_brief.headline = '人工修订第二版，仅供 Smoke';
    jobs.edit(jobId, { result_revision: current.result_revision, expected_content_hash: current.content_hash, result: edited });
    const secondReceipt = archive.confirm(jobId, confirmation());
    await archive.drainOnce();
    const second = archive.getForJob(jobId).archives[1];
    assert.equal(second.writeback_status, 'verified');
    assert.notEqual(secondReceipt.intent_id, receipt.intent_id);
    assert.notEqual(second.writeback.document_id, first.writeback.document_id);
    const documents = (await client.documents(notebookId)).documents;
    assert.equal(documents.filter(item => item.metadata?.personal_agent_writeback_intent_id === receipt.intent_id).length, 1);
    assert.equal(documents.filter(item => item.metadata?.personal_agent_writeback_intent_id === secondReceipt.intent_id).length, 1);
    return { actual_ThinkFlow_sync: true, frozen_source_sha256: knowledge.getVersion(source.source_version_id).sha256, confirmed_revision_1_readback: true, confirmation_replay_one_intent: true, manual_reconciliation_verified: true, revision_2_separate_document: true, mock_generation_calls: mockCalls, real_generation_calls: 0 };
  } finally { await archive?.stop(); await jobs?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

/** This mutates only a newly-created smoke notebook. Use a separately-started isolated service. */
export async function smokeThinkFlow({ baseUrl, allowWrite = false } = {}) {
  const url = new URL(baseUrl || 'http://127.0.0.1:18437');
  if (!allowWrite || url.port === '8437' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Explicit --allow-write and an isolated loopback service outside port 8437 are required');
  const health = await fetch(`${url.origin}/personal-agent-health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const identity = await health.json();
  assert.equal(identity.upstream_commit, THINKFLOW_COMMIT);
  assert.equal(identity.service, 'personal-agent-thinkflow');
  const marker = randomUUID(), client = new ThinkFlowClient({ baseUrl: url.origin, userId: `smoke-${marker}` });
  const notebook = await client.createNotebook(`隔离 Linux Smoke ${marker}`);
  const body = `  中文模型原文与 AI 检索。\n此行用于真实读回。\n  ${marker}  `;
  const listed = await client.addText(notebook.id, `smoke-${marker}.txt`, body);
  assert.equal(listed.notebook.id, notebook.id); assert.ok(listed.sources.length >= 1);
  const read = await client.readSources(notebook.id, [listed.sources[0].id], { preserveWhitespace: true });
  assert.ok(read.sources[0].content.includes(marker));
  // Pinned upstream import_text strips boundaries before storing. Snapshot its actual returned body.
  assert.equal(read.sources[0].content, body.trim());
  const content = `# 人工确认的 Smoke 结果\n\n仅验证真实创建与读回。标识：${marker}\n`;
  const task = { id: `smoke-${marker}`, title: '隔离 Smoke 结果', kind: 'study', sourceText: read.sources[0].content, result: { model: null }, writebackIntent: { confirmedAt: new Date().toISOString() }, thinkflow: { baseUrl: url.origin, userId: client.userId, notebookId: notebook.id, sources: read.sources.map(source => ({ id: source.id, sha256: source.sha256 })) } };
  const written = await client.writeResult(task, content), document = await client.readDocument({ ...written, baseUrl: url.origin, userId: client.userId });
  assert.equal(document.document.content, content);
  const retried = await client.writeResult(task, content);
  assert.equal(retried.documentId, written.documentId);
  const documents = await client.documents(notebook.id);
  assert.equal(documents.documents.filter(row => row.metadata?.personal_agent_task_id === task.id).length, 1);
  const research = await researchArchiveSmoke(client, notebook.id, marker);
  return { service: url.origin, upstream_commit: THINKFLOW_COMMIT, notebook_id: notebook.id, source_id: read.sources[0].id, document_id: written.documentId, snapshot_matches_upstream_stored_body: true, upstream_import_trimmed_boundaries: true, original_import_request_preserved_by_upstream: false, document_readback: true, retry_deduplicated: true, model_calls: 0, research_archive: research, not_verified: ['public_HTTPS', 'production_data_migration', 'real_model_generation', 'TestFlight', 'Watch_device'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let allowWrite = false, baseUrl;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--allow-write' && !allowWrite) allowWrite = true;
    else if (args[index] === '--base-url' && !baseUrl && args[index + 1] && !args[index + 1].startsWith('--')) baseUrl = args[++index];
    else throw new Error('Usage: node scripts/smoke-thinkflow.mjs --base-url http://127.0.0.1:18437 --allow-write');
  }
  smokeThinkFlow({ baseUrl, allowWrite }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`ThinkFlow smoke failed: ${error.name}; inspect private service logs`); process.exitCode = 1; });
}
