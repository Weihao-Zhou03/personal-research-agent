import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual browser scripts. These synthetic DOM/network boundaries test races,
// not visual layout or browser/device compatibility.
const scripts = Object.fromEntries(['owner', 'research'].map(name => [name, readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8')]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const flush = async () => { for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ withOwner = false, fetchHook = () => undefined } = {}) {
  const nodes = new Map(), events = new Map(), calls = [];
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.value = ''; this.files = []; this.disabled = false; this.hidden = false; this.open = false; this.isConnected = true; this.ownText = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent ?? String(child)).join(''); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    append(...items) { this.children.push(...items); }
    prepend(...items) { this.children.unshift(...items); }
    replaceChildren(...items) { this.ownText = ''; this.children = items; }
    replaceWith() {}
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    fire(type) { return Promise.all((this.listeners.get(type) || []).map(listener => listener({ preventDefault() {} }))); }
    querySelectorAll() { return []; }
    reset() { for (const id of ['source-title', 'source-text', 'research-question', 'research-model-key', 'research-model-url', 'research-model-name', 'workspace-new-name']) get(id).value = ''; get('source-file-input').files = []; }
    focus() {}
    close() { this.open = false; }
    showModal() { this.open = true; }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const button = get('refresh-research'), form = new Node('form');
  const document = {
    visibilityState: 'visible', getElementById: get, createElement: tag => new Node(tag),
    querySelectorAll(selector) { if (selector === '.research-desk button') return [button]; if (selector === '.research-desk form') return [form]; return []; },
    addEventListener(type, listener) { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); },
    dispatchEvent(event) { for (const listener of events.get(event.type) || []) listener(event); return true; },
  };
  const fetch = async (url, options) => {
    calls.push({ url, options }); const overridden = fetchHook(url, options, calls);
    if (overridden !== undefined) return overridden;
    const route = url.split('?')[0];
    if (route.endsWith('/session') || route.endsWith('/login')) return response({ csrf_token: 'synthetic-csrf' });
    if (route.endsWith('/workspaces')) return response({ workspaces: [{ id: 'ws_fixture', name: 'SYNTHETIC_PRIVATE_WORKSPACE' }] });
    if (route.endsWith('/captures')) return response({ captures: [{ id: 'cap_fixture', workspace_id: 'ws_fixture', text: 'SYNTHETIC_PRIVATE_CAPTURE', index_status: 'indexed', accepted_at: '2026-10-21T00:00:00Z', created_at_client: '2026-10-21T00:00:00Z' }] });
    if (route.endsWith('/devices')) return response({ devices: [] });
    if (route.endsWith('/sources')) return response({ source_count: 0, corpus_revision_id: null, sync_status: 'never', sources: [] });
    if (route.endsWith('/jobs')) return response({ items: [], next_cursor: null });
    if (route.endsWith('/model')) return response({ configured: false, baseUrl: '', model: '', dailyLimit: 50, version: 'fixture', has_api_key: false });
    return response({});
  };
  class CustomEvent { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } }
  const context = vm.createContext({ document, fetch, CustomEvent, setTimeout, clearTimeout, crypto: globalThis.crypto, confirm: () => true });
  vm.runInContext(scripts.research, context);
  if (withOwner) vm.runInContext(scripts.owner, context);
  const dispatch = type => document.dispatchEvent(new CustomEvent(type));
  return { get, calls, dispatch, document };
}

test('UI logout prevents a delayed local file read from restoring private input', async () => {
  const ui = harness(); ui.dispatch('research:login'); await flush();
  const file = deferred(); ui.get('source-file-input').files = [{ name: 'synthetic-private.txt', size: 20, text: () => file.promise }];
  const importing = ui.get('source-file-input').fire('change');
  ui.dispatch('research:logout');
  file.resolve('SYNTHETIC_PRIVATE_FILE'); await importing;
  assert.equal(ui.get('source-text').value, ''); assert.equal(ui.get('source-title').value, '');
  assert.equal(ui.get('refresh-research').disabled, false);
});

test('UI research 401 expires the shared owner view and erases private DOM and form inputs', async () => {
  let unauthorized = false;
  const ui = harness({ withOwner: true, fetchHook: url => unauthorized && url.endsWith('/model') ? response({ error: { message: '请登录' } }, 401) : undefined });
  await flush();
  assert.ok(ui.get('capture-list').textContent.includes('SYNTHETIC_PRIVATE_CAPTURE'));
  ui.get('source-text').value = 'SYNTHETIC_PRIVATE_FILE'; ui.get('research-model-key').value = 'synthetic-private-key';
  ui.get('pair-name').textContent = 'SYNTHETIC_PRIVATE_DEVICE'; ui.get('default-workspace').append({ textContent: 'SYNTHETIC_PRIVATE_WORKSPACE' });
  unauthorized = true; await ui.get('refresh-research').fire('click'); await flush();
  assert.equal(ui.get('dashboard').hidden, true); assert.equal(ui.get('login-panel').hidden, false);
  assert.equal(ui.get('capture-list').textContent, ''); assert.equal(ui.get('pair-name').textContent, '');
  assert.equal(ui.get('default-workspace').textContent, ''); assert.equal(ui.get('source-text').value, '');
  assert.equal(ui.get('research-model-key').value, '');
});

