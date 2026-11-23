import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SQLiteStore, validateLegacyState, legacyManifest, sha256 } from '../lib/store/sqlite.mjs';
import { migrateWorkspace } from '../lib/store/migrate.mjs';
import { backupWorkspace, restoreWorkspace, inspectDatabase } from '../lib/store/backup.mjs';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const at = '2026-10-21T12:34:56.789Z';
function legacyState() {
  const sourceText = '【ThinkFlow 来源 TF1：物理课】\n摆的周期 T = 2π√(L/g)。\n中文原文、空格  与换行必须保留。';
  const task = {
    id: 'task-original', title: '科研课资料', kind: 'study', instruction: '整理并保留证据', sourceText,
    sources: [{ title: '课堂原始材料', url: 'http://127.0.0.1:8437/outputs/source.md', extension: { read: true } }],
    status: 'completed', createdAt: at, updatedAt: at, error: null, knowledgeId: 'knowledge-original',
    result: { markdown: '# 人工修订\n\nT = 2π√(L/g)。', mode: 'ai', model: 'gpt-6-luna', createdAt: at, editedAt: at, extension: ['preserve'] },
    conversation: [{ question: '平方根是否保留？', answer: '原文包含平方根。', createdAt: at, future: { a: 1 } }],
    events: [{ status: 'completed', at, message: '等待人工确认', details: { keep: true } }],
    thinkflow: { notebookId: 'local-book', sources: [{ ref: 'TF1', sha256: sha256('摆的周期 T = 2π√(L/g)。'), start: 0, end: sourceText.length }], future: { independentVersions: false } },
    writebackIntent: { content: '# 人工修订\n\nT = 2π√(L/g)。', confirmedAt: at, status: 'verified', unknown: { preserve: true } },
    extension: { nested: { original: ['中文', 42, null] } },
  };
  return {
    version: 1, tasks: [task, { ...structuredClone(task), id: 'task-interrupted', knowledgeId: null, status: 'running', result: null, writebackIntent: undefined }],
    knowledge: [{ id: 'knowledge-original', taskId: task.id, title: task.title, kind: task.kind, content: task.result.markdown, sources: structuredClone(task.sources), createdAt: at, thinkflow: { documentId: 'doc-native', verifiedAt: at }, extension: { retain: [1, 2] } }],
    settings: { provider: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', model: 'gpt-6-luna', apiKey: 'SECRET_MUST_NOT_ENTER_SQLITE', oauth: 'NEITHER_THIS_SECRET' },
    futureBusiness: { nested: { revisions: ['v0', 'v1'] } },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-agent-store-'));
  const stores = new Set();
  t.after(async () => { for (const store of stores) { try { store.close(); } catch { /* already closed */ } } await rm(directory, { recursive: true, force: true }); });
  const databasePath = path.join(directory, 'workspace.sqlite');
  const sourcePath = path.join(directory, 'workspace.json');
  const backupDir = path.join(directory, 'private-backups');
  const store = filename => { const value = new SQLiteStore({ filename: filename || databasePath }); stores.add(value); return value; };
  const state = JSON.parse(JSON.stringify(legacyState()));
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  return { directory, databasePath, sourcePath, backupDir, bytes, state, store };
}

test('SQLite adapter requires explicit initialization, preserves nested legacy fields and interrupted statuses on restart', async t => {
  const f = await fixture(t);
  let store = f.store();
  assert.equal(store.readLegacyState(), null, 'Schema creation is not an empty workspace migration');
  store.writeLegacyState(f.state);
  assert.deepEqual(store.readLegacyState(), validateLegacyState(f.state));
  assert.deepEqual(store.initializeEmptyLegacyState({ provider: 'extractive' }), validateLegacyState(f.state));
  assert.equal(store.readLegacyState().tasks[1].status, 'running', 'Only legacy server recovery may change old task states');
  store.close();
  store = f.store();
  assert.deepEqual(store.readLegacyState(), validateLegacyState(f.state));
  assert.equal(store.readLegacyState().futureBusiness.nested.revisions[1], 'v1');
  assert.deepEqual(store.readLegacyState().settings, { provider: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', model: 'gpt-6-luna' });
  const bytes = await readFile(f.databasePath);
  assert.ok(!bytes.includes(Buffer.from('SECRET_MUST_NOT_ENTER_SQLITE')));
  const empty = f.store(path.join(f.directory, 'explicitly-empty.sqlite'));
  empty.initializeEmptyLegacyState({ provider: 'openai', model: 'gpt-6-luna', apiKey: 'never' });
  assert.deepEqual(empty.readLegacyState(), { version: 1, tasks: [], knowledge: [], settings: { provider: 'openai', model: 'gpt-6-luna' } });
});

test('short synchronous transactions and nested savepoints roll back failures without touching the previous state', async t => {
  const f = await fixture(t); const store = f.store(); store.writeLegacyState(f.state);
  const before = store.readLegacyState();
  assert.throws(() => store.transaction(() => { const state = store.readLegacyState(); state.tasks[0].title = 'uncommitted'; store.writeLegacyState(state); throw new Error('stop'); }), /stop/);
  assert.deepEqual(store.readLegacyState(), before);
  assert.throws(() => store.transaction(() => Promise.resolve('not allowed')), /must not await/);
  assert.equal(store.db.isTransaction, false);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => { store.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('rolled_back', 'yes'); throw new Error('nested'); }), /nested/);
    store.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('kept', 'yes');
  });
  assert.equal(store.db.prepare("SELECT value FROM app_meta WHERE key='rolled_back'").get(), undefined);
  assert.equal(store.db.prepare("SELECT value FROM app_meta WHERE key='kept'").get().value, 'yes');
  assert.throws(() => store.db.prepare('INSERT INTO legacy_knowledge(id,task_id,payload_json) VALUES (?,?,?)').run('orphan', 'missing', '{}'), /FOREIGN KEY/);
});

