import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { SQLiteStore } from '../lib/store/sqlite.mjs';
import { CaptureService } from '../lib/auth/capture-service.mjs';
import { KnowledgeStore } from '../lib/kb/knowledge-store.mjs';
import { hashText, INDEX_VERSION } from '../lib/kb/text.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const datasetText = readFileSync(new URL('./lexical-cases.json', import.meta.url), 'utf8');
const dataset = JSON.parse(datasetText);
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--output')) throw new Error('Usage: node eval/run-lexical.mjs [--output result.json]');
const directory = mkdtempSync(path.join(tmpdir(), 'research-lexical-eval-'));
const store = new SQLiteStore({ filename: path.join(directory, 'eval.sqlite') });
let report;
try {
  const capture = new CaptureService(store), workspace = capture.createWorkspace('公开合成评测');
  const kb = new KnowledgeStore(store), sourceIds = new Map();
  for (const source of dataset.sources) {
    const result = kb.importText({ workspaceId: workspace.id, externalId: source.external_id, title: source.title, text: source.text });
    sourceIds.set(source.external_id, result.source_id);
  }
  const revision = kb.currentRevision(workspace.id), results = [];
  for (const question of dataset.questions) {
    const start = performance.now(), evidence = kb.evidence(workspace.id, revision, question.question), elapsed = performance.now() - start;
    const matches = question.required.map(fact => ({ ...fact, matched: evidence.some(item => item.source_id === sourceIds.get(fact.source) && item.text.includes(fact.needle)) }));
    results.push({
      id: question.id, question: question.question, answerable: question.answerable !== false,
      recall_at_8: matches.length ? matches.filter(item => item.matched).length / matches.length : null,
      required_evidence: matches, retrieval_ms: Math.round(elapsed * 1000) / 1000,
      evidence: evidence.map(item => ({ ...item, source_external_id: [...sourceIds].find(([, sourceId]) => sourceId === item.source_id)?.[0] })),
    });
  }
  const scored = results.filter(item => item.recall_at_8 !== null), times = results.map(item => item.retrieval_ms).sort((a, b) => a - b);
  let commit = null, dirty = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()); } catch { /* A copied source tree may not have Git metadata. */ }
  report = {
    schema_version: '1', eval: dataset.name, data_status: dataset.data_status, dataset_sha256: hashText(datasetText),
    source_commit_sha: commit, working_tree_dirty: dirty, node: process.version, index_version: INDEX_VERSION,
    corpus_revision_id: revision, chunk_configuration: { target: 800, minimum: 600, maximum: 1000, overlap: 100 },
    completed_at: new Date().toISOString(),
    summary: {
      questions: results.length, answerable_questions: scored.length, unanswerable_questions: results.length - scored.length,
      mean_recall_at_8: scored.reduce((sum, item) => sum + item.recall_at_8, 0) / scored.length,
      all_required_recalled: scored.filter(item => item.recall_at_8 === 1).length,
      retrieval_p95_ms: times[Math.ceil(times.length * 0.95) - 1],
      unanswerable_with_candidates: results.filter(item => !item.answerable && item.evidence.length).length,
    },
    not_verified: ['real_model_generation', 'citation_fact_support', 'correct_abstention', 'real_private_corpus', 'Watch_device'],
    limitations: ['Synthetic lexical baseline only; recall is measured against necessary source/substring evidence, not model answer quality.', 'Unanswerable questions may retrieve related text; this runner does not evaluate whether a model correctly refuses.', 'Working-tree results are not evidence for an unchanged commit when working_tree_dirty is true.'],
    results,
  };
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
if (args[0] === '--output') writeFileSync(path.resolve(args[1]), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(args.length ? { output: path.resolve(args[1]), ...report.summary, not_verified: report.not_verified } : report, null, 2));
