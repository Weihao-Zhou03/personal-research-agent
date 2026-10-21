import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function processor(overrides = {}) {
  return {
    async processTask() {
      return { markdown: '# 学习总结\n\n牛顿第二定律：F = ma。', mode: 'extractive', model: 'test' };
    },
    async answerQuestion(_task, question) {
      return { answer: `根据任务资料回答：${question}`, mode: 'extractive' };
    },
    async testConnection() { return { ok: true, model: 'test' }; },
    ...overrides,
  };
}

async function fixture(t, mock = processor()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'personal-agent-test-'));
  const apps = new Set();
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function start() {
    const app = await createApp({ dataDir, processor: mock });
    apps.add(app);
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => {
        app.server.off('error', reject);
        resolve();
      });
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function request(route, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(method === 'GET' ? {} : { Origin: base }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* Static files need not be JSON. */ }
      return { status: response.status, ok: response.ok, body: parsed, text, headers: response.headers };
    }
    return {
      request,
      async close() {
        await app.close();
        apps.delete(app);
      },
    };
  }

  return { dataDir, start };
}

function assertSuccess(response) {
  assert.ok(response.ok, `Expected success, got ${response.status}: ${response.text}`);
}

function assertClientError(response) {
  assert.ok(response.status >= 400 && response.status < 500,
    `Expected a client error, got ${response.status}: ${response.text}`);
  assert.equal(typeof response.body.error, 'string');
  assert.ok(response.body.error.length > 0);
}

async function createTask(client, overrides = {}) {
  const response = await client.request('/api/tasks', {
    method: 'POST',
    body: {
      title: '物理课复习', kind: 'study', instruction: '整理结论和待研究问题',
      sourceText: '牛顿第二定律描述合外力与质量、加速度的关系：F = ma。',
      sources: [{ title: '课程资料', url: 'https://example.com/physics' }],
      ...overrides,
    },
  });
  assertSuccess(response);
  assert.equal(response.body.status, 'draft');
  assert.equal(typeof response.body.id, 'string');
  return response.body;
}

async function getState(client) {
  const response = await client.request('/api/state');
  assertSuccess(response);
  assert.ok(Array.isArray(response.body.tasks));
  assert.ok(Array.isArray(response.body.knowledge));
  assert.equal(typeof response.body.settings, 'object');
  return response.body;
}