test('explicit migration backs up unchanged source bytes and verifies IDs, body hashes, edits, history and ThinkFlow references', async t => {
  const f = await fixture(t);
  const result = await migrateWorkspace(f);
  assert.equal(result.status, 'migrated');
  assert.equal(result.sourceHash, sha256(f.bytes));
  assert.deepEqual(await readFile(f.sourcePath), f.bytes);
  assert.deepEqual(await readFile(result.sourceBackup), f.bytes);
  const store = f.store();
  assert.deepEqual(store.readLegacyState(), validateLegacyState(f.state));
  assert.deepEqual(result.verification, legacyManifest(f.state));
  assert.equal(store.db.prepare("SELECT value FROM app_meta WHERE key='migration_source_hash'").get().value, sha256(f.bytes));
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM app_meta WHERE key='migration_verification'").get().value), legacyManifest(f.state));
  assert.equal(inspectDatabase(store.db).tables.legacy_tasks.rows, 2);
});

test('same-source migration is verifiably idempotent; changed source or modified migrated data cannot overwrite it', async t => {
  const f = await fixture(t);
  await migrateWorkspace(f);
  const second = await migrateWorkspace(f);
  assert.equal(second.status, 'already_migrated');
  const store = f.store(); assert.equal(store.readLegacyState().tasks.length, 2);
  const changed = structuredClone(f.state); changed.tasks[0].sourceText += ' changed';
  await writeFile(f.sourcePath, JSON.stringify(changed));
  await assert.rejects(migrateWorkspace(f), /different source/);
  assert.equal(store.readLegacyState().tasks[0].sourceText, f.state.tasks[0].sourceText);
  await writeFile(f.sourcePath, f.bytes);
  const updated = store.readLegacyState(); updated.tasks[0].title = 'Post-migration edit'; store.writeLegacyState(updated);
  await assert.rejects(migrateWorkspace(f), /differs from the source/);
  assert.equal(store.readLegacyState().tasks[0].title, 'Post-migration edit');
});

