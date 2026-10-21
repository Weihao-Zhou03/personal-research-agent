import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../lib/store/sqlite.mjs';
import { backupWorkspace, restoreWorkspace } from '../lib/store/backup.mjs';
import { runScheduledBackup } from '../scripts/backup-scheduled.mjs';
import { CaptureService } from '../lib/auth/capture-service.mjs';
import { KnowledgeStore } from '../lib/kb/knowledge-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'scheduled-backup-')), directory = path.join(root, 'private-backups');
  await mkdir(directory, { mode: 0o700 });
  const databasePath = path.join(root, 'source.sqlite'), store = new SQLiteStore({ filename: databasePath });
  store.db.exec('CREATE TABLE proof(id TEXT PRIMARY KEY,text TEXT NOT NULL)');
  store.db.prepare('INSERT INTO proof VALUES(?,?)').run('original', '  中文原文🙂\n');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, databasePath, store };
}

test('scheduled backup verifies live WAL snapshots and retains only its latest seven by default', async t => {
  const { directory, databasePath, store } = await fixture(t);
  for (let index = 0; index < 8; index++) {
    store.db.prepare('INSERT INTO proof VALUES(?,?)').run(`item-${index}`, `内容${index}`);
    await runScheduledBackup({ databasePath, backupDir: directory, clock: () => Date.UTC(2026, 9, 21, 0, index) });
  }
  const files = await readdir(directory);
  assert.equal(files.filter(file => file.endsWith('.sqlite')).length, 7);
  assert.equal(files.filter(file => file.endsWith('.manifest.json')).length, 7);
  assert.ok(!files.includes('.personal-agent-backup.lock'));
});

test('scheduled retention preserves unrelated and manually-created backups; restore verifies raw source in new path', async t => {
  const { root, directory, databasePath } = await fixture(t);
  const manual = await backupWorkspace({ databasePath, backupDir: directory });
  await writeFile(path.join(directory, 'notes.sqlite'), 'unrelated');
  const first = await runScheduledBackup({ databasePath, backupDir: directory, retain: 1 });
  const latest = await runScheduledBackup({ databasePath, backupDir: directory, retain: 1 });
  assert.equal(latest.removed.length, 1);
  assert.equal(await readFile(path.join(directory, 'notes.sqlite'), 'utf8'), 'unrelated');
  assert.ok(await readFile(manual.backupPath));
  assert.equal(latest.warnings.find(row => row.file === path.basename(manual.manifestPath)).code, 'UNMANAGED_OR_UNVERIFIED_PRESERVED');
  assert.notEqual(first.backupPath, latest.backupPath);
  const restored = await restoreWorkspace({ backupPath: latest.backupPath, databasePath: path.join(root, 'new-directory', 'restored.sqlite') });
  assert.equal(restored.verified, true);
  const database = new DatabaseSync(restored.databasePath, { readOnly: true });
  try { assert.equal(database.prepare("SELECT text FROM proof WHERE id='original'").get().text, '  中文原文🙂\n'); } finally { database.close(); }
});

test('scheduled backup failure never prunes existing backups and releases its own lock', async t => {
  const { directory, databasePath } = await fixture(t);
  const prior = await runScheduledBackup({ databasePath, backupDir: directory, retain: 1 });
  await assert.rejects(() => runScheduledBackup({ databasePath, backupDir: directory, retain: 1, backup: async () => { throw new Error('synthetic new backup failure'); } }), /synthetic new backup/);
  assert.ok(await readFile(prior.backupPath));
  assert.ok(!(await readdir(directory)).includes('.personal-agent-backup.lock'));
});

test('scheduled retention preserves a modified old backup and a path-traversing forged manifest', async t => {
  const { root, directory, databasePath } = await fixture(t);
  const prior = await runScheduledBackup({ databasePath, backupDir: directory, retain: 1 });
  await writeFile(prior.backupPath, 'modified old file');
  const outside = path.join(root, 'outside.sqlite'); await writeFile(outside, 'outside must survive');
  const forged = JSON.parse(await readFile(prior.manifestPath, 'utf8'));
  forged.database_file = '../outside.sqlite';
  await writeFile(path.join(directory, 'forged.sqlite.manifest.json'), JSON.stringify(forged));
  const latest = await runScheduledBackup({ databasePath, backupDir: directory, retain: 1 });
  assert.equal(await readFile(prior.backupPath, 'utf8'), 'modified old file');
  assert.equal(await readFile(outside, 'utf8'), 'outside must survive');
  assert.equal(latest.removed.length, 0); assert.equal(latest.warnings.length, 2);
});

test('scheduled backup lock excludes simultaneous runs and rejects invalid retention or relative paths', async t => {
  const { directory, databasePath } = await fixture(t);
  await writeFile(path.join(directory, '.personal-agent-backup.lock'), 'another run', { mode: 0o600 });
  await assert.rejects(() => runScheduledBackup({ databasePath, backupDir: directory }), /lock already exists/);
  assert.equal(await readFile(path.join(directory, '.personal-agent-backup.lock'), 'utf8'), 'another run');
  await assert.rejects(() => runScheduledBackup({ databasePath: 'relative.sqlite', backupDir: directory }), /Absolute/);
  await assert.rejects(() => runScheduledBackup({ databasePath, backupDir: directory, retain: 0 }), /retention/);
});

test('scheduled backup restores frozen historical citations and FTS into a fresh database independently of later edits', async t => {
  const { root, directory, databasePath, store } = await fixture(t);
  const capture = new CaptureService(store), workspace = capture.createWorkspace('历史引用恢复');
  const knowledge = new KnowledgeStore(store);
  const original = knowledge.importText({ workspaceId: workspace.id, externalId: 'paper', title: '模型原文', text: '  模型早期证据，条件为小样本🙂。\n ' });
  const frozen = knowledge.evidence(workspace.id, original.corpus_revision_id, '模型');
  const saved = await runScheduledBackup({ databasePath, backupDir: directory });
  knowledge.importText({ workspaceId: workspace.id, externalId: 'paper', title: '模型原文', text: '模型后来证据，条件为大样本。' });
  const restoredPath = path.join(root, 'fresh-restore', 'workspace.sqlite');
  await restoreWorkspace({ backupPath: saved.backupPath, databasePath: restoredPath });
  const restored = new SQLiteStore({ filename: restoredPath });
  try {
    const restoredKnowledge = new KnowledgeStore(restored);
    assert.equal(restoredKnowledge.getVersion(original.source_version_id).text, '  模型早期证据，条件为小样本🙂。\n ');
    assert.ok(restoredKnowledge.validateEvidence(workspace.id, original.corpus_revision_id, frozen));
    assert.equal(restoredKnowledge.evidence(workspace.id, original.corpus_revision_id, '模型')[0].chunk_id, frozen[0].chunk_id);
    assert.equal(restored.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(knowledge.getVersion(knowledge.listSources(workspace.id)[0].source_version_id).text, '模型后来证据，条件为大样本。');
  } finally { restored.close(); }
});