test('UI late action completion cannot enable controls or clear a new session action', async () => {
  const ui = harness(); ui.dispatch('research:login'); await flush();
  const old = deferred(); ui.get('source-file-input').files = [{ name: 'old.txt', size: 20, text: () => old.promise }];
  const oldImport = ui.get('source-file-input').fire('change');
  ui.dispatch('research:logout'); ui.dispatch('research:login'); await flush();
  const current = deferred(); ui.get('source-file-input').files = [{ name: 'current.txt', size: 20, text: () => current.promise }];
  const newImport = ui.get('source-file-input').fire('change'); assert.equal(ui.get('refresh-research').disabled, true);
  old.resolve('OLD_PRIVATE_CONTENT'); await oldImport;
  assert.equal(ui.get('refresh-research').disabled, true); assert.equal(ui.get('source-text').value, '');
  current.resolve('CURRENT_PUBLIC_FIXTURE'); await newImport;
  assert.equal(ui.get('refresh-research').disabled, false); assert.equal(ui.get('source-text').value, 'CURRENT_PUBLIC_FIXTURE');
});

test('UI stale anonymous session response cannot sign out a later successful login', async () => {
  const initial = deferred(); let first = true;
  const ui = harness({ withOwner: true, fetchHook: url => { if (url.endsWith('/session') && first) { first = false; return initial.promise; } return undefined; } });
  ui.get('password').value = 'synthetic-password'; await ui.get('login-form').fire('submit'); await flush();
  assert.equal(ui.get('dashboard').hidden, false);
  initial.resolve(response({ error: { message: '旧会话无效' } }, 401)); await flush();
  assert.equal(ui.get('dashboard').hidden, false); assert.equal(ui.get('session-state').textContent, '管理员已登录');
  assert.ok(ui.get('capture-list').textContent.includes('SYNTHETIC_PRIVATE_CAPTURE'));
});

test('UI overlapping file read and space change retain control locks until both settle', async () => {
  const changedSources = deferred();
  const ui = harness({ fetchHook: url => url.includes('/workspaces/ws_changed/sources') ? changedSources.promise : undefined });
  ui.dispatch('research:login'); await flush();
  const file = deferred(); ui.get('source-file-input').files = [{ name: 'first-space.txt', size: 20, text: () => file.promise }];
  const importing = ui.get('source-file-input').fire('change');
  ui.get('research-workspace').value = 'ws_changed'; const changing = ui.get('research-workspace').fire('change');
  file.resolve('OLD_SPACE_SYNTHETIC_TEXT'); await importing;
  assert.equal(ui.get('refresh-research').disabled, true); assert.equal(ui.get('source-text').value, '');
  changedSources.resolve(response({ source_count: 0, corpus_revision_id: null, sync_status: 'never', sources: [] }));
  await changing; assert.equal(ui.get('refresh-research').disabled, false);
});

test('UI a newly-created owner space becomes selectable in the research panel without reloading', async () => {
  const spaces = [{ id: 'ws_fixture', name: '合成旧空间' }];
  const ui = harness({ withOwner: true, fetchHook: (url, options) => {
    if (!url.endsWith('/workspaces')) return undefined;
    if (options?.method === 'POST') { spaces.push({ id: 'ws_new', name: '合成新空间' }); return response(spaces.at(-1), 201); }
    return response({ workspaces: [...spaces] });
  } });
  await flush(); assert.equal(ui.get('research-workspace').children.length, 1);
  ui.get('space-name').value = '合成新空间'; await ui.get('space-form').fire('submit'); await flush();
  assert.equal(ui.get('research-workspace').children.length, 2);
  assert.ok(ui.get('research-workspace').children.some(option => option.value === 'ws_new'));
});

test('UI deletion erases owner raw text immediately and late old or failed refreshes cannot restore it', async () => {
  let deleted = false, holdOld = false;
  const oldCaptures = deferred(), newCaptures = deferred();
  const ui = harness({ withOwner: true, fetchHook: (url, options) => {
    if (url.endsWith('/workspaces/ws_fixture') && options?.method === 'DELETE') { deleted = true; return response({ status: 'deleted' }); }
    if (deleted && url.endsWith('/workspaces')) return response({ workspaces: [] });
    if (url.endsWith('/captures')) { if (deleted) return newCaptures.promise; if (holdOld) return oldCaptures.promise; }
    return undefined;
  } });
  await flush(); assert.ok(ui.get('capture-list').textContent.includes('SYNTHETIC_PRIVATE_CAPTURE'));
  holdOld = true; const oldRefresh = ui.get('refresh').fire('click');
  await ui.get('delete-research-workspace').fire('click');
  assert.equal(ui.get('capture-list').textContent, ''); assert.equal(ui.get('research-sources').textContent, '');
  oldCaptures.resolve(response({ captures: [{ id: 'old', workspace_id: 'ws_fixture', text: 'SYNTHETIC_PRIVATE_CAPTURE', index_status: 'indexed' }] }));
  await oldRefresh; assert.equal(ui.get('capture-list').textContent, '');
  newCaptures.resolve(response({ error: { message: '合成网络失败' } }, 503)); await flush();
  assert.equal(ui.get('capture-list').textContent, '');
});
