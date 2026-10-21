import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteStore } from '../lib/store/sqlite.mjs';
import { CaptureService } from '../lib/auth/capture-service.mjs';
import { passwordHash, randomSecret, sha256 } from '../lib/auth/security.mjs';
import { readProxyKey } from '../lib/proxy-config.mjs';
import { ThinkFlowClient, THINKFLOW_COMMIT } from '../lib/thinkflow.mjs';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.runtime');
const proxyBase = 'http://127.0.0.1:8317/v1';
const model = 'gpt-6-luna';

async function until(operation, predicate, label, timeoutMs = 190000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (predicate(value)) return value;
    await delay(500);
  }
  const error = new Error('Smoke stage timed out'); error.code = `TIMEOUT_${label}`; throw error;
}

/** Real application HTTP, SQLite, cloud proxy and pinned ThinkFlow; never a Watch-device claim. */
export async function smokeResearch({ allowGeneration = false, allowWrite = false, localProxy = false, thinkflowUrl = 'http://127.0.0.1:18437', output } = {}) {
  if (!allowGeneration || !allowWrite || !localProxy) throw new Error('Required: --allow-generation --allow-write --local-proxy; this creates synthetic documents and consumes model quota');
  const target = new URL(thinkflowUrl);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:' || !target.port || target.port === '8437' || target.pathname !== '/' || target.username || target.password || target.search || target.hash) throw new Error('ThinkFlow must be an explicitly isolated loopback service outside port 8437');
  const outputPath = path.resolve(output || path.join(runtime, 'research-smoke.json'));
  const relative = path.relative(runtime, outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Smoke reports must stay inside the repository .runtime directory');
  const proxyKey = readProxyKey();
  if (!proxyKey) throw new Error('The existing local proxy client key is unavailable; no credential was printed');
  let stage = 'initialize', app, temporary, cookie = '', csrf = '', modelCalls = 0, report;
  const password = randomSecret(), deviceSecret = randomSecret();
  const startedAt = new Date().toISOString(), stages = [];
  let notebook, source, jobId, captureId, workspaceId, documentId;
  const advance = name => { stage = name; stages.push({ stage: name, at: new Date().toISOString() }); };
  const requireStatus = (response, expected) => {
    if (response.status !== expected) {
      const error = new Error('Unexpected HTTP result');
      error.code = `HTTP_${response.status}_${typeof response.body?.error?.code === 'string' ? response.body.error.code : 'UNEXPECTED'}`;
      throw error;
    }
    return response.body;
  };
  try {
    advance('verify_isolated_upstream');
    const health = await fetch(`${target.origin}/personal-agent-health`, { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(response => response.json());
    assert.equal(health.upstream_commit, THINKFLOW_COMMIT);
    assert.equal(health.service, 'personal-agent-thinkflow');
    const client = new ThinkFlowClient({ baseUrl: target.origin, userId: `research-smoke-${randomUUID()}` });
    notebook = await client.createNotebook(`公开合成研究闭环 ${randomUUID()}`);
    const originalText = '# 公开合成检索实验\n\n本页全部数字来自虚构教学实验，不代表真实用户或医学研究。固定测试资料为60份中文课堂笔记。纯分词BM25的Recall@8为0.78，加入两字词与AI缩写补召回后为0.88。\n\n适用范围：仅限本批合成中文笔记，未覆盖扫描PDF和口语同义改写；不能据此宣称所有中文资料质量提升。';
    const listed = await client.addText(notebook.id, '公开合成检索实验.md', originalText);
    source = listed.sources.find(row => row.name.includes('公开合成检索实验')) || listed.sources[0];
    assert.ok(source?.id);
    const original = await client.readSources(notebook.id, [source.id], { preserveWhitespace: true });
    assert.equal(original.sources[0].content, originalText);

    advance('start_private_application');
    temporary = await mkdtemp(path.join(tmpdir(), 'personal-agent-real-research-'));
    const control = new SQLiteStore({ filename: path.join(temporary, 'workspace.sqlite') });
    try {
      control.initializeEmptyLegacyState({ provider: 'extractive', model: '', baseUrl: '' });
      new CaptureService(control).setPasswordHash(await passwordHash(password));
    } finally { control.close(); }
    app = await createApp({
      dataDir: temporary, storage: 'sqlite', thinkflowClient: client, autoStartResearch: true,
      researchModelConfig: { provider: 'openai', baseUrl: proxyBase, model },
      researchResolveKey: config => config.baseUrl === proxyBase ? proxyKey : '',
      researchFetch: async (input, init) => {
        const url = String(input);
        assert.ok(url.startsWith(`${proxyBase}/`), 'Smoke generation only uses the designated loopback proxy');
        if (url === `${proxyBase}/chat/completions`) modelCalls++;
        return fetch(input, init);
      },
    });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    async function request(route, body, { method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
      const response = await fetch(`${origin}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(35000), headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let value; try { value = await response.json(); } catch { value = null; }
      return { status: response.status, body: value, headers: response.headers };
    }
    const login = await request('/api/v1/owner/login', { password });
    const session = requireStatus(login, 200);
    cookie = login.headers.getSetCookie()[0]?.split(';')[0] || ''; csrf = session.csrf_token;
    assert.ok(cookie && csrf);
    const owner = (route, body, options = {}) => request(`/api/v1/owner${route}`, body, { ...options, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...options.headers } });
    const watch = (route, body, options = {}) => request(`/api/v1/watch${route}`, body, { ...options, headers: { Authorization: `Bearer ${deviceSecret}`, ...options.headers } });
    workspaceId = requireStatus(await owner('/workspaces', { name: '公开合成研究 Smoke' }), 201).id;
    advance('owner_import_and_sync');
    const directText = '  公开补充说明：此空间只含合成教学资料，不涉及真实个人数据。\n本次验证不代表Apple Watch真机已运行。  ';
    const direct = requireStatus(await owner(`/workspaces/${workspaceId}/sources`, { title: '公开补充说明.txt', text: directText }), 201);
    assert.equal(requireStatus(await owner(`/source-versions/${direct.source_version_id}`), 200).text, directText);
    requireStatus(await owner(`/workspaces/${workspaceId}/bind`, { notebook_id: notebook.id }), 200);
    const synced = requireStatus(await owner(`/workspaces/${workspaceId}/sync`, { notebook_id: notebook.id, source_ids: [source.id] }), 200);
    assert.equal(synced.sync_status, 'ready'); assert.equal(synced.source_count, 2);
    requireStatus(await owner('/model', { provider: 'openai', baseUrl: proxyBase, model }), 200);
    assert.equal(requireStatus(await owner('/model'), 200).configured, true);

    advance('simulated_watch_pair_capture');
    const pairing = requireStatus(await request('/api/v1/pairings', { pairing_request_id: randomUUID(), device_secret_hash: sha256(deviceSecret), device_name: 'HTTP模拟Watch（非真机）' }), 201);
    requireStatus(await owner(`/pairings/${pairing.pairing_id}/approve`, { allowed_workspace_ids: [workspaceId], default_workspace_id: workspaceId }), 200);
    const identity = requireStatus(await watch('/me'), 200);
    requireStatus(await owner(`/devices/${identity.device_id}/settings`, { allowed_workspace_ids: [workspaceId], default_workspace_id: workspaceId, enable_ask: true }), 200);
    const captureBody = { workspace_id: workspaceId, text: '  公开个人笔记：研究Recall@8时要保留合成数据、适用范围和条件。\n  ', created_at_client: new Date().toISOString() };
    const captureRequestId = randomUUID();
    captureId = requireStatus(await watch('/captures', captureBody, { headers: { 'Idempotency-Key': captureRequestId } }), 201).capture_id;
    assert.equal(requireStatus(await watch('/captures', captureBody, { headers: { 'Idempotency-Key': captureRequestId } }), 200).capture_id, captureId);
    await until(async () => requireStatus(await owner('/captures'), 200).captures.find(row => row.id === captureId), row => row?.index_status === 'indexed', 'CAPTURE_INDEX', 15000);
    assert.equal(modelCalls, 0);

    advance('real_model_ask_and_replay');
    const askBody = { workspace_id: workspaceId, question: '在这个公开合成实验里，两种检索方法的Recall@8分别是多少？请说明这些数字的适用范围。', created_at_client: new Date().toISOString() }, requestId = randomUUID();
    const accepted = requireStatus(await watch('/asks', askBody, { headers: { 'Idempotency-Key': requestId } }), 202);
    jobId = accepted.job_id;
    assert.equal(requireStatus(await watch('/asks', askBody, { headers: { 'Idempotency-Key': requestId } }), 200).job_id, jobId);
    const completed = await until(async () => requireStatus(await owner(`/jobs/${jobId}`), 200), job => ['completed', 'failed', 'needs_attention', 'cancelled'].includes(job.status), 'ASK_COMPLETE');
    assert.equal(completed.status, 'completed');
    assert.ok(modelCalls >= 1 && modelCalls <= 2);
    const record = completed.results.find(row => row.result_revision === completed.current_revision);
    assert.equal(record.result.answer_status, 'answered');
    const answerText = JSON.stringify(record.result);
    assert.ok(answerText.includes('0.78') && answerText.includes('0.88'));
    assert.ok(record.result.citations.length > 0 && completed.evidence.length > 0);

    advance('verify_frozen_citations_and_zero_call_reads');
    for (const item of completed.evidence) {
      const version = requireStatus(await owner(`/source-versions/${item.source_version_id}`), 200);
      assert.equal(version.workspace_id, workspaceId); assert.equal(version.source_id, item.source_id);
      assert.equal(sha256(version.text), item.sha256);
      assert.equal([...version.text].slice(item.start, item.end).join(''), item.text);
      assert.equal(sha256(item.text), item.chunk_sha256);
      assert.equal(item.corpus_revision_id, accepted.corpus_revision_id);
    }
    for (const citation of record.result.citations) {
      const item = completed.evidence.find(row => row.id === citation.id);
      assert.ok(item); assert.equal(citation.quote, item.text); assert.equal(citation.sha256, item.sha256);
    }
    const callsBeforeReads = modelCalls;
    for (let repeat = 0; repeat < 3; repeat++) {
      const feed = requireStatus(await watch('/feed?limit=20'), 200);
      assert.ok(feed.items.some(row => row.id === jobId)); assert.ok(feed.items.some(row => row.id === captureId));
      assert.equal(requireStatus(await watch(`/jobs/${jobId}`), 200).status, 'completed');
      assert.equal(requireStatus(await watch(`/jobs/${jobId}/brief`), 200).result_revision, record.result_revision);
    }
    assert.equal(modelCalls, callsBeforeReads);
    const usage = requireStatus(await owner('/usage'), 200);
    assert.equal(usage.calls, modelCalls);

    advance('edit_and_explicitly_confirm_revision');
    const { citations: ignoredCitations, ...edited } = structuredClone(record.result);
    edited.watch_brief.headline = '公开合成实验：检索对比（已审阅）';
    const updated = requireStatus(await owner(`/jobs/${jobId}/result`, { result_revision: record.result_revision, expected_content_hash: record.content_hash, result: edited }), 200);
    const revision = updated.results.find(row => row.result_revision === updated.current_revision);
    assert.equal(revision.result_revision, record.result_revision + 1);
    // This programmatic confirmation is authorized only by both explicit smoke write/generation flags.
    const confirmation = { result_revision: revision.result_revision, expected_content_hash: revision.content_hash, write_to_thinkflow: true };
    const receipt = requireStatus(await owner(`/jobs/${jobId}/confirm`, confirmation), 201);
    assert.equal(requireStatus(await owner(`/jobs/${jobId}/confirm`, confirmation), 201).intent_id, receipt.intent_id);
    const archived = await until(async () => requireStatus(await owner(`/jobs/${jobId}`), 200), value => value.archives.some(row => row.result_revision === revision.result_revision && ['verified', 'needs_attention', 'reconciliation_required', 'conflict'].includes(row.writeback_status)), 'WRITEBACK_VERIFY', 45000);
    const entry = archived.archives.find(row => row.result_revision === revision.result_revision);
    assert.equal(entry.writeback_status, 'verified');
    documentId = entry.writeback.document_id;
    const remote = await client.readDocument({ baseUrl: target.origin, userId: client.userId, notebookId: notebook.id, documentId });
    assert.equal(remote.document.content, entry.markdown);
    assert.equal(remote.document.metadata.personal_agent_writeback_intent_id, receipt.intent_id);
    assert.equal(remote.document.metadata.result_revision, revision.result_revision);
    assert.equal((await client.documents(notebook.id)).documents.filter(row => row.metadata?.personal_agent_writeback_intent_id === receipt.intent_id).length, 1);
    requireStatus(await owner(`/writebacks/${receipt.intent_id}/reconcile`, {}), 200);
    assert.equal(modelCalls, callsBeforeReads);
    advance('completed');
    report = {
      schema_version: '1', status: 'passed', started_at: startedAt, completed_at: new Date().toISOString(), input_status: 'public_synthetic_only',
      model: { name: model, endpoint: proxyBase, real_generation_calls: modelCalls, usage },
      application: { actual_HTTP: true, actual_SQLite: true, production_data_untouched: true, temporary_data_removed: true },
      upstream: { service: target.origin, commit: THINKFLOW_COMMIT, notebook_id: notebook.id, source_id: source.id, document_id: documentId, retained_for_review: true },
      verification: { direct_import_raw_text_preserved: true, actual_ThinkFlow_sync: true, simulated_watch_pairing: true, capture_replayed_same_ID: true, capture_indexed_without_model: true, ask_first_status: 202, ask_replay_status: 200, ask_replayed_same_ID: true, corpus_revision_id: accepted.corpus_revision_id, job_id: jobId, frozen_citation_hash_and_position: true, read_endpoints_no_generation: true, edited_result_revision: revision.result_revision, confirmation_same_intent: true, actual_writeback_and_readback: true, manual_reconciliation_verified: true },
      public_result: { answer_status: revision.result.answer_status, watch_brief: revision.result.watch_brief, evidence_count: completed.evidence.length, citations_count: record.result.citations.length },
      not_verified: ['Watch_real_device', 'Keychain', 'offline_native_outbox', 'public_HTTPS', 'TestFlight', 'always_on_host', 'general_model_quality'],
      stages,
    };
  } catch (error) {
    report = { schema_version: '1', status: 'failed', started_at: startedAt, completed_at: new Date().toISOString(), stage, code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SMOKE_FAILED', real_generation_calls: modelCalls, upstream_commit: THINKFLOW_COMMIT, notebook_id: notebook?.id || null, source_id: source?.id || null, job_id: jobId || null, document_id: documentId || null, not_verified: ['full_smoke_completion', 'Watch_real_device', 'public_HTTPS', 'TestFlight'], stages };
  } finally {
    await app?.close();
    if (temporary) {
      assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
      assert.ok(path.basename(temporary).startsWith('personal-agent-real-research-'));
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try { report.source_commit_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); report.working_tree_dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()); } catch { report.source_commit_sha = null; }
  report.script_sha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  const serialized = JSON.stringify(report, null, 2) + '\n';
  for (const secret of [proxyKey, password, deviceSecret, cookie, csrf].filter(Boolean)) assert.ok(!serialized.includes(secret), 'Report must not include an authentication credential');
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, serialized, { mode: 0o600 });
  return { report, outputPath };
}

export async function main(args = process.argv.slice(2)) {
  const options = {}, flagKeys = { '--allow-generation': 'allowGeneration', '--allow-write': 'allowWrite', '--local-proxy': 'localProxy' };
  for (let index = 0; index < args.length; index++) {
    if (flagKeys[args[index]] && !options[flagKeys[args[index]]]) options[flagKeys[args[index]]] = true;
    else if (['--thinkflow-url', '--output'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--')) {
      const key = args[index] === '--output' ? 'output' : 'thinkflowUrl';
      if (options[key]) throw new Error('Duplicate smoke option'); options[key] = args[++index];
    } else throw new Error('Usage: node scripts/smoke-research.mjs --allow-generation --allow-write --local-proxy [--thinkflow-url http://127.0.0.1:18437] [--output .runtime/research-smoke.json]');
  }
  const { report, outputPath } = await smokeResearch(options);
  console.log(JSON.stringify({ status: report.status, report: outputPath, real_generation_calls: report.model?.real_generation_calls ?? report.real_generation_calls, stage: report.stage || 'completed', not_verified: report.not_verified }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Research smoke stopped; flags, isolated service and local proxy configuration are required. No credentials were printed.'); process.exitCode = 1; });
