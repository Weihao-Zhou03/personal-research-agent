import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Legacy workspace: ${message}`); };
const statuses = new Set(['draft', 'queued', 'running', 'completed', 'failed', 'cancelled']);
const kinds = new Set(['study', 'research', 'organize']);
function text(value, label, { nonempty = false } = {}) {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(`${label} must be ${nonempty ? 'nonempty ' : ''}text`);
}
function time(value, label) {
  text(value, label, { nonempty: true });
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO 8601 timestamp`);
}
function optionalTime(record, key, label) { if (record[key] !== undefined) time(record[key], `${label}.${key}`); }

/** Preserve all JSON business fields; credentials are never accepted in settings. */
export function validateLegacyState(input) {
  if (!object(input) || input.version !== 1 || !Array.isArray(input.tasks) || !Array.isArray(input.knowledge)) fail('version 1, tasks and knowledge arrays are required');
  if (input.settings !== undefined && !object(input.settings)) fail('settings must be an object');
  const state = structuredClone(input);
  state.settings = {};
  for (const key of ['provider', 'baseUrl', 'model']) {
    if (input.settings?.[key] !== undefined) { text(input.settings[key], `settings.${key}`); state.settings[key] = input.settings[key]; }
  }
  const tasks = new Map();
  for (const task of state.tasks) {
    if (!object(task)) fail('task must be an object');
    text(task.id, 'task.id', { nonempty: true });
    if (tasks.has(task.id)) fail('duplicate task ID');
    tasks.set(task.id, task);
    for (const key of ['title', 'instruction', 'sourceText']) text(task[key], `task.${key}`);
    if (!kinds.has(task.kind) || !statuses.has(task.status)) fail('unrecognized task kind or status');
    time(task.createdAt, 'task.createdAt'); time(task.updatedAt, 'task.updatedAt');
    if (!Array.isArray(task.sources) || !Array.isArray(task.conversation) || !Array.isArray(task.events)) fail('task sources, conversation and events must be arrays');
    for (const source of task.sources) {
      if (!object(source)) fail('source must be an object');
      text(source.title, 'source.title'); text(source.url, 'source.url');
    }
    if (task.result !== null && task.result !== undefined) {
      if (!object(task.result)) fail('task.result must be an object or null');
      text(task.result.markdown, 'task.result.markdown', { nonempty: true });
      optionalTime(task.result, 'createdAt', 'task.result'); optionalTime(task.result, 'editedAt', 'task.result');
    }
    for (const item of task.conversation) {
      if (!object(item)) fail('conversation entry must be an object');
      text(item.question, 'conversation.question'); text(item.answer, 'conversation.answer');
      time(item.createdAt, 'conversation.createdAt');
    }
    for (const item of task.events) {
      if (!object(item)) fail('event must be an object');
      time(item.at, 'event.at'); text(item.status, 'event.status'); text(item.message, 'event.message');
    }
    if (task.writebackIntent !== undefined) {
      if (!object(task.writebackIntent)) fail('writebackIntent must be an object');
      text(task.writebackIntent.content, 'writebackIntent.content', { nonempty: true });
      time(task.writebackIntent.confirmedAt, 'writebackIntent.confirmedAt');
    }
  }
  const knowledge = new Map();
  for (const entry of state.knowledge) {
    if (!object(entry)) fail('knowledge entry must be an object');
    text(entry.id, 'knowledge.id', { nonempty: true }); text(entry.taskId, 'knowledge.taskId', { nonempty: true });
    if (knowledge.has(entry.id)) fail('duplicate knowledge ID');
    knowledge.set(entry.id, entry);
    text(entry.title, 'knowledge.title'); text(entry.content, 'knowledge.content', { nonempty: true });
    time(entry.createdAt, 'knowledge.createdAt');
    if (!tasks.has(entry.taskId) || tasks.get(entry.taskId).knowledgeId !== entry.id) fail('knowledge/task association is not bidirectional');
  }
  for (const task of tasks.values()) {
    if (task.knowledgeId !== null && task.knowledgeId !== undefined) {
      text(task.knowledgeId, 'task.knowledgeId', { nonempty: true });
      if (!knowledge.has(task.knowledgeId) || knowledge.get(task.knowledgeId).taskId !== task.id) fail('task/knowledge association is not bidirectional');
    }
  }
  return state;
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function legacyManifest(state) {
  const sanitized = validateLegacyState(state);
  return { tasks: sanitized.tasks.length, knowledge: sanitized.knowledge.length, state_sha256: sha256(canonicalJSON(sanitized)) };
}

/** Decode and validate in an existing snapshot/transaction (also used by backup verification). */
export function readLegacySnapshot(db) {
  if (!db.prepare("SELECT 1 FROM legacy_state_meta WHERE key = 'state'").get()) {
    if (db.prepare('SELECT 1 FROM legacy_tasks LIMIT 1').get() || db.prepare('SELECT 1 FROM legacy_knowledge LIMIT 1').get()) fail('legacy rows exist without initialized state metadata');
    return null;
  }
  const state = JSON.parse(db.prepare("SELECT value_json FROM legacy_state_meta WHERE key = 'state'").get().value_json);
  const taskOrder = JSON.parse(db.prepare("SELECT value_json FROM legacy_state_meta WHERE key = 'task_order'").get()?.value_json || 'null');
  const knowledgeOrder = JSON.parse(db.prepare("SELECT value_json FROM legacy_state_meta WHERE key = 'knowledge_order'").get()?.value_json || 'null');
  if (!object(state) || !Array.isArray(taskOrder) || !Array.isArray(knowledgeOrder)) fail('stored root/order metadata is invalid');
  const tasks = new Map(db.prepare('SELECT id, payload_json FROM legacy_tasks').all().map(row => {
    const task = JSON.parse(row.payload_json);
    if (!object(task) || task.id !== row.id) fail('stored task ID does not match its payload');
    return [row.id, task];
  }));
  const knowledge = new Map(db.prepare('SELECT id, task_id, payload_json FROM legacy_knowledge').all().map(row => {
    const entry = JSON.parse(row.payload_json);
    if (!object(entry) || entry.id !== row.id) fail('stored knowledge ID does not match its payload');
    if (entry.taskId !== row.task_id) fail('stored knowledge task ID does not match its payload');
    return [row.id, entry];
  }));
  if (taskOrder.length !== tasks.size || knowledgeOrder.length !== knowledge.size || new Set(taskOrder).size !== tasks.size || new Set(knowledgeOrder).size !== knowledge.size) fail('stored collection order is inconsistent');
  state.tasks = taskOrder.map(id => tasks.get(id)); state.knowledge = knowledgeOrder.map(id => knowledge.get(id));
  return validateLegacyState(state);
}

export class SQLiteStore {
  constructor({ filename } = {}) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:') throw new Error('SQLiteStore requires an explicit file path');
    this.filename = path.resolve(filename);
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const existed = existsSync(this.filename);
    this.db = new DatabaseSync(this.filename);
    try {
      const version = this.db.prepare('SELECT sqlite_version() AS version').get().version;
      const [major, minor, patch] = version.split('.').map(Number);
      // The WAL-reset corruption fix landed in 3.51.3 (and newer releases).
      if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) throw new Error('SQLite 3.51.3 or newer is required for WAL safety');
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS legacy_state_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json))) STRICT;
        CREATE TABLE IF NOT EXISTS legacy_tasks (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))) STRICT;
        CREATE TABLE IF NOT EXISTS legacy_knowledge (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES legacy_tasks(id), payload_json TEXT NOT NULL CHECK(json_valid(payload_json))) STRICT;
      `);
      if (!existed && process.platform !== 'win32') chmodSync(this.filename, 0o600);
      this.savepoint = 0;
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction requires a synchronous function');
    if (fn.constructor.name === 'AsyncFunction') throw new TypeError('SQLite transactions must not await external work');
    const nested = this.db.isTransaction;
    const savepoint = `legacy_sp_${++this.savepoint}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transactions must not await external work');
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  }

  readLegacyState() {
    if (!this.db.isTransaction) return this.transaction(() => this.readLegacyState());
    return readLegacySnapshot(this.db);
  }

  writeLegacyState(input) {
    const state = validateLegacyState(input);
    return this.transaction(() => {
      this.db.exec('DELETE FROM legacy_knowledge; DELETE FROM legacy_tasks;');
      const putTask = this.db.prepare('INSERT INTO legacy_tasks(id, payload_json) VALUES (?, ?)');
      const putKnowledge = this.db.prepare('INSERT INTO legacy_knowledge(id, task_id, payload_json) VALUES (?, ?, ?)');
      for (const task of state.tasks) putTask.run(task.id, JSON.stringify(task));
      for (const entry of state.knowledge) putKnowledge.run(entry.id, entry.taskId, JSON.stringify(entry));
      const putMeta = this.db.prepare('INSERT INTO legacy_state_meta(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json');
      const { tasks, knowledge, ...rest } = state;
      putMeta.run('state', JSON.stringify(rest));
      putMeta.run('task_order', JSON.stringify(tasks.map(task => task.id)));
      putMeta.run('knowledge_order', JSON.stringify(knowledge.map(entry => entry.id)));
      return state;
    });
  }

  initializeEmptyLegacyState(defaults = {}) {
    return this.transaction(() => {
      const state = this.readLegacyState();
      if (state) return state;
      if (this.db.prepare('SELECT 1 FROM legacy_tasks LIMIT 1').get() || this.db.prepare('SELECT 1 FROM legacy_knowledge LIMIT 1').get()) fail('uninitialized store already contains legacy rows');
      return this.writeLegacyState({ version: 1, tasks: [], knowledge: [], settings: defaults });
    });
  }

  close() { this.db.close(); }
}
