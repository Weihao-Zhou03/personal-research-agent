import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {APIError,requireValue} from './auth/capture-service.mjs';

export class ResearchConfig {
  constructor(store,{defaultConfig={},resolveDefaultKey=()=>'',fetchImpl=fetch,clock=()=>Date.now()}={}) {
    this.store=store;this.db=store.db;this.fetch=fetchImpl;this.clock=clock;this.resolveDefaultKey=resolveDefaultKey;this.keys=new Map();
    this.db.exec('CREATE TABLE IF NOT EXISTS research_model_configs(version TEXT PRIMARY KEY,config_json TEXT NOT NULL,created_at TEXT NOT NULL)');
    this.defaults=defaultConfig;
  }
  current() {
    const row=this.db.prepare("SELECT value FROM app_meta WHERE key='research_model_current'").get();
    if(row) return JSON.parse(this.db.prepare('SELECT config_json FROM research_model_configs WHERE version=?').get(row.value).config_json);
    if(!this.defaults.baseUrl || !this.defaults.model) return {provider:'openai',baseUrl:'',model:'',version:'unconfigured',maxCalls:2,inputTokens:8000,outputTokens:2500,dailyLimit:50,timeoutMs:90000,queueLimit:100};
    const config=this.validate({...this.defaults,version:'environment'});
    config.version=`env_${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`;return config;
  }
  validate(input) {
    let url;try {url=new URL(input.baseUrl);}catch {throw new APIError(422,'INVALID_MODEL_CONFIG','请填写模型服务地址');}
    requireValue((url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash,422,'INVALID_MODEL_CONFIG','模型远程接口须为HTTPS，本机可HTTP；地址不能带凭据或查询');
    requireValue(input.provider===undefined || input.provider==='openai',422,'INVALID_MODEL_CONFIG','新问答使用OpenAI兼容云模型接口');
    requireValue(typeof input.model==='string' && input.model.trim() && [...input.model].length<=120 && !/[\x00-\x1f]/.test(input.model),422,'INVALID_MODEL_CONFIG','请填写有效模型名称');
    const number=(key,defaultValue,min,max)=> {const value=input[key]??defaultValue;requireValue(Number.isInteger(value)&&value>=min&&value<=max,422,'INVALID_MODEL_CONFIG',`${key}超出允许范围`);return value;};
    return {provider:'openai',baseUrl:url.href.replace(/\/+$/,''),model:input.model.trim(),version:input.version || `cfg_${randomUUID()}`,maxCalls:2,
      inputTokens:number('inputTokens',8000,1000,8000),outputTokens:number('outputTokens',2500,256,2500),dailyLimit:number('dailyLimit',50,1,1000),timeoutMs:number('timeoutMs',90000,1000,90000),queueLimit:number('queueLimit',100,1,1000)};
  }
  update(body) {
    requireValue(body && Object.keys(body).every(k=>['provider','baseUrl','model','api_key','inputTokens','outputTokens','dailyLimit','timeoutMs','queueLimit'].includes(k)),422,'INVALID_MODEL_CONFIG','模型配置包含未知字段');
    requireValue(body.api_key===undefined || (typeof body.api_key==='string' && body.api_key.length<=4096 && !/[\r\n\0]/.test(body.api_key)),422,'INVALID_MODEL_CONFIG','模型密钥格式不正确');
    const config=this.validate(body);
    this.store.transaction(()=> {
      this.db.prepare('INSERT INTO research_model_configs VALUES(?,?,?)').run(config.version,JSON.stringify(config),new Date(this.clock()).toISOString());
      this.db.prepare("INSERT INTO app_meta VALUES('research_model_current',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(config.version);
    });
    if(body.api_key) this.keys.set(config.baseUrl,body.api_key);
    return this.public();
  }
  resolveKey(config) {return this.keys.get(config.baseUrl) || this.resolveDefaultKey(config) || '';}
  public() {try{const config=this.current(),available=Boolean(this.resolveKey(config));return {...config,has_api_key:available,configured:Boolean(config.baseUrl&&config.model&&available)};}catch{return{provider:'openai',baseUrl:'',model:'',version:'invalid_configuration',dailyLimit:50,has_api_key:false,configured:false,code:'INVALID_MODEL_CONFIG'};}}
  async connectionCheck() {
    const config=this.current();requireValue(config.baseUrl&&config.model,503,'MODEL_NOT_CONFIGURED','请先配置云模型');
    let response;try {response=await this.fetch(`${config.baseUrl}/models`,{headers:{Authorization:`Bearer ${this.resolveKey(config)}`},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new APIError(503,'MODEL_UNAVAILABLE','模型服务连接失败',true);}
    requireValue(response.ok,503,'MODEL_UNAVAILABLE',`模型服务返回HTTP ${response.status}`);
    let data;try{data=await response.json();}catch{throw new APIError(502,'MODEL_RESPONSE_INVALID','模型列表格式不正确');}
    requireValue(Array.isArray(data.data)&&data.data.some(m=>m.id===config.model),422,'MODEL_NOT_FOUND','服务列表中没有配置的模型');
    return {ok:true,model:config.model,generation_performed:false};
  }
}

export function environmentModel(env=process.env) {
  return {provider:'openai',baseUrl:env.PERSONAL_AGENT_MODEL_BASE_URL || '',model:env.PERSONAL_AGENT_MODEL || '',dailyLimit:Number(env.PERSONAL_AGENT_DAILY_ASK_LIMIT || 50)};
}
export function environmentKey(config,env=process.env) {
  const base=(env.PERSONAL_AGENT_MODEL_BASE_URL || '').replace(/\/+$/,'');
  if(config.baseUrl!==base) return '';
  if(env.PERSONAL_AGENT_MODEL_KEY_FILE) {try{return readFileSync(env.PERSONAL_AGENT_MODEL_KEY_FILE,'utf8').trim();}catch{return '';}}
  return env.PERSONAL_AGENT_MODEL_KEY || '';
}
