export class WritebackError extends Error {
  constructor(code) { super(code);this.code=code; }
}
const need=(value,code='INVALID_THINKFLOW_RESPONSE')=>{if(!value) throw new WritebackError(code);};

/** Revision-aware adapter. The legacy task-id writer remains unchanged. */
export class ThinkFlowWriteback {
  constructor(client,{fetchImpl=fetch}={}) {
    // Snapshot the connection in memory so an object mutated during awaited I/O cannot retarget a later POST.
    this.client=client?Object.freeze({baseUrl:client.baseUrl,userId:client.userId,apiKey:client.apiKey}):null;this.fetchImpl=fetchImpl;
  }
  matches(target) {
    if(!this.client || target.base_url!==this.client.baseUrl || target.user_id!==this.client.userId) return false;
    try {const url=new URL(this.client.baseUrl);return url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname==='/';}
    catch {return false;}
  }
  async request(route,{method='GET',body,signal}={}) {
    let response;
    try {
      response=await this.fetchImpl(`${this.client.baseUrl}${route}`,{method,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),
        headers:{'X-API-Key':this.client.apiKey,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      need(response.ok,'THINKFLOW_UNAVAILABLE');
      const raw=await response.text();need(Buffer.byteLength(raw,'utf8')<=5_242_880,'THINKFLOW_RESPONSE_TOO_LARGE');
      const data=JSON.parse(raw);need(data && data.success!==false);return data;
    } catch(error) { if(error instanceof WritebackError) throw error;throw new WritebackError('THINKFLOW_UNAVAILABLE'); }
  }
  query(target,notebook) { return new URLSearchParams({notebook_id:target.notebook_id,notebook_title:notebook.name,user_id:target.user_id,email:target.user_id}).toString(); }
  async documents(target,{signal}={}) {
    need(this.matches(target),'THINKFLOW_TARGET_CHANGED');
    const list=await this.request(`/api/v1/kb/notebooks?${new URLSearchParams({user_id:target.user_id,email:target.user_id})}`,{signal});
    need(Array.isArray(list.notebooks));const notebook=list.notebooks.find(n=>n.id===target.notebook_id);need(notebook,'THINKFLOW_TARGET_MISSING');
    need(typeof notebook.name==='string' || typeof notebook.title==='string');
    const normalized={id:notebook.id,name:notebook.name || notebook.title};
    const data=await this.request(`/api/v1/kb/documents?${this.query(target,normalized)}`,{signal});
    need(Array.isArray(data.documents) && !data.has_more && !data.next_cursor && !data.next_page && (data.total===undefined || data.total===data.documents.length),'INCOMPLETE_THINKFLOW_LIST');
    need(data.documents.every(d=>d && typeof d.id==='string' && d.id && (d.metadata==null || typeof d.metadata==='object' && !Array.isArray(d.metadata))));
    return {notebook:normalized,documents:data.documents};
  }
  async read(target,notebook,documentId,{signal}={}) {
    need(this.matches(target),'THINKFLOW_TARGET_CHANGED');
    const data=await this.request(`/api/v1/kb/documents/${encodeURIComponent(documentId)}?${this.query(target,notebook)}`,{signal});
    need(data.document && data.document.id===documentId && typeof data.document.content==='string');
    return data.document;
  }
  async create(target,notebook,{title,content,metadata},{signal}={}) {
    need(this.matches(target),'THINKFLOW_TARGET_CHANGED');
    const data=await this.request('/api/v1/kb/documents',{method:'POST',body:{notebook_id:target.notebook_id,notebook_title:notebook.name,user_id:target.user_id,email:target.user_id,
      title,content,document_type:'summary_doc',metadata},signal});
    need(data.document && typeof data.document.id==='string' && data.document.id);return data.document;
  }
}
