import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as defaultProcessor from './lib/processor.mjs';
import { proxyDetected, readProxyKey } from './lib/proxy-config.mjs';
import { ThinkFlowClient, THINKFLOW_COMMIT } from './lib/thinkflow.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const kinds = new Set(['study', 'research', 'organize']);
const providers = new Set(['extractive', 'ollama', 'openai']);
const now = () => new Date().toISOString();
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function ensure(condition, message, status = 422) { if (!condition) throw new HttpError(status, message); }
function textField(value, name, max, required = false) {
  ensure(value === undefined || typeof value === 'string', `${name}必须是文字`);
  const result = (value || '').trim();
  ensure(result.length <= max, `${name}过长（最多 ${max} 字符）`);
  ensure(!required || result.length > 0, `请填写${name}`);
  return result;
}
function safeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(422, '服务地址格式不正确'); }
  ensure(!url.username && !url.password && !url.search && !url.hash, '服务地址不能包含凭证、查询或片段');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  ensure(url.protocol === 'https:' || (local && url.protocol === 'http:'), '远程服务请使用 HTTPS；本机服务可用 HTTP');
  return url.href.replace(/\/+$/, '');
}
async function readJson(req) {
  ensure((req.headers['content-type'] || '').startsWith('application/json'), '请求需要 JSON 格式', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, '内容过大，请分段提交');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    ensure(body && typeof body === 'object' && !Array.isArray(body), '请求需要 JSON 对象');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON 格式不正确');
  }
}

