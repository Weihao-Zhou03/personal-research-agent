import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {SQLiteStore} from '../lib/store/sqlite.mjs';
import {CaptureService} from '../lib/auth/capture-service.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),password='initializer-fixture-only';
const run=(dir,extra=[])=>spawnSync(process.execPath,['scripts/init-owner.mjs','--data-dir',dir,'--password-stdin',...extra],{cwd:root,input:password+'\n',encoding:'utf8',timeout:10000});
async function directory(t) {const dir=await mkdtemp(path.join(tmpdir(),'pa-init-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('Owner initialization refuses unverified old JSON before creating a database or accepting credentials',async t=> {
  const dir=await directory(t),filename=path.join(dir,'workspace.json'),original='{"version":1,"tasks":[],"knowledge":[],"settings":{}}';
  await writeFile(filename,original);const result=run(dir);
  assert.notEqual(result.status,0);assert.match(result.stderr,/MIGRATION_REQUIRED/);assert.equal(existsSync(path.join(dir,'workspace.sqlite')),false);assert.equal(await readFile(filename,'utf8'),original);
});
test('Owner initialization is private and refuses repeat or failed partial initialization',async t=> {
  const dir=await directory(t),failed=run(dir,['--workspace-name','']);assert.notEqual(failed.status,0);
  const check=new SQLiteStore({filename:path.join(dir,'workspace.sqlite')});assert.equal(new CaptureService(check).configured(),false);check.close();
  const initialized=run(dir);assert.equal(initialized.status,0,initialized.stderr);assert.doesNotMatch(initialized.stdout+initialized.stderr,new RegExp(password));
  const store=new SQLiteStore({filename:path.join(dir,'workspace.sqlite')}),service=new CaptureService(store),hash=service.meta('owner_password_hash');
  assert.equal(service.workspaces().length,1);assert.notEqual(hash,password);store.close();
  const repeated=run(dir);assert.notEqual(repeated.status,0);assert.match(repeated.stderr,/already initialized/);
  const restored=new SQLiteStore({filename:path.join(dir,'workspace.sqlite')});assert.equal(new CaptureService(restored).meta('owner_password_hash'),hash);restored.close();
});
