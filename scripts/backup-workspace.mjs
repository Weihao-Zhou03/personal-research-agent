import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupWorkspace, restoreWorkspace } from '../lib/store/backup.mjs';

const usage = 'Usage:\n  node scripts/backup-workspace.mjs backup --database workspace.sqlite --backup-dir PRIVATE_DIRECTORY\n  node scripts/backup-workspace.mjs restore --backup BACKUP.sqlite --database NEW.sqlite [--manifest BACKUP.sqlite.manifest.json]\nOperational backups include authentication verifiers and must be stored privately. Windows ACLs are not enforced by Node. ThinkFlow files and external secrets are separate backups. Restore refuses any existing destination.';
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
  const command = args[0];
  if (!['backup', 'restore'].includes(command)) throw new Error(usage);
  const allowed = command === 'backup'
    ? { '--database': 'databasePath', '--backup-dir': 'backupDir' }
    : { '--backup': 'backupPath', '--database': 'databasePath', '--manifest': 'manifestPath' };
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = allowed[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || options[key]) throw new Error(usage);
    options[key] = path.resolve(args[index + 1]);
  }
  if (!options.databasePath || !(command === 'backup' ? options.backupDir : options.backupPath)) throw new Error(usage);
  const result = await (command === 'backup' ? backupWorkspace(options) : restoreWorkspace(options));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Backup/restore stopped: ${error.message}`); process.exitCode = 1; });
}