export async function createApp({ dataDir = path.join(root, 'data'), processor = defaultProcessor, detectProxy = false, thinkflowClient = new ThinkFlowClient() } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'workspace.json');
  const detected = detectProxy && proxyDetected();
  const defaults = detected
    ? { provider: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', model: 'gpt-6-luna' }
    : { provider: 'extractive', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b' };
  let state = { version: 1, tasks: [], knowledge: [], settings: defaults };
  if (existsSync(stateFile)) {
    const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.tasks) || !Array.isArray(stored.knowledge)) {
      throw new Error('本地数据格式无法识别，原文件已保留。');
    }
    state = { ...stored, settings: { ...defaults, ...stored.settings } };
  }
  // Never persist or return a credential, including when opening an older file.
  delete state.settings.apiKey;
  let sessionKey = '';
  let sessionKeyBase = '';
  let closing = false;
  let busy = false;
  const queue = [];
  const controllers = new Map();
  const asking = new Set();
  const archiving = new Set();
  function persist() {
    const temp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, stateFile);
  }
  function effectiveSettings() {
    let apiKey = sessionKeyBase === state.settings.baseUrl ? sessionKey : '';
    if (!apiKey && detected && state.settings.baseUrl === 'http://127.0.0.1:8317/v1') apiKey = readProxyKey();
    if (!apiKey && process.env.PERSONAL_AGENT_API_KEY) apiKey = process.env.PERSONAL_AGENT_API_KEY;
    return { ...state.settings, apiKey };
  }
  function publicSettings() {
    return { ...state.settings, hasApiKey: Boolean(effectiveSettings().apiKey) };
  }
  function transition(task, status, message) {
    task.status = status;
    task.updatedAt = now();
    task.events ||= [];
    task.events.push({ status, at: task.updatedAt, message });
    persist();
  }
  for (const task of state.tasks) {
    if (['running', 'queued'].includes(task.status)) {
      task.error = '上次服务中断。请检查材料后重新执行。';
      transition(task, 'failed', task.error);
    }
  }
  async function drain() {
    if (busy || closing) return;
    busy = true;
    try {
      while (queue.length && !closing) {
        const id = queue.shift();
        const task = state.tasks.find(item => item.id === id);
        if (!task || task.status !== 'queued') continue;
        const controller = new AbortController();
        controllers.set(id, controller);
        const settings = effectiveSettings();
        task.execution = { provider: settings.provider, model: settings.provider === 'extractive' ? '' : settings.model };
        transition(task, 'running', '正在整理材料');
        try {
          const result = await processor.processTask(structuredClone(task), settings, { signal: controller.signal });
          if (task.status === 'running' && !controller.signal.aborted) {
            ensure(result && typeof result.markdown === 'string' && result.markdown.trim(), '模型没有返回可用内容');
            task.result = { ...result, createdAt: now() };
            task.error = null;
            transition(task, 'completed', '处理完成，等待人工确认');
          }
        } catch (error) {
          if (task.status === 'running' && !controller.signal.aborted) {
            task.error = error.message || '处理失败，请重试';
            transition(task, 'failed', task.error);
          }
        } finally { controllers.delete(id); }
      }
    } finally { busy = false; }
  }
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
  function json(res, data, status = 200, headers = {}) {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      ensure(allowedHosts.has(host), '仅接受本机访问', 403);
      if (req.headers.origin) {
        ensure([...allowedHosts].some(h => req.headers.origin === `http://${h}`), '拒绝跨来源请求', 403);
      }
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (route === '/api/state' && req.method === 'GET') {
        return json(res, {
          tasks: state.tasks, knowledge: state.knowledge, settings: publicSettings(),
          runtime: { localOnly: true, proxyDetected: detected, localModel: 'qwen2.5:1.5b', storage: 'data/workspace.json', version: '0.1.0', thinkflow: {baseUrl:thinkflowClient.baseUrl,commit:THINKFLOW_COMMIT} }
        });
      }
      if (route === '/api/thinkflow/notebooks') {
        if (req.method === 'GET') return json(res, {notebooks:await thinkflowClient.notebooks()});
        ensure(req.method === 'POST', '请求方法不支持',405);
        const body = await readJson(req);
        return json(res, await thinkflowClient.createNotebook(textField(body.name,'笔记本名称',120,true)),201);
      }
      const sourceRoute = route.match(/^\/api\/thinkflow\/notebooks\/([^/]+)\/(sources|documents)$/);
      if (sourceRoute) {
        const id = decodeURIComponent(sourceRoute[1]);
        if (sourceRoute[2] === 'documents') {
          ensure(req.method === 'GET','请求方法不支持',405);
          return json(res,await thinkflowClient.documents(id));
        }
        if (req.method === 'GET') return json(res,await thinkflowClient.sources(id));
        ensure(req.method === 'POST','请求方法不支持',405);
        const body = await readJson(req);
        return json(res,await thinkflowClient.addText(id,textField(body.title,'资料标题',120,true),textField(body.content,'资料正文',100000,true)),201);
      }
      if (route === '/api/thinkflow/read' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res,await thinkflowClient.readSources(textField(body.notebookId,'笔记本编号',200,true),body.sourceIds));
      }
      const nativeResult = route.match(/^\/api\/tasks\/([^/]+)\/thinkflow-result$/);
      if (nativeResult && req.method === 'GET') {
        const task = state.tasks.find(t => t.id === nativeResult[1]);
        ensure(task?.thinkflow?.writeback,'此任务尚未写回 ThinkFlow',404);
        return json(res,await thinkflowClient.readDocument(task.thinkflow.writeback));
      }
      if (route === '/api/export' && req.method === 'GET') {
        return json(res, { version: state.version, exportedAt: now(), tasks: state.tasks, knowledge: state.knowledge }, 200,
          { 'Content-Disposition': 'attachment; filename="personal-agent-backup.json"' });
      }
      if (route === '/api/settings' && req.method === 'POST') {
        const body = await readJson(req);
        ensure(providers.has(body.provider), '请选择有效的处理模式');
        const baseUrl = safeBaseUrl(textField(body.baseUrl, '服务地址', 2000, body.provider !== 'extractive') || state.settings.baseUrl);
        const model = textField(body.model, '模型名称', 200, body.provider !== 'extractive');
        if (body.apiKey !== undefined && body.apiKey !== '') {
          sessionKey = textField(body.apiKey, '接口密钥', 2000);
          sessionKeyBase = baseUrl;
        }
        if (body.clearApiKey === true) { sessionKey = ''; sessionKeyBase = ''; }
        state.settings = { provider: body.provider, baseUrl, model };
        persist();
        return json(res, publicSettings());
      }
      if (route === '/api/settings/test' && req.method === 'POST') {
        await readJson(req);
        return json(res, await processor.testConnection(effectiveSettings(), { signal: AbortSignal.timeout(30000) }));
      }
      if (route === '/api/tasks' && req.method === 'POST') {
        const body = await readJson(req);
        const instruction = textField(body.instruction, '任务目标', 8000, true);
        const title = body.title === undefined ? instruction.slice(0, 40) : textField(body.title, '任务名称', 120, true);
        const kind = body.kind || 'study';
        ensure(kinds.has(kind), '任务类型不正确');
        let sourceText = textField(body.sourceText, '参考材料', 100000);
        ensure(body.sources === undefined || Array.isArray(body.sources), '来源格式不正确');
        ensure((body.sources || []).length <= 30, '最多添加 30 个来源');
        let sources = (body.sources || []).map(item => {
          ensure(item && typeof item === 'object', '来源格式不正确');
          const sourceUrl = textField(item.url, '来源链接', 2000, true);
          let parsed;
          try { parsed = new URL(sourceUrl); } catch { throw new HttpError(422, '来源链接格式不正确'); }
          ensure(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, '来源链接仅支持 HTTP/HTTPS，不能含凭证');
          return { title: textField(item.title, '来源名称', 200) || parsed.hostname, url: parsed.href };
        });
        let thinkflow;
        if (body.thinkflow !== undefined) {
          ensure(body.thinkflow && typeof body.thinkflow === 'object','ThinkFlow 资料选择格式不正确');
          const selected = await thinkflowClient.readSources(textField(body.thinkflow.notebookId,'笔记本编号',200,true),body.thinkflow.sourceIds);
          if (body.thinkflow.sourceHashes) {
            ensure(selected.sources.every(s => body.thinkflow.sourceHashes[s.id] === s.sha256),'ThinkFlow 资料已变化，请重新选取并预览',409);
          }
          sourceText = selected.sourceText;
          sources = selected.sources.map(s => ({title:s.name,url:s.url}));
          thinkflow = {baseUrl:thinkflowClient.baseUrl,userId:thinkflowClient.userId,notebookId:selected.notebook.id,notebookName:selected.notebook.name,readAt:now(),
            sources:selected.sources.map(({content,...ref},i) => ({...ref,ref:`TF${i+1}`}))};
        }
        const task = { id: randomUUID(), title, kind, instruction, sourceText, sources,
          ...(thinkflow ? {thinkflow} : {}),
          status: 'draft', createdAt: now(), updatedAt: now(), result: null, error: null, knowledgeId: null, conversation: [],
          events: [{ status: 'draft', at: now(), message: '等待确认目标后执行' }] };
        state.tasks.unshift(task);
        persist();
        return json(res, task, 201);
      }
      const match = route.match(/^\/api\/tasks\/([^/]+)\/(run|cancel|archive|result|ask)$/);
      if (match) {
        const task = state.tasks.find(item => item.id === match[1]);
        ensure(task, '没有找到这个任务', 404);
        const action = match[2];
        ensure(req.method === (action === 'result' ? 'PUT' : 'POST'), '请求方法不支持', 405);
        const body = await readJson(req);
        if (action === 'run') {
          ensure(['draft', 'failed', 'cancelled'].includes(task.status), '这个任务当前不能重复执行', 409);
          ensure(!controllers.has(task.id) && !asking.has(task.id), '上次操作正在结束，请稍后重试', 409);
          task.error = null;
          transition(task, 'queued', '任务已确认，等待处理');
          queue.push(task.id);
          json(res, task, 202);
          queueMicrotask(drain);
          return;
        }
        if (action === 'cancel') {
          ensure(['draft', 'queued', 'running'].includes(task.status), '这个任务当前不能取消', 409);
          controllers.get(task.id)?.abort();
          transition(task, 'cancelled', '任务已取消');
          return json(res, task);
        }
        ensure(task.status === 'completed', '请等待任务完成后再操作', 409);
        if (action === 'result') {
          ensure(!task.knowledgeId, '结果已入库；此版本不支持覆盖已确认的记录', 409);
          ensure(!task.writebackIntent,'此结果已发起 ThinkFlow 确认，请先重试核对写入结果；内容已锁定以避免重复或冲突',409);
          task.result.markdown = textField(body.markdown, '结果内容', 200000, true);
          task.result.editedAt = now();
          task.updatedAt = now();
          persist();
          return json(res, task);
        }
        if (action === 'archive') {
          if (task.knowledgeId) return json(res, state.knowledge.find(entry => entry.id === task.knowledgeId));
          ensure(!archiving.has(task.id),'正在核对并写回 ThinkFlow，请稍候',409);
          const content = body.content === undefined ? task.result.markdown : textField(body.content, '入库内容', 200000, true);
          let native;
          if (task.thinkflow) {
            ensure(!task.writebackIntent || task.writebackIntent.content === content,'先前已确认的内容正在核对，不能换成不同内容；请重试原内容',409);
            archiving.add(task.id);
            task.writebackIntent ||= {content,confirmedAt:now()};
            task.writebackIntent.status = 'pending';
            task.writebackIntent.error = null;
            task.result.markdown = content;
            task.updatedAt = now();
            persist();
            try {
              native = await thinkflowClient.writeResult(structuredClone(task),content);
              task.thinkflow.writeback = native;
              task.writebackIntent.status = 'verified';
            } catch (error) {
              task.writebackIntent.status = 'failed';
              task.writebackIntent.error = error.status ? error.message : 'ThinkFlow 写回失败，请检查服务后重试';
              persist();
              throw error;
            } finally { archiving.delete(task.id); }
          }
          const entry = { id: randomUUID(), taskId: task.id, title: task.title, kind: task.kind, content,
            ...(native ? {thinkflow:native} : {}),
            sources: structuredClone(task.sources), createdAt: now(), mode: task.result.mode, model: task.result.model };
          state.knowledge.unshift(entry);
          task.knowledgeId = entry.id;
          task.result.markdown = content;
          task.updatedAt = now();
          persist();
          return json(res, entry, 201);
        }
        if (action === 'ask') {
          const question = textField(body.question, '追问内容', 4000, true);
          ensure(!asking.has(task.id), '上一条追问仍在处理', 409);
          asking.add(task.id);
          try {
            let answer;
            try {
              answer = await processor.answerQuestion(structuredClone(task), question, effectiveSettings(), { signal: AbortSignal.timeout(120000) });
            } catch (error) {
              // The processor deliberately returns sanitized, actionable errors.
              throw new HttpError(502, error.message || '追问处理失败，请检查模型服务后重试');
            }
            task.conversation.push({ question, answer: answer.answer, mode: answer.mode, createdAt: now() });
            task.updatedAt = now();
            persist();
            return json(res, answer);
          } finally { asking.delete(task.id); }
        }
      }
      if (route.startsWith('/api/')) throw new HttpError(404, '接口不存在');
      ensure(req.method === 'GET' || req.method === 'HEAD', '请求方法不支持', 405);
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
        '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      const asset = files[route];
      ensure(asset, '页面不存在', 404);
      const contents = readFileSync(path.join(root, 'public', asset[0]));
      res.writeHead(200, { ...securityHeaders, 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!res.headersSent) json(res, { error: error.status ? error.message : '服务暂时出错，请稍后重试' }, error.status || 500);
      else res.end();
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 5000;
  async function close() {
    closing = true;
    for (const controller of controllers.values()) controller.abort();
    for (const task of state.tasks) {
      if (['queued', 'running'].includes(task.status)) {
        task.error = '服务已停止，请重新执行。';
        transition(task, 'failed', task.error);
      }
    }
    if (server.listening) {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    }
  }
  return { server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PERSONAL_AGENT_PORT || 4317);
  const app = await createApp({ detectProxy: true });
  app.server.listen(port, '127.0.0.1', () => console.log(`Personal Agent ready: http://127.0.0.1:${port}`));
  app.server.on('error', error => { console.error(`启动失败：${error.code === 'EADDRINUSE' ? '端口已被占用' : error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