test('invalid JSON structure, duplicate IDs, bad time and orphan links fail before creating a destination database', async t => {
  const f = await fixture(t);
  const variants = [
    { ...f.state, version: 2 },
    { ...f.state, tasks: [f.state.tasks[0], f.state.tasks[0]] },
    { ...f.state, tasks: f.state.tasks.map((task, index) => index ? task : { ...task, sourceText: 10 }) },
    { ...f.state, tasks: f.state.tasks.map((task, index) => index ? task : { ...task, createdAt: 'yesterday' }) },
    { ...f.state, knowledge: [{ ...f.state.knowledge[0], taskId: 'missing' }] },
    { ...f.state, tasks: f.state.tasks.map((task, index) => index ? task : { ...task, knowledgeId: 'missing' }) },
  ];
  for (const state of variants) {
    const source = JSON.stringify(state); await writeFile(f.sourcePath, source);
    await assert.rejects(migrateWorkspace(f), /Legacy workspace/);
    await assert.rejects(stat(f.databasePath), { code: 'ENOENT' });
    assert.equal(await readFile(f.sourcePath, 'utf8'), source);
  }
});

test('migration refuses initialized or new-feature data, while an uninitialized schema remains eligible', async t => {
  const f = await fixture(t); const store = f.store();
  assert.equal(store.readLegacyState(), null);
  assert.equal((await migrateWorkspace(f)).status, 'migrated');
  const initializedPath = path.join(f.directory, 'initialized.sqlite');
  const initialized = f.store(initializedPath); initialized.initializeEmptyLegacyState({});
  await assert.rejects(migrateWorkspace({ ...f, databasePath: initializedPath }), /explicitly initialized/);
  const capturePath = path.join(f.directory, 'capture.sqlite');
  const captureStore = f.store(capturePath);
  captureStore.db.exec("CREATE TABLE captures(id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT; INSERT INTO captures VALUES ('capture-1','原文');");
  await assert.rejects(migrateWorkspace({ ...f, databasePath: capturePath }), /business data/);
  assert.equal(captureStore.db.prepare('SELECT text FROM captures').get().text, '原文');
  assert.equal(captureStore.readLegacyState(), null);
});

test('a failed insert rolls back all migrated rows and success evidence in an existing uninitialized schema', async t => {
  const f = await fixture(t); const store = f.store();
  store.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON legacy_tasks BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;");
  await assert.rejects(migrateWorkspace(f), /forced import failure/);
  assert.equal(store.readLegacyState(), null);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM legacy_tasks').get().count, 0);
  assert.equal(store.db.prepare("SELECT value FROM app_meta WHERE key='migration_source_hash'").get(), undefined);
  assert.deepEqual(await readFile(f.sourcePath), f.bytes);
});

