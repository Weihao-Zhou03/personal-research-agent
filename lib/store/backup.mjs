import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, writeFile, readFile, chmod, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, sha256, readLegacySnapshot } from './sqlite.mjs';

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
function serializable(value) {
  if (typeof value === 'bigint') return { sqlite_bigint: String(value) };
  if (value instanceof Uint8Array) return { sqlite_blob_hex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serializable(entry)]));
  return value;
}

/** Full integrity and content evidence, including auth tables without exposing values. */
export function inspectDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('SQLite integrity_check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign_key_check failed');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legacy_state_meta'").get()) readLegacySnapshot(db);
  const tables = Object.create(null);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const query = db.prepare(`SELECT * FROM ${quote(name)}`);
    query.setReadBigInts(true);
    const rows = query.all().map(row => canonicalJSON(serializable(row))).sort();
    tables[name] = { rows: rows.length, sha256: sha256(rows.join('\n')) };
  }
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return { sqlite_version: db.prepare('SELECT sqlite_version() AS version').get().version, schema_sha256: sha256(canonicalJSON(schema)), tables };
}

export async function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An explicit absolute private backup directory is required');
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  // Do not silently rewrite permissions on a user-provided existing directory.
  // Node cannot inspect/enforce Windows ACLs; the operator must select private storage.
  if (process.platform !== 'win32' && ((await stat(resolved)).mode & 0o077)) throw new Error('Backup directory must have no group/other permissions (chmod 700 the selected private directory)');
  return resolved;
}

async function ownerOnly(filename) { if (process.platform !== 'win32') await chmod(filename, 0o600); }
async function absent(filename) {
  try { await stat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Restore destination already exists; restore only to a new path');
}
async function removeCreated(filename) {
  for (const item of [filename, `${filename}-wal`, `${filename}-shm`]) await unlink(item).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export async function backupWorkspace({ store, databasePath, backupDir } = {}) {
  if ((!store && !databasePath) || (store && databasePath)) throw new Error('Provide exactly one of store or databasePath');
  const directory = await privateDirectory(backupDir);
  const filename = `workspace-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`;
  const backupPath = path.join(directory, filename);
  const manifestPath = `${backupPath}.manifest.json`;
  let source;
  let snapshot;
  try {
    source = store?.db || new DatabaseSync(path.resolve(databasePath), { readOnly: true });
    if (source.isTransaction) throw new Error('Finish the current transaction before starting backup');
    // The supported backup API captures the live database including WAL transactions.
    await backup(source, backupPath);
    await ownerOnly(backupPath);
    snapshot = new DatabaseSync(backupPath, { readOnly: true });
    const verification = inspectDatabase(snapshot);
    snapshot.close(); snapshot = undefined;
    const manifest = {
      format_version: 1, created_at: new Date().toISOString(), database_file: filename,
      database_sha256: sha256(await readFile(backupPath)), verification,
      privacy: 'Private operational backup: includes authentication verifiers and any unexpired pairing/session records. Not a public business export. Windows ACLs must be configured by the operator.',
      excludes: ['ThinkFlow original files and versions', 'externally managed model/provider secrets'],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { backupPath, manifestPath, manifest };
  } catch (error) {
    snapshot?.close();
    await removeCreated(backupPath);
    await unlink(manifestPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    throw error;
  } finally { if (!store) source?.close(); }
}

export async function restoreWorkspace({ backupPath, manifestPath = backupPath ? `${backupPath}.manifest.json` : undefined, databasePath } = {}) {
  if (![backupPath, manifestPath, databasePath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Restore requires absolute backup, manifest and new database paths');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format_version !== 1 || manifest.database_file !== path.basename(backupPath) || !manifest.verification || manifest.database_sha256 !== sha256(await readFile(backupPath))) throw new Error('Backup manifest/hash verification failed');
  const destination = path.resolve(databasePath);
  for (const candidate of [destination, `${destination}-wal`, `${destination}-shm`]) await absent(candidate);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let source;
  let restored;
  let created = false;
  try {
    source = new DatabaseSync(backupPath, { readOnly: true });
    const contentEvidence = ({ schema_sha256, tables }) => canonicalJSON({ schema_sha256, tables });
    if (contentEvidence(inspectDatabase(source)) !== contentEvidence(manifest.verification)) throw new Error('Backup contents no longer match its verification manifest');
    const reservation = await open(destination, 'wx', 0o600); created = true; await reservation.close();
    await backup(source, destination);
    await ownerOnly(destination);
    restored = new DatabaseSync(destination, { readOnly: true });
    const verification = inspectDatabase(restored);
    if (contentEvidence(verification) !== contentEvidence(manifest.verification)) throw new Error('Restored database verification failed');
    if (manifest.database_sha256 !== sha256(await readFile(backupPath))) throw new Error('Backup changed during restore');
    restored.close(); restored = undefined;
    return { databasePath: destination, verified: true, verification };
  } catch (error) {
    restored?.close();
    if (created) await removeCreated(destination);
    throw error;
  } finally { source?.close(); }
}
