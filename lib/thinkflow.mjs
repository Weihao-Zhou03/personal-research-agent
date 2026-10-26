import { createHash } from 'node:crypto';

export const THINKFLOW_COMMIT = '1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3';
const INTERNAL_KEY = 'df-internal-2024-workflow-key'; // Public upstream client key, not a user credential.
const MAX_TEXT = 100000;
const sentenceSegments = new Intl.Segmenter('zh',{granularity:'sentence'});
function passageCount(value) {
  return value.split(/\r?\n+/u).reduce((count,line) => count+[...sentenceSegments.segment(line)].filter(s => s.segment.trim()).length,0);
}
export class ThinkFlowError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export class ThinkFlowClient {
  constructor({baseUrl = 'http://127.0.0.1:8437', userId = 'local', apiKey = process.env.PERSONAL_AGENT_THINKFLOW_KEY || INTERNAL_KEY} = {}) {
    const url = new URL(baseUrl);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ThinkFlowError('ThinkFlow 适配器目前仅支持本机 HTTP 服务根地址', 422);
    }
    this.baseUrl = url.origin;
    this.userId = userId;
    this.apiKey = apiKey;
  }
  async request(route, {method = 'GET', body} = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {method, redirect:'error', signal:AbortSignal.timeout(30000),
        headers:{'X-API-Key':this.apiKey, ...(body ? {'Content-Type':'application/json'} : {})},
        ...(body ? {body:JSON.stringify(body)} : {})});
    } catch { throw new ThinkFlowError('无法连接 ThinkFlow。请启动本机 ThinkFlow 服务后重试。'); }
    if (!response.ok) throw new ThinkFlowError(`ThinkFlow 请求失败（HTTP ${response.status}），请检查服务和资料是否仍存在。`);
    let data;
    try { data = await response.json(); } catch { throw new ThinkFlowError('ThinkFlow 返回了无法识别的数据'); }
    if (data.success === false) throw new ThinkFlowError('ThinkFlow 未完成此次操作，请检查其服务日志。');
    return data;
  }
  query(notebook) {
    return new URLSearchParams({notebook_id:notebook.id, notebook_title:notebook.name, user_id:this.userId, email:this.userId}).toString();
  }
  async notebooks() {
    const data = await this.request(`/api/v1/kb/notebooks?${new URLSearchParams({user_id:this.userId,email:this.userId})}`);
    if (!Array.isArray(data.notebooks)) throw new ThinkFlowError('ThinkFlow 笔记本列表格式不正确');
    return data.notebooks.map(n => ({id:n.id,name:n.name || n.title || '未命名笔记本',description:n.description || '',sources:n.sources || 0}));
  }
  async notebook(id) {
    const notebook = (await this.notebooks()).find(n => n.id === id);
    if (!notebook) throw new ThinkFlowError('所选 ThinkFlow 笔记本不存在', 404);
    return notebook;
  }
  async createNotebook(name) {
    const data = await this.request('/api/v1/kb/notebooks', {method:'POST',body:{name,description:'由 Personal Agent 创建的科研资料工作区',user_id:this.userId,email:this.userId}});
    if (!data.notebook?.id) throw new ThinkFlowError('ThinkFlow 没有返回新笔记本');
    return {id:data.notebook.id,name:data.notebook.name};
  }
  async sources(id) {
    const notebook = await this.notebook(id);
    const data = await this.request(`/api/v1/kb/files?${this.query(notebook)}`);
    if (!Array.isArray(data.files)) throw new ThinkFlowError('ThinkFlow 资料列表格式不正确');
    // Some upstream records repeat the same physical source. Expose each path once.
    const seen = new Set();
    const sources = data.files.filter(s => {
      const ref = s.static_url || s.url;
      if (!ref || !ref.startsWith('/outputs/') || ref.includes('..') || seen.has(ref)) return false;
      seen.add(ref); return true;
    }).map(s => ({id:s.id,name:s.name,path:s.static_url || s.url,url:`${this.baseUrl}${s.static_url || s.url}`,type:s.file_type || '',indexed:Boolean(s.vector_ready)}));
    return {notebook,sources};
  }
  async addText(id, title, content) {
    const notebook = await this.notebook(id);
    await this.request('/api/v1/kb/add-text-source', {method:'POST',body:{notebook_id:notebook.id,notebook_title:notebook.name,user_id:this.userId,email:this.userId,title,content}});
    return this.sources(id);
  }
  async readSources(id, sourceIds, {preserveWhitespace=false} = {}) {
    const {notebook,sources} = await this.sources(id);
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20 || new Set(sourceIds).size !== sourceIds.length) {
      throw new ThinkFlowError('请选择 1 至 20 份不同的资料', 422);
    }
    const selected = sourceIds.map(sourceId => {
      const source = sources.find(s => s.id === sourceId);
      if (!source) throw new ThinkFlowError('所选资料已变化或不属于这个笔记本，请刷新列表', 409);
      if (!/\.(md|txt|markdown|pdf)$/i.test(new URL(source.url).pathname)) throw new ThinkFlowError('此轮接入支持文字资料和有文本层的 PDF；图片与音视频尚未接入',422);
      return source;
    });
    const parts = [];
    let total = 0;
    for (const source of selected) {
      // Never accept an arbitrary path from the browser: re-resolve from the selected notebook's API list.
      const data = await this.request('/api/v1/kb/get-source-display-content', {method:'POST',body:{path:source.path,notebook_id:notebook.id,email:this.userId}});
      const content = typeof data.content === 'string' ? (preserveWhitespace ? data.content : data.content.trim()) : '';
      if (!content.trim() || content.trim() === '[PDF 无文本或解析失败]') throw new ThinkFlowError(`资料“${source.name}”没有可读取的正文`,422);
      total += content.length;
      if (total > MAX_TEXT) throw new ThinkFlowError('所选资料正文合计超过 100,000 字符，请减少资料；不会自动截断',422);
      parts.push({...source,content,sha256:createHash('sha256').update(content).digest('hex')});
    }
    let passage = 1;
    const sourceText = parts.map((s,i) => {
      const section = `【ThinkFlow 来源 TF${i+1}：${s.name}】\n${s.content}`;
      s.passageStart = passage;
      passage += passageCount(section);
      s.passageEnd = passage-1;
      return section;
    }).join('\n\n');
    if (sourceText.length > MAX_TEXT) throw new ThinkFlowError('包含来源标记后的材料超过 100,000 字符，请减少资料',422);
    return {notebook,sources:parts,sourceText};
  }
  async documents(id) {
    const notebook = await this.notebook(id);
    const data = await this.request(`/api/v1/kb/documents?${this.query(notebook)}`);
    if (!Array.isArray(data.documents)) throw new ThinkFlowError('ThinkFlow 文档列表格式不正确');
    return {notebook,documents:data.documents};
  }
  async readDocument(link) {
    if (link.baseUrl !== this.baseUrl || link.userId !== this.userId) throw new ThinkFlowError('ThinkFlow 文档的服务或用户不一致',409);
    const {notebook,documents} = await this.documents(link.notebookId);
    if (!documents.some(d => d.id === link.documentId)) throw new ThinkFlowError('ThinkFlow 文档已移动或删除',404);
    const data = await this.request(`/api/v1/kb/documents/${encodeURIComponent(link.documentId)}?${this.query(notebook)}`);
    if (typeof data.document?.content !== 'string') throw new ThinkFlowError('ThinkFlow 文档正文格式不正确');
    return {document:data.document,notebook};
  }
  async writeResult(task, content) {
    const link = task.thinkflow;
    if (!link || link.baseUrl !== this.baseUrl || link.userId !== this.userId) throw new ThinkFlowError('任务绑定的 ThinkFlow 服务或用户与当前配置不一致',409);
    const {notebook,documents} = await this.documents(link.notebookId);
    const hash = createHash('sha256').update(content).digest('hex');
    const marker = `personal-agent:${task.id}`;
    const prior = documents.filter(d => d.metadata?.personal_agent_task_id === task.id);
    if (prior.length > 1) throw new ThinkFlowError('发现多份相同任务的 ThinkFlow 文档，请先核对，避免重复写入',409);
    if (prior.length) {
      if (prior[0].metadata?.content_sha256 !== hash) throw new ThinkFlowError('此任务已有不同内容的 ThinkFlow 文档，请先核对原文档，未覆盖',409);
      const existing = await this.request(`/api/v1/kb/documents/${encodeURIComponent(prior[0].id)}?${this.query(notebook)}`);
      if (existing.document?.content !== content) throw new ThinkFlowError('ThinkFlow 文档已被编辑，请先核对；本次未覆盖',409);
      return this.documentLink(prior[0],notebook,hash);
    }
    const data = await this.request('/api/v1/kb/documents', {method:'POST',body:{notebook_id:notebook.id,notebook_title:notebook.name,user_id:this.userId,email:this.userId,
      title:task.title,content,document_type:'summary_doc',metadata:{personal_agent_task_id:task.id,integration_marker:marker,content_sha256:hash,confirmed_at:task.writebackIntent?.confirmedAt || new Date().toISOString(),source_refs:link.sources,source_text_snapshot:task.sourceText,task_kind:task.kind,model:task.result?.model || null}}});
    if (!data.document?.id) throw new ThinkFlowError('ThinkFlow 未返回写入的文档编号，请重试核对');
    // Read back the real document before marking the write as successful locally.
    const verified = await this.request(`/api/v1/kb/documents/${encodeURIComponent(data.document.id)}?${this.query(notebook)}`);
    if (verified.document?.content !== content) throw new ThinkFlowError('ThinkFlow 写入后的内容核对失败，请重试检查');
    return this.documentLink(data.document,notebook,hash);
  }
  documentLink(document, notebook, hash) {
    return {documentId:document.id,notebookId:notebook.id,notebookName:notebook.name,baseUrl:this.baseUrl,userId:this.userId,
      contentSha256:hash,verifiedAt:new Date().toISOString(),url:`${this.baseUrl}/`,title:document.title};
  }
}