async function waitForTask(client, id, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = (await getState(client)).tasks.find(task => task.id === id);
    if (last && predicate(last)) return last;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Task ${id} did not reach the expected state; last value: ${JSON.stringify(last)}`);
}

async function fileContents(directory) {
  const contents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await fileContents(filename));
    else if (entry.isFile()) contents.push(await readFile(filename, 'utf8'));
  }
  return contents;
}

test('a confirmed draft completes, can be edited, archived, exported, and restored', async t => {
  let processCalls = 0;
  const setup = await fixture(t, processor({
    async processTask(task) {
      processCalls += 1;
      assert.equal(task.title, '物理课复习');
      return { markdown: '# 初稿\n\nF = ma。', mode: 'extractive', model: 'test' };
    },
  }));
  let client = await setup.start();
  const task = await createTask(client);
  assert.equal(processCalls, 0, 'Creating a draft must not process it before confirmation.');

  assertSuccess(await client.request(`/api/tasks/${task.id}/run`, { method: 'POST', body: {} }));
  const completed = await waitForTask(client, task.id, task => task.status === 'completed');
  assert.equal(completed.result.markdown, '# 初稿\n\nF = ma。');
  assert.equal(processCalls, 1);

  const edited = '# 已核对的总结\n\n合外力 F = ma。\n\n待研究：质量如何测量？';
  assertSuccess(await client.request(`/api/tasks/${task.id}/result`, {
    method: 'PUT', body: { markdown: edited },
  }));
  assert.equal((await getState(client)).tasks.find(item => item.id === task.id).result.markdown, edited);

  const answer = await client.request(`/api/tasks/${task.id}/ask`, {
    method: 'POST', body: { question: '公式中的 m 是什么？' },
  });
  assertSuccess(answer);
  assert.match(answer.body.answer, /公式中的 m/);
  assert.equal(typeof answer.body.mode, 'string');

  const archived = await client.request(`/api/tasks/${task.id}/archive`, { method: 'POST', body: {} });
  assertSuccess(archived);
  assert.equal(typeof archived.body.id, 'string');
  assert.equal(archived.body.content, edited, 'Archive should contain the latest edited result.');
  const state = await getState(client);
  assert.equal(state.knowledge.length, 1);
  assert.ok(JSON.stringify(state.knowledge[0]).includes('https://example.com/physics'),
    'Knowledge must retain its source provenance.');

  const exported = await client.request('/api/export');
  assertSuccess(exported);
  assert.ok(exported.text.includes(task.id));
  assert.ok(exported.text.includes(archived.body.id));
  assert.ok(exported.text.includes('已核对的总结'));

  await client.close();
  client = await setup.start();
  const restored = await getState(client);
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].id, task.id);
  assert.equal(restored.tasks[0].result.markdown, edited);
  assert.equal(restored.knowledge.length, 1);
  assert.equal(restored.knowledge[0].id, archived.body.id);
  assert.equal(processCalls, 1, 'Restarting must not re-run completed tasks.');
});

test('a failed follow-up preserves an actionable processor error and releases the task for retry', async t => {
  const message = '本地 Ollama 的整个请求超过 6,500 字符预算，请缩短或拆分任务；不会自动截断。';
  let attempts = 0;
  const setup = await fixture(t, processor({
    async answerQuestion(_task, question) {
      attempts += 1;
      if (attempts === 1) throw new Error(message);
      return { answer: `已重新处理：${question}`, mode: 'ai' };
    },
  }));
  const client = await setup.start();
  const task = await createTask(client);
  assertSuccess(await client.request(`/api/tasks/${task.id}/run`, { method: 'POST', body: {} }));
  await waitForTask(client, task.id, task => task.status === 'completed');

  const failed = await client.request(`/api/tasks/${task.id}/ask`, {
    method: 'POST', body: { question: '第一次追问' },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, message);
  const afterFailure = (await getState(client)).tasks.find(item => item.id === task.id);
  assert.equal(afterFailure.status, 'completed');
  assert.deepEqual(afterFailure.conversation, [], 'Failed follow-ups must not append conversation entries.');

  const retried = await client.request(`/api/tasks/${task.id}/ask`, {
    method: 'POST', body: { question: '缩短后的追问' },
  });
  assertSuccess(retried);
  assert.equal(retried.body.answer, '已重新处理：缩短后的追问');
  assert.equal(attempts, 2, 'A failed operation must release the in-progress follow-up guard.');
  const afterRetry = (await getState(client)).tasks.find(item => item.id === task.id);
  assert.equal(afterRetry.conversation.length, 1);
  assert.equal(afterRetry.conversation[0].question, '缩短后的追问');
  assert.equal(afterRetry.conversation[0].answer, retried.body.answer);
});

test('cancellation wins when a processor finishes after it has been cancelled', async t => {
  const started = deferred();
  const finish = deferred();
  t.after(() => finish.resolve());
  const setup = await fixture(t, processor({
    async processTask() {
      started.resolve();
      // Deliberately ignore AbortSignal to exercise the server's stale-result guard.
      await finish.promise;
      return { markdown: 'This late result must be discarded.', mode: 'extractive' };
    },
  }));
  const client = await setup.start();
  const task = await createTask(client);
  assertSuccess(await client.request(`/api/tasks/${task.id}/run`, { method: 'POST', body: {} }));
  await Promise.race([
    started.promise,
    delay(3000).then(() => assert.fail('The processor did not start.')),
  ]);
  assertSuccess(await client.request(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: {} }));
  const cancelled = await waitForTask(client, task.id, task => task.status === 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
  finish.resolve();
  await delay(100);
  const final = (await getState(client)).tasks.find(item => item.id === task.id);
  assert.equal(final.status, 'cancelled');
  assert.ok(!JSON.stringify(final).includes('This late result must be discarded.'));
});

test('API keys stay in memory and never appear in responses, exports, or persisted files', async t => {
  const secret = `test-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let observedKey;
  const setup = await fixture(t, processor({
    async testConnection(settings) {
      observedKey = settings.apiKey;
      return { ok: true, model: 'test-model' };
    },
  }));
  let client = await setup.start();
  const saved = await client.request('/api/settings', {
    method: 'POST',
    body: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: secret },
  });
  assertSuccess(saved);
  assert.ok(!saved.text.includes(secret));
  const connection = await client.request('/api/settings/test', { method: 'POST', body: {} });
  assertSuccess(connection);
  assert.equal(observedKey, secret, 'The configured key must be available to the processor in memory.');
  assert.ok(!connection.text.includes(secret));
  assert.ok(!JSON.stringify(await getState(client)).includes(secret));
  assert.ok(!(await client.request('/api/export')).text.includes(secret));
  for (const contents of await fileContents(setup.dataDir)) assert.ok(!contents.includes(secret));

  await client.close();
  client = await setup.start();
  assert.ok(!JSON.stringify(await getState(client)).includes(secret));
  observedKey = undefined;
  // The endpoint may reject a missing key before invoking the mock, or may invoke it without one.
  await client.request('/api/settings/test', { method: 'POST', body: {} });
  assert.notEqual(observedKey, secret, 'A restart must not recover the previous in-memory API key.');
});

