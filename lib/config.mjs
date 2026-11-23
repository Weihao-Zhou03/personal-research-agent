import path from 'node:path';

export function resolveConfig({mode='local', storage='json', databasePath, dataDir, publicOrigin='', trustedProxyAddresses=[], listenHost, ...rest}={}) {
  if (!['local','server'].includes(mode)) throw new Error('PERSONAL_AGENT_MODE must be local or server');
  if (!['json','sqlite'].includes(storage)) throw new Error('PERSONAL_AGENT_STORAGE must be json or sqlite');
  let origin = '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Server public origin must be a credential-free HTTPS root');
    origin = url.origin;
  }
  if (mode==='server' && (storage!=='sqlite' || !origin)) throw new Error('Server mode requires SQLite and an explicit HTTPS public origin');
  if (!Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.some(v=>!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(v))) throw new Error('M1 supports only an explicitly trusted loopback TLS proxy');
  const host = listenHost || '127.0.0.1';
  if (mode==='local' && !['127.0.0.1','::1','localhost'].includes(host)) throw new Error('Local mode must listen on loopback');
  return {...rest,mode,storage,dataDir,databasePath:databasePath || path.join(dataDir,'workspace.sqlite'),publicOrigin:origin,trustedProxyAddresses,listenHost:host};
}

export function configFromEnvironment(root, env=process.env) {
  const dataDir=path.resolve(env.PERSONAL_AGENT_DATA_DIR || path.join(root,'data'));
  return resolveConfig({mode:env.PERSONAL_AGENT_MODE || 'local',storage:env.PERSONAL_AGENT_STORAGE || 'json',dataDir,
    databasePath:env.PERSONAL_AGENT_DATABASE,publicOrigin:env.PERSONAL_AGENT_PUBLIC_ORIGIN,
    listenHost:env.PERSONAL_AGENT_LISTEN_HOST,
    trustedProxyAddresses:(env.PERSONAL_AGENT_TRUSTED_PROXIES || '').split(',').map(v=>v.trim()).filter(Boolean)});
}
