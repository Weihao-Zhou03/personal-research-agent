import {parseArgs} from 'node:util';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
import {passwordHash} from '../lib/auth/security.mjs';

async function readPassword(fromStdin) {
  if(fromStdin) { let value='';for await(const part of process.stdin) { value+=part.toString();if(value.length>2048) throw new Error('Password input is too long'); }return value.replace(/\r?\n$/,''); }
  if(!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Use a private interactive terminal, or explicitly pipe a password with --password-stdin. Never pass it as a command argument.');
  process.stdout.write('Set administrator password (hidden, at least 12 characters): ');
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=> {
    let value='';
    function finish(error) { process.stdin.off('data',receive);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');if(error) reject(error);else resolve(value); }
    function receive(data) { for(const char of data) { if(char==='\u0003') return finish(new Error('Initialization cancelled'));if(char==='\r' || char==='\n') return finish();if(char==='\u007f' || char==='\b') value=[...value].slice(0,-1).join('');else value+=char;if(value.length>1024) return finish(new Error('Password is too long')); } }
    process.stdin.on('data',receive);
  });
}

const {values}=parseArgs({options:{'data-dir':{type:'string'},'password-stdin':{type:'boolean'},'workspace-name':{type:'string',default:'研究笔记'}}});
if(!values['data-dir']) throw new Error('Required: --data-dir <private data directory>. Production data is never selected implicitly.');
const dataDir=path.resolve(values['data-dir']);
if(existsSync(path.join(dataDir,'workspace.json')) && !existsSync(path.join(dataDir,'workspace.sqlite'))) throw new Error('MIGRATION_REQUIRED: stop the old writer and explicitly migrate JSON before initialization; no database was created');
const store=new SQLiteStore({filename:path.join(dataDir,'workspace.sqlite')});
try {
  if(existsSync(path.join(dataDir,'workspace.json'))) {
    const sourceHash=createHash('sha256').update(readFileSync(path.join(dataDir,'workspace.json'))).digest('hex');
    if(store.db.prepare("SELECT value FROM app_meta WHERE key='migration_source_hash'").get()?.value!==sourceHash) throw new Error('MIGRATION_REQUIRED: existing JSON does not match verified migration evidence; owner was not initialized');
  }
  if(!store.readLegacyState()) {
    if(existsSync(path.join(dataDir,'workspace.json'))) throw new Error('MIGRATION_REQUIRED: stop the old writer, back up files and explicitly migrate JSON before initialization');
    store.initializeEmptyLegacyState({provider:'extractive',baseUrl:'',model:''});
  }
  const service=new CaptureService(store);
  if(service.configured()) throw new Error('Owner is already initialized; the existing credential was not changed');
  const encoded=await passwordHash(await readPassword(values['password-stdin']));
  store.transaction(()=> {
    service.setPasswordHash(encoded);
    if(!service.workspaces().length) service.createWorkspace(values['workspace-name']);
  });
  console.log(`Owner initialized in ${dataDir}. Password and credentials were not printed.`);
} finally { store.close(); }