test('invalid input and operations without a result return useful client errors', async t => {
  const setup = await fixture(t);
  const client = await setup.start();
  assertClientError(await client.request('/api/tasks', {
    method: 'POST', body: { title: '   ', kind: 'study', instruction: 'Summarize these notes', sourceText: 'Notes', sources: [] },
  }));
  assertClientError(await client.request('/api/tasks', {
    method: 'POST', body: { title: 'Missing instruction', kind: 'study', instruction: '   ', sourceText: 'Notes' },
  }));
  assertClientError(await client.request('/api/tasks', {
    method: 'POST', body: { title: 'Invalid kind', kind: 'unsupported', instruction: 'Summarize', sourceText: 'some material' },
  }));
  const task = await createTask(client);
  assertClientError(await client.request(`/api/tasks/${task.id}/archive`, { method: 'POST', body: {} }));
  assertClientError(await client.request(`/api/tasks/${task.id}/result`, { method: 'PUT', body: { markdown: '# premature' } }));
  assertClientError(await client.request(`/api/tasks/${task.id}/ask`, { method: 'POST', body: { question: '   ' } }));
  assertClientError(await client.request('/api/tasks/missing-task/run', { method: 'POST', body: {} }));

  assertSuccess(await client.request(`/api/tasks/${task.id}/run`, { method: 'POST', body: {} }));
  await waitForTask(client, task.id, task => task.status === 'completed');
  assertClientError(await client.request(`/api/tasks/${task.id}/archive`, { method: 'POST', body: { content: '' } }));
  assert.equal((await getState(client)).knowledge.length, 0);
});

test('interrupted tasks are restored as retryable failures without silently running', async t => {
  let calls = 0;
  const setup = await fixture(t, processor({
    async processTask() {
      calls += 1;
      return { markdown: '# 重试完成', mode: 'extractive' };
    },
  }));
  let client = await setup.start();
  const first = await createTask(client, { title: 'Interrupted running task' });
  const second = await createTask(client, { title: 'Interrupted queued task' });
  await client.close();

  // Model a process exit that happened before an orderly shutdown could save state.
  const stateFile = path.join(setup.dataDir, 'workspace.json');
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  persisted.tasks.find(task => task.id === first.id).status = 'running';
  persisted.tasks.find(task => task.id === second.id).status = 'queued';
  await writeFile(stateFile, JSON.stringify(persisted), 'utf8');

  client = await setup.start();
  const recovered = await getState(client);
  assert.equal(recovered.tasks.length, 2);
  for (const task of recovered.tasks) {
    assert.equal(task.status, 'failed');
    assert.equal(typeof task.error, 'string');
    assert.ok(task.error.length > 0);
  }
  assert.equal(calls, 0, 'Recovering interrupted tasks must require a new user confirmation.');
  assertSuccess(await client.request(`/api/tasks/${first.id}/run`, { method: 'POST', body: {} }));
  const retried = await waitForTask(client, first.id, task => task.status === 'completed');
  assert.equal(retried.result.markdown, '# 重试完成');
  assert.equal(calls, 1);
});

test('cross-origin writes are refused and static traversal cannot expose private data', async t => {
  const setup = await fixture(t);
  const client = await setup.start();
  const malicious = await client.request('/api/tasks', {
    method: 'POST', headers: { Origin: 'http://evil.test' },
    body: { title: 'unwanted task', kind: 'study', sourceText: 'unwanted' },
  });
  assert.equal(malicious.status, 403);
  assertClientError(malicious);
  assert.equal((await getState(client)).tasks.length, 0);

  const marker = 'PRIVATE_DATA_MUST_NOT_BE_SERVED_7959a361';
  const privateFile = path.join(setup.dataDir, 'private-marker.txt');
  await mkdir(setup.dataDir, { recursive: true });
  await writeFile(privateFile, marker, 'utf8');
  const relative = path.relative(path.join(projectRoot, 'public'), privateFile).replaceAll('\\', '/');
  const probes = [
    '/data/private-marker.txt',
    `/${encodeURIComponent(relative)}`,
    `/${relative.split('/').map(segment => segment === '..' ? '%2e%2e' : encodeURIComponent(segment)).join('%2f')}`,
    `/${encodeURIComponent(privateFile)}`,
  ];
  for (const route of probes) {
    const response = await client.request(route);
    assert.ok(!response.text.includes(marker), `Static traversal exposed private data via ${route}`);
    assert.ok(response.status !== 500, `Malformed paths should not crash the server: ${route}`);
  }
  assertSuccess(await client.request('/api/state'));
});
