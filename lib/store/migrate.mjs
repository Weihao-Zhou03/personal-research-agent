import { readFile, writeFile, open, unlink, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQLiteStore, validateLegacyState, legacyManifest, canonicalJSON, sha256 } from './sqlite.mjs';
import { privateDirectory, inspectDatabase } from './backup.mjs';

/** Explicit one-time import. Never invoked automatically by opening SQLiteStore. */
export async function migrateWorkspace({ sourcePath, databasePath, backupDir } = {}) {
  if (![sourcePath, databasePath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Migration requires explicit absolute source and database paths');
  sourcePath = path.resolve(sourcePath); databasePath = path.resolve(databasePath);
  if (sourcePath === databasePath) throw new Error('Source JSON and destination database must differ');
  const bytes = await readFile(sourcePath);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Legacy JSON is invalid; the source has not been modified'); }
  const state = validateLegacyState(parsed);
  const sourceHash = sha256(bytes);
  const expected = legacyManifest(state);
  const directory = await privateDirectory(backupDir);
  const sourceBackup = path.join(directory, `workspace-source-${sourceHash}-${randomUUID()}.json`);
  // Keep original bytes, including any old credential, only in explicitly selected private storage.
  await writeFile(sourceBackup, bytes, { flag: 'wx', mode: 0o600 });
  if (sha256(await readFile(sourceBackup)) !== sourceHash) throw new Error('Private source backup verification failed');
  let store;
  let created = false;
  try {
    // Reserve a new filename without replacing an existing database. Existing uninitialized
    // SQLiteStore schema is acceptable only after checking that it has no business rows.
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    try { const reservation = await open(databasePath, 'wx', 0o600); created = true; await reservation.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    store = new SQLiteStore({ filename: databasePath });
    const result = store.transaction(() => {
      const previous = store.db.prepare("SELECT value FROM app_meta WHERE key='migration_source_hash'").get()?.value;
      if (previous) {
        if (previous !== sourceHash) throw new Error('A different source was already migrated; refusing to overwrite');
        const evidence = JSON.parse(store.db.prepare("SELECT value FROM app_meta WHERE key='migration_verification'").get()?.value || 'null');
        if (canonicalJSON(evidence) !== canonicalJSON(expected) || canonicalJSON(legacyManifest(store.readLegacyState())) !== canonicalJSON(expected)) throw new Error('Existing migrated state differs from the source; refusing to overwrite or call it verified');
        inspectDatabase(store.db);
        if (sha256(readFileSync(sourcePath)) !== sourceHash) throw new Error('Source changed during migration verification; stop the old writer');
        return { status: 'already_migrated', sourceHash, verification: expected };
      }
      const businessTables = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('app_meta','legacy_state_meta')").all();
      for (const { name } of businessTables) {
        const identifier = `"${name.replaceAll('"', '""')}"`;
        if (store.db.prepare(`SELECT 1 FROM ${identifier} LIMIT 1`).get()) throw new Error('Destination already contains business data; refusing to overwrite');
      }
      if (store.readLegacyState()) throw new Error('Destination was explicitly initialized; migrate to a new empty path');
      store.writeLegacyState(state);
      const actual = legacyManifest(store.readLegacyState());
      if (canonicalJSON(actual) !== canonicalJSON(expected)) throw new Error('Imported legacy state failed content/count/link verification');
      inspectDatabase(store.db);
      const put = store.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)');
      put.run('migration_source_hash', sourceHash);
      put.run('migration_verification', JSON.stringify(actual));
      put.run('migration_source_path', sourcePath);
      put.run('migration_completed_at', new Date().toISOString());
      // The operator must stop the old writer. Also catch a change before COMMIT.
      if (sha256(readFileSync(sourcePath)) !== sourceHash) throw new Error('Source changed during migration; stop the old writer');
      return { status: 'migrated', sourceHash, verification: actual };
    });
    return { ...result, databasePath, sourceBackup };
  } catch (error) {
    store?.close(); store = undefined;
    if (created) for (const filename of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) await unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e; });
    throw error;
  } finally { store?.close(); }
}