test('consistent live-WAL backup restores legacy references and new authenticated Capture data into a genuinely new directory', async t => {
  const f = await fixture(t); await migrateWorkspace(f); const store = f.store();
  store.db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE captures(id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT; CREATE TABLE device_verifiers(id TEXT PRIMARY KEY, hash TEXT NOT NULL) STRICT;");
  store.transaction(() => { store.db.prepare('INSERT INTO captures VALUES (?,?)').run('capture-original', '  断网后待发送的中文原文\n保留换行。'); store.db.prepare('INSERT INTO device_verifiers VALUES (?,?)').run('device-1', sha256('test-only-never-real')); });
  assert.ok((await stat(`${f.databasePath}-wal`)).size > 0, 'Exercise a real active WAL rather than copying a closed file');
  const result = await backupWorkspace({ store, backupDir: f.backupDir });
  assert.equal(result.manifest.database_sha256, sha256(await readFile(result.backupPath)));
  assert.equal(result.manifest.verification.tables.captures.rows, 1);
  assert.match(result.manifest.privacy, /authentication verifiers/);
  store.db.prepare('INSERT INTO captures VALUES (?,?)').run('after-backup', 'after snapshot');
  const databasePath = path.join(f.directory, 'restored-new-directory', 'restored.sqlite');
  const restored = await restoreWorkspace({ ...result, databasePath });
  assert.equal(restored.verified, true);
  const opened = f.store(databasePath);
  assert.deepEqual(opened.readLegacyState(), validateLegacyState(f.state));
  assert.equal(opened.db.prepare('SELECT count(*) AS count FROM captures').get().count, 1);
  assert.equal(opened.db.prepare('SELECT text FROM captures').get().text, '  断网后待发送的中文原文\n保留换行。');
  assert.equal(opened.db.prepare('SELECT hash FROM device_verifiers').get().hash, sha256('test-only-never-real'));
  opened.close();
  const reopened = f.store(databasePath);
  assert.equal(reopened.readLegacyState().knowledge[0].taskId, 'task-original');
  await assert.rejects(restoreWorkspace({ ...result, databasePath }), /already exists/);
  assert.equal(reopened.db.prepare('SELECT count(*) AS count FROM captures').get().count, 1);
});

test('backup manifest or file tampering fails closed and does not leave a restored database', async t => {
  const f = await fixture(t); const store = f.store(); store.writeLegacyState(f.state);
  const result = await backupWorkspace({ databasePath: f.databasePath, backupDir: f.backupDir });
  const original = await readFile(result.backupPath);
  await writeFile(result.backupPath, Buffer.concat([original, Buffer.from('tampered')]));
  const databasePath = path.join(f.directory, 'must-not-exist.sqlite');
  await assert.rejects(restoreWorkspace({ ...result, databasePath }), /hash verification failed/);
  await assert.rejects(stat(databasePath), { code: 'ENOENT' });
  await writeFile(result.backupPath, original);
  const alteredManifest = { ...result.manifest, verification: { ...result.manifest.verification, schema_sha256: '0'.repeat(64) } };
  await writeFile(result.manifestPath, JSON.stringify(alteredManifest));
  await assert.rejects(restoreWorkspace({ ...result, databasePath }), /contents no longer match/);
  await assert.rejects(stat(databasePath), { code: 'ENOENT' });
  assert.ok((await readdir(f.backupDir)).some(name => name.endsWith('.manifest.json')));
});

test('corrupt payload identity is rejected and private backup location must be explicit', async t => {
  const f = await fixture(t); const store = f.store(); store.writeLegacyState(f.state);
  const task = structuredClone(f.state.tasks[0]); task.id = 'mismatched';
  store.db.prepare('UPDATE legacy_tasks SET payload_json=? WHERE id=?').run(JSON.stringify(task), f.state.tasks[0].id);
  assert.throws(() => store.readLegacyState(), /does not match its payload/);
  await assert.rejects(backupWorkspace({ store, backupDir: f.backupDir }), /does not match its payload/);
  await assert.rejects(backupWorkspace({ store, backupDir: 'relative-directory' }), /explicit absolute private/);
  await assert.rejects(migrateWorkspace({ sourcePath: f.sourcePath, databasePath: path.join(f.directory, 'other.sqlite') }), /explicit absolute private/);
});

test('documented migration, live backup and new-path restore commands run without importing or modifying production data', async t => {
  const f = await fixture(t);
  const invoke = async args => {
    const { stdout } = await execute(process.execPath, args, { cwd: projectRoot, windowsHide: true });
    assert.doesNotMatch(stdout, /SECRET_MUST_NOT_ENTER_SQLITE|NEITHER_THIS_SECRET/);
    return JSON.parse(stdout);
  };
  const migration = await invoke(['scripts/migrate-workspace.mjs', '--source', f.sourcePath, '--database', f.databasePath, '--backup-dir', f.backupDir]);
  assert.equal(migration.status, 'migrated');
  const backup = await invoke(['scripts/backup-workspace.mjs', 'backup', '--database', f.databasePath, '--backup-dir', f.backupDir]);
  const databasePath = path.join(f.directory, 'cli-restored', 'workspace.sqlite');
  const restore = await invoke(['scripts/backup-workspace.mjs', 'restore', '--backup', backup.backupPath, '--database', databasePath]);
  assert.equal(restore.verified, true);
  assert.deepEqual(f.store(databasePath).readLegacyState(), validateLegacyState(f.state));
  assert.deepEqual(await readFile(f.sourcePath), f.bytes);
});
