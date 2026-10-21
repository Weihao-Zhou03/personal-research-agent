'use strict';

// The only browser-side credential is an in-memory CSRF token. The session
// cookie is HttpOnly; passwords and device secrets never enter browser storage.
(() => {
  const $ = id => document.getElementById(id);
  let csrf = null;
  let spaces = [];
  let pairing = null;
  let revokeTarget = null;
  let authenticated = false;
  const pending = new Set();

  class RequestError extends Error {
    constructor(message, status, code, requestId) { super(message); Object.assign(this, {status, code, requestId}); }
  }

  function notice(message = '', error = false) {
    const target = $('notice');
    target.textContent = message;
    target.classList.toggle('error', error);
    target.hidden = !message;
  }
  function errorNotice(error) {
    let message = error instanceof RequestError ? error.message : '暂时无法连接服务，请检查服务状态后重试。';
    if (error.requestId) message += `（请求编号：${error.requestId}）`;
    notice(message, true);
  }
  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }
  function date(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '时间未知';
  }
  function workspaceName(id) { return spaces.find(space => space.id === id)?.name || '原研究空间'; }
  function empty(container, title, text) {
    const block = element('div', 'empty-state');
    block.append(element('span', '', '↳'), element('h3', '', title), element('p', '', text));
    container.replaceChildren(block);
  }
  function clearPrivateView() {
    spaces = []; pairing = null; revokeTarget = null;
    for (const id of ['capture-list', 'device-list', 'space-list', 'scope-options']) $(id).replaceChildren();
    $('pair-details').hidden = true;
    $('pair-code').value = '';
    $('space-name').value = '';
    if ($('revoke-dialog').open) $('revoke-dialog').close();
  }
  function showLogin() {
    authenticated = false; csrf = null;
    clearPrivateView();
    $('dashboard').hidden = true; $('setup-panel').hidden = true; $('login-panel').hidden = false;
    $('logout').hidden = true;
    $('session-state').textContent = '尚未登录';
    $('session-state').classList.remove('active');
  }
  function showSetup() {
    showLogin();
    $('login-panel').hidden = true; $('setup-panel').hidden = false;
    $('session-state').textContent = '等待初始化';
  }
  function showDashboard() {
    authenticated = true;
    $('login-panel').hidden = true; $('setup-panel').hidden = true; $('dashboard').hidden = false;
    $('logout').hidden = false;
    $('session-state').textContent = '管理员已登录';
    $('session-state').classList.add('active');
  }
  async function api(path, {method = 'GET', body} = {}) {
    const headers = {'Accept':'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`/api/v1/owner${path}`, {method, headers, credentials:'same-origin', cache:'no-store', ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    let data;
    try { data = await response.json(); } catch { throw new RequestError('服务返回了无法识别的响应，请刷新后重试。', response.status); }
    if (!response.ok) {
      const message = data.error?.code === 'CSRF_DENIED' ? '管理员会话已变化，请刷新页面后重新操作。' : data.error?.message || '操作没有完成，请稍后重试。';
      const error = new RequestError(message, response.status, data.error?.code, data.error?.request_id);
      if (error.code === 'CAPTURE_NOT_CONFIGURED') showSetup();
      else if (response.status === 401 && path !== '/login') showLogin();
      throw error;
    }
    return data;
  }
  async function action(key, controls, operation) {
    if (pending.has(key)) return;
    pending.add(key);
    const snapshots = controls.map(control => [control, control.disabled]);
    for (const [control] of snapshots) control.disabled = true;
    notice();
    try { await operation(); } catch (error) { errorNotice(error); }
    finally {
      for (const [control, disabled] of snapshots) control.disabled = disabled;
      pending.delete(key);
    }
  }
  function renderSpaces() {
    $('space-list').replaceChildren(...spaces.map(space => element('li', '', space.name)));
    if (!spaces.length) $('space-list').append(element('li', '', '先创建一个研究空间。'));
    $('space-total').textContent = String(spaces.length).padStart(2, '0');
    if (pairing?.status === 'pending') renderScopeOptions();
  }
  function renderScopeOptions() {
    const selected = new Set([...$('scope-options').querySelectorAll('input:checked')].map(input => input.value));
    const previousDefault = $('default-workspace').value;
    $('scope-options').replaceChildren(...spaces.map((space, index) => {
      const label = element('label', 'scope-option');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = space.id; input.checked = selected.size ? selected.has(space.id) : index === 0;
      input.addEventListener('change', () => renderDefaultOptions($('default-workspace').value));
      label.append(input, element('span', '', space.name));
      return label;
    }));
    if (!spaces.length) $('scope-options').append(element('p', 'field-note', '请先在下方创建研究空间。'));
    renderDefaultOptions(previousDefault);
  }
  function renderDefaultOptions(previous = '') {
    const selected = new Set([...$('scope-options').querySelectorAll('input:checked')].map(input => input.value));
    $('default-workspace').replaceChildren(...spaces.filter(space => selected.has(space.id)).map(space => {
      const option = element('option', '', space.name); option.value = space.id; return option;
    }));
    if (selected.has(previous)) $('default-workspace').value = previous;
    $('default-workspace').disabled = selected.size === 0;
    $('approve').disabled = selected.size === 0 || pending.has('pair-decision');
  }
  function renderPairing() {
    const isPending = pairing?.status === 'pending';
    $('pair-details').hidden = !pairing;
    if (!pairing) return;
    $('pair-name').textContent = pairing.device_name;
    $('pair-time').textContent = `发起于 ${date(pairing.requested_at)} · 有效至 ${date(pairing.expires_at)}`;
    $('pair-status').textContent = ({pending:'等待你批准', approved:'已批准', denied:'已拒绝', expired:'已过期'})[pairing.status] || '已处理';
    $('pair-status').className = `tag${isPending ? '' : ' disabled'}`;
    $('approval-form').hidden = !isPending;
    $('pair-result').hidden = isPending;
    $('pair-result').textContent = '此配对已经处理。若需更改访问权限，请在手表上重新发起配对。';
    if (isPending) renderScopeOptions();
  }
  function renderCaptures(captures) {
    const list = $('capture-list');
    $('capture-total').textContent = String(captures.length);
    if (!captures.length) return empty(list, '第一条记录，等你送达。', '在手表上完成配对并发送 Capture 后，保存成功的原文会出现在这里。页面上的刷新不会调用生成模型。');
    list.replaceChildren(...captures.map(capture => {
      const article = element('article', 'capture-card');
      const meta = element('div', 'capture-meta');
      const time = element('time', '', date(capture.accepted_at)); time.dateTime = capture.accepted_at;
      meta.append(element('span', 'capture-space', workspaceName(capture.workspace_id)), time, element('span', 'tag subtle', capture.index_status === 'pending' ? '原文已保存 · 待索引' : '原文已保存'));
      const footer = element('div', 'capture-footer');
      footer.append(element('span', '', `设备记录时间 ${date(capture.created_at_client)}`), element('code', '', capture.id));
      article.append(meta, element('pre', 'capture-text', capture.text), footer);
      return article;
    }));
  }
  function effectiveStatus(device) {
    if (device.status === 'active' && device.expires_at && Date.parse(device.expires_at) <= Date.now()) return 'expired';
    return device.status;
  }
  function renderDevices(devices) {
    const list = $('device-list');
    $('device-total').textContent = String(devices.filter(device => effectiveStatus(device) === 'active').length);
    if (!devices.length) {
      list.replaceChildren(element('li', 'section-note', '还没有设备记录。从左侧的配对码开始。'));
      return;
    }
    list.replaceChildren(...devices.map(device => {
      const status = effectiveStatus(device);
      const row = element('li', 'device-row'), body = element('div');
      const heading = element('div', 'device-heading');
      const label = ({active:'可用', pending:'等待批准', revoked:'已撤销', expired:'已过期', denied:'已拒绝'})[status] || '不可用';
      heading.append(element('h3', '', device.name), element('span', `tag${status === 'active' ? '' : status === 'revoked' ? ' revoked' : ' disabled'}`, label));
      body.append(heading);
      if (device.allowed_workspace_ids.length) body.append(element('p', '', `允许空间：${device.allowed_workspace_ids.map(workspaceName).join('、')} · 默认：${workspaceName(device.default_workspace_id)}`));
      if (device.expires_at) body.append(element('p', '', `凭据有效至 ${date(device.expires_at)}`));
      if (device.revoked_at) body.append(element('p', '', `撤销于 ${date(device.revoked_at)}`));
      body.append(element('p', 'device-id', device.id));
      row.append(body);
      if (status === 'active' || status === 'pending') {
        const button = element('button', 'text-button danger', '撤销访问'); button.type = 'button';
        button.addEventListener('click', () => {
          revokeTarget = device;
          $('revoke-description').textContent = `设备：${device.name}`;
          $('revoke-dialog').showModal();
        });
        row.append(button);
      }
      return row;
    }));
  }
  async function loadDashboard() {
    const [workspaceData, captureData, deviceData] = await Promise.all([api('/workspaces'), api('/captures'), api('/devices')]);
    if (!authenticated) return;
    spaces = workspaceData.workspaces;
    renderSpaces(); renderCaptures(captureData.captures); renderDevices(deviceData.devices);
  }
  async function connect() {
    try {
      const session = await api('/session');
      csrf = session.csrf_token;
      showDashboard();
      await loadDashboard();
    } catch (error) {
      if (error.status === 401) return;
      if (error.code !== 'CAPTURE_NOT_CONFIGURED') showLogin();
      errorNotice(error);
    }
  }

  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    const password = $('password').value;
    $('password').value = '';
    action('login', [$('login-submit'), $('password')], async () => {
      const session = await api('/login', {method:'POST', body:{password}});
      csrf = session.csrf_token; showDashboard();
      await loadDashboard();
      notice('已登录。可以核对配对码，或查看已经送达的原文。');
    });
  });
  $('logout').addEventListener('click', () => action('logout', [$('logout')], async () => {
    await api('/logout', {method:'POST', body:{}});
    showLogin(); notice('已退出管理员会话。');
    $('password').focus();
  }));
  $('retry-setup').addEventListener('click', () => action('connect', [$('retry-setup')], connect));
  $('refresh').addEventListener('click', () => action('refresh', [$('refresh')], async () => {
    await loadDashboard(); notice('记录与设备状态已更新。');
  }));
  $('space-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('space-name').value;
    action('workspace', [$('space-submit'), $('space-name')], async () => {
      await api('/workspaces', {method:'POST', body:{name}});
      $('space-name').value = '';
      await loadDashboard(); notice('研究空间已创建。');
    });
  });
  $('pair-code').addEventListener('input', () => {
    $('pair-code').value = $('pair-code').value.toUpperCase().replace(/\s/g, '');
  });
  $('lookup-form').addEventListener('submit', event => {
    event.preventDefault();
    const code = $('pair-code').value.toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z2-9]{8}$/.test(code)) return notice('请输入手表上显示的 8 位配对码。', true);
    action('lookup', [$('lookup-submit'), $('pair-code')], async () => {
      pairing = null; $('pair-details').hidden = true;
      $('scope-options').replaceChildren();
      pairing = await api('/pairings/lookup', {method:'POST', body:{user_code:code}});
      renderPairing();
      if (pairing.status === 'pending') notice('请核对设备名称、发起时间和允许空间，再批准设备。');
    });
  });
  $('approval-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!pairing || pairing.status !== 'pending') return;
    const allowed = [...$('scope-options').querySelectorAll('input:checked')].map(input => input.value);
    const defaultId = $('default-workspace').value;
    if (!allowed.length || !allowed.includes(defaultId)) return notice('请选择至少一个允许空间，并设置其中一个为默认空间。', true);
    action('pair-decision', [$('approve'), $('deny'), $('lookup-submit')], async () => {
      const result = await api(`/pairings/${encodeURIComponent(pairing.pairing_id)}/approve`, {method:'POST', body:{allowed_workspace_ids:allowed, default_workspace_id:defaultId}});
      pairing = {...pairing, status:result.status}; renderPairing();
      await loadDashboard(); notice('设备已批准。手表联网后会取得授权与默认研究空间。');
    });
  });
  $('deny').addEventListener('click', () => {
    if (!pairing || pairing.status !== 'pending') return;
    action('pair-decision', [$('approve'), $('deny'), $('lookup-submit')], async () => {
      const result = await api(`/pairings/${encodeURIComponent(pairing.pairing_id)}/deny`, {method:'POST', body:{}});
      pairing = {...pairing, status:result.status}; renderPairing();
      await loadDashboard(); notice('已拒绝此次配对。');
    });
  });
  $('cancel-revoke').addEventListener('click', () => $('revoke-dialog').close());
  $('revoke-dialog').addEventListener('close', () => { revokeTarget = null; });
  $('confirm-revoke').addEventListener('click', () => {
    const target = revokeTarget;
    if (!target) return;
    action('revoke', [$('confirm-revoke'), $('cancel-revoke')], async () => {
      await api(`/devices/${encodeURIComponent(target.id)}/revoke`, {method:'POST', body:{}});
      $('revoke-dialog').close();
      await loadDashboard(); notice('已撤销设备访问。已保存的记录仍会保留。');
    });
  });
  connect();
})();
