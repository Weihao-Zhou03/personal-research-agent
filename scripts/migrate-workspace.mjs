import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateWorkspace } from '../lib/store/migrate.mjs';

const usage = 'Usage: node scripts/migrate-workspace.mjs --source workspace.json --database NEW.sqlite --backup-dir PRIVATE_DIRECTORY\nStop all old workspace writers first. Source JSON is preserved; ThinkFlow files must be backed up separately. The backup directory contains private original data and must have restricted OS permissions.';
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
  const names = { '--source': 'sourcePath', '--database': 'databasePath', '--backup-dir': 'backupDir' };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || options[key]) throw new Error(usage);
    options[key] = path.resolve(args[index + 1]);
  }
  if (Object.keys(options).length !== 3) throw new Error(usage);
  const result = await migrateWorkspace(options);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Migration stopped: ${error.message}`); process.exitCode = 1; });
}
