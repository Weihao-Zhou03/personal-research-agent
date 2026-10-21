import { open, lstat, readFile, writeFile, rename, unlink, readdir, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupWorkspace, inspectDatabase, privateDirectory } from '../lib/store/backup.mjs';
import { canonicalJSON, sha256 } from '../lib/store/sqlite.mjs';

const MANAGED_BY = 'personal-agent-scheduled-backup/v1';
const BACKUP_NAME = /^workspace-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[0-9a-f-]{36}\.sqlite$/;
const evidence = ({ schema_sha256, tables }) => canonicalJSON({ schema_sha256, tables });

async function regularInside(directory, filename) {
  const resolved = path.resolve(filename);
  if (path.dirname(resolved) !== path.resolve(directory)) throw new Error('Managed backup escaped its selected directory');
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || path.dirname(await realpath(resolved)) !== await realpath(directory)) throw new Error('Managed backup must be a regular file in its selected directory');
}

async function verifyPair(directory, manifestPath, { requireManaged = true } = {}) {
  await regularInside(directory, manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format_version !== 1 || typeof manifest.database_file !== 'string' || !BACKUP_NAME.test(manifest.database_file) || path.basename(manifestPath) !== `${manifest.database_file}.manifest.json` || !manifest.verification) throw new Error('Unknown backup manifest');
  if (requireManaged && (manifest.scheduled_backup?.managed_by !== MANAGED_BY || !/^[0-9a-f-]{36}$/.test(manifest.scheduled_backup?.run_id || '') || !Number.isFinite(Date.parse(manifest.scheduled_backup?.created_at)))) throw new Error('Not a scheduled managed backup');
  const backupPath = path.join(directory, manifest.database_file);
  await regularInside(directory, backupPath);
  if (manifest.database_sha256 !== sha256(await readFile(backupPath))) throw new Error('Managed backup content hash differs');
  const database = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (evidence(inspectDatabase(database)) !== evidence(manifest.verification)) throw new Error('Managed backup verification differs');
  } finally { database.close(); }
  return { backupPath, manifestPath, manifest };
}

/** Creates and verifies first. Retention never glob-deletes arbitrary databases or directories. */
export async function runScheduledBackup({ databasePath, backupDir, retain = 7, clock = () => Date.now(), backup = backupWorkspace } = {}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || !Number.isInteger(retain) || retain < 1 || retain > 365) throw new Error('Absolute database path and retention between 1 and 365 are required');
  const directory = await privateDirectory(backupDir), lockPath = path.join(directory, '.personal-agent-backup.lock');
  const runId = randomUUID(), createdAt = new Date(clock()).toISOString();
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A backup lock already exists; inspect the prior run before clearing its lock manually'); throw error; }
  const warnings = [];
  let result;
  try {
    await lock.writeFile(JSON.stringify({ managed_by: MANAGED_BY, run_id: runId, pid: process.pid, created_at: createdAt }));
    await lock.close(); lock = undefined;
    result = await backup({ databasePath, backupDir: directory });
    const verified = await verifyPair(directory, result.manifestPath, { requireManaged: false });
    if (path.resolve(result.backupPath) !== verified.backupPath) throw new Error('New backup paths do not match');
    verified.manifest.scheduled_backup = { managed_by: MANAGED_BY, run_id: runId, created_at: createdAt };
    const temporaryManifest = path.join(directory, `.scheduled-manifest-${runId}.tmp`);
    try {
      await writeFile(temporaryManifest, `${JSON.stringify(verified.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporaryManifest, verified.manifestPath);
      if (process.platform !== 'win32') await chmod(verified.manifestPath, 0o600);
    } finally { await unlink(temporaryManifest).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    await verifyPair(directory, verified.manifestPath);
    const previous = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.sqlite.manifest.json') || name === path.basename(verified.manifestPath)) continue;
      try { previous.push(await verifyPair(directory, path.join(directory, name))); }
      catch { warnings.push({ file: name, code: 'UNMANAGED_OR_UNVERIFIED_PRESERVED' }); }
    }
    previous.sort((a, b) => b.manifest.scheduled_backup.created_at.localeCompare(a.manifest.scheduled_backup.created_at) || b.manifest.database_file.localeCompare(a.manifest.database_file));
    const removed = [];
    for (const candidate of previous.slice(retain - 1)) {
      // Recheck the exact files after choosing retention; never follow a path from an unchecked manifest.
      try {
        await verifyPair(directory, candidate.manifestPath);
        await unlink(candidate.backupPath); await unlink(candidate.manifestPath);
        removed.push(candidate.manifest.database_file);
      } catch { warnings.push({ file: path.basename(candidate.manifestPath), code: 'RETENTION_NOT_REMOVED' }); }
    }
    return { backupPath: verified.backupPath, manifestPath: verified.manifestPath, verified: true, retained_limit: retain, removed, warnings, excludes: verified.manifest.excludes };
  } finally {
    await lock?.close();
    try {
      await regularInside(directory, lockPath);
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.run_id === runId && current.managed_by === MANAGED_BY) await unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') warnings.push({ code: 'LOCK_CLEANUP_REQUIRES_INSPECTION' }); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const usage = 'Usage: node scripts/backup-scheduled.mjs --database ABSOLUTE.sqlite --backup-dir ABSOLUTE_PRIVATE_DIR [--retain 7]\nPrivate full SQLite backup, not a public business export. ThinkFlow files and external secrets require separate backup.';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
  const options = {}, keys = { '--database': 'databasePath', '--backup-dir': 'backupDir', '--retain': 'retain' };
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]], value = args[index + 1];
    if (!key || !value || value.startsWith('--') || options[key] !== undefined) throw new Error(usage);
    options[key] = key === 'retain' ? Number(value) : value;
  }
  console.log(JSON.stringify(await runScheduledBackup(options), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Scheduled backup stopped: ${error.message}`); process.exitCode = 1; });
