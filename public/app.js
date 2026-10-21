'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const kinds = {study:'学习总结',research:'研究问题',organize:'资料整理'};
  const statusNames = {draft:'待确认',queued:'排队中',running:'处理中',completed:'已完成',failed:'处理失败',cancelled:'已取消'};
  const modeNames = {extractive:'本地原文提取',ollama:'本地模型选句',openai:'云端模型生成',ai:'AI 整理'};
  const views = {workspace:'工作台',tasks:'我的任务',knowledge:'知识库',settings:'设置'};
  let state = {tasks:[],knowledge:[],settings:{provider:'extractive',baseUrl:'',model:'',hasApiKey:false},runtime:{}};
  let currentView = 'workspace';
  let selectedTaskId = null;
  let selectedKnowledgeId = null;
  let draftToConfirm = null;
  let settingsDirty = false;
  let initialSettings = false;
  let polling = false;
  let connected = false;
  let detailSignature = '';
  let taskListSignature = '';
  let recentSignature = '';
  let knowledgeSignature = '';
  let knowledgeDetailSignature = '';
  let activeRecognition = null;
  let speechTimer = null;
  let simulationTimer = null;
  let simulationTarget = null;
  let simulatedText = '';
  const simulationExamples = {meeting:'帮我整理今天的组会笔记，提取关键结论，并列出还需要验证的问题。',study:'请总结这份课堂笔记，提取核心概念，并整理我还没有理解的问题。',research:'请根据提供的材料梳理研究问题，区分已有证据、未知项和下一步验证计划。'};
  const resultEdits = new Map();
  const editingResults = new Set();
  const questionDrafts = new Map();
  const askingTasks = new Set();
  let sourceBinding = null;
  let notebookPreview = null;
  let notebookLoadVersion = 0;

  const examples = {
    study:{title:'理解注意力机制的核心思路',kind:'study',instruction:'整理核心概念，区分自注意力与交叉注意力，并列出需要继续查证的问题。',sourceText:'注意力机制课堂笔记\n\n注意力机制使用 Query、Key 和 Value 表示信息检索过程。Query 与 Key 的匹配程度决定每个 Value 的权重。\n缩放点积注意力先计算 Query 与 Key 的点积，再除以 Key 维度的平方根，最后经过 softmax 得到权重。\n自注意力的 Query、Key、Value 来自同一序列；交叉注意力的 Query 与 Key、Value 来自不同序列。\n多头注意力把表示投影到多个子空间，使模型能并行关注不同关系。\n标准自注意力需要构造序列长度的平方大小的矩阵，因此长序列会带来内存和计算开销。\n待查问题：多头之间如何分工？位置编码如何提供顺序信息？'},
    research:{title:'梳理轻量个人学习助手的研究问题',kind:'research',instruction:'从材料中提炼研究问题，整理已有证据和未知项，列出可验证的下一步。',sourceText:'研究观察记录\n\n学生在课堂和组会中经常产生临时问题，但课后很难找回当时的上下文。\n语音输入可能减少记录负担，但嘈杂环境会影响识别，公开场合讲话也可能不方便。\n一种设想是先记录短任务，再在后台整理材料，课后提供总结与追问。\n用户需要知道任务是否已接收，以及什么时候可以查看结果。\n模型总结可能遗漏限定条件或混淆材料来源，因此入库前需要人工确认。\n尚无真实用户测试数据，无法判断语音入口是否比快捷键或文字更有效。\n可做对比实验：让参与者分别用文字和语音记录学习任务，记录耗时、遗漏信息及使用体验。'},
    organize:{title:'整理本周的项目讨论记录',kind:'organize',instruction:'按主题整理材料，提取明确的行动项，保留尚未确定的事项。',sourceText:'周一讨论：先做电脑端原型，跑通输入、确认、后台处理和查看结果。\n设备计划：后续考虑树莓派部署，目前没有硬件。服务应尽量避免依赖某一种设备。\n周三观察：语音识别失败时必须能直接用文字继续。朗读需要停止按钮和文字反馈。\n知识库：只有用户确认后的结果才写入；原始资料与生成内容需要区分，保留出处。\n下次讨论前：整理三份示例材料，分别测试学习总结、研究问题和资料整理。\n尚未决定：是否需要离线语音识别；本地小模型在目标设备上的速度需要实测。'}
  };

  function safeURL(value) {
    try { const url = new URL(String(value)); return ['http:','https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }

  const entityDecoder = document.createElement('textarea');
  function decodeEntity(entity) {
    // Only one syntactically valid entity reaches this detached decoder, never
    // arbitrary HTML. Its decoded text is escaped again before display.
    if (!/^&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);$/.test(entity)) return entity;
    entityDecoder.innerHTML = entity;
    return entityDecoder.value;
  }

  function inlineMarkdown(text) {
    const tokens = [];
    const markerPattern = /\u0000(\d+)\u0000/g;
    const source = String(text).replace(/\u0000/g, '\uFFFD');
    const token = (html, literal) => `\u0000${tokens.push({html,literal}) - 1}\u0000`;
    const restore = (value, property) => value.replace(markerPattern, (_, index) => tokens[Number(index)]?.[property] ?? '');
    const emphasize = value => value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    let value = '';
    let index = 0;
    while (index < source.length) {
      if (source[index] === '`') {
        let end = index + 1;
        while (source[end] === '`') end++;
        const delimiter = source.slice(index,end);
        let close = source.indexOf(delimiter,end);
        while (close !== -1 && (source[close - 1] === '`' || source[close + delimiter.length] === '`')) close = source.indexOf(delimiter,close + delimiter.length);
        if (close !== -1) {
          let code = source.slice(end,close).replace(/\r\n?|\n/g,' ');
          if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1,-1);
          value += token(`<code>${escape(code)}</code>`,code);
          index = close + delimiter.length;
          continue;
        }
        value += delimiter; index = end; continue;
      }
      if (source[index] === '\\' && index + 1 < source.length && /[!-/:-@\[-`{-~]/.test(source[index + 1])) {
        const literal = source[index + 1];
        value += token(escape(literal),literal); index += 2; continue;
      }
      if (source[index] === '&') {
        const entity = source.slice(index).match(/^&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/);
        if (entity) { const literal=decodeEntity(entity[0]); value += token(escape(literal),literal); index += entity[0].length; continue; }
      }
      value += source[index++];
    }
    value = value.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => {
      const url = safeURL(restore(href,'literal'));
      const labelHTML = restore(emphasize(escape(label)),'html');
      return token(url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${labelHTML}</a>` : labelHTML,restore(label,'literal'));
    });
    return restore(emphasize(escape(value)),'html');
  }

  function markdown(source) {
    const lines = String(source || '').replace(/\r\n?/g,'\n').split('\n');
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      if (/^\s*```/.test(line)) {
        const block = []; index++;
        while (index < lines.length && !/^\s*```/.test(lines[index])) block.push(lines[index++]);
        index++; output.push(`<pre><code>${escape(block.join('\n'))}</code></pre>`); continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) { output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); index++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push('<hr>'); index++; continue; }
      if (/^\s*>/.test(line)) {
        const block = []; while (index < lines.length && /^\s*>/.test(lines[index])) block.push(lines[index++].replace(/^\s*>\s?/,''));
        output.push(`<blockquote>${markdown(block.join('\n'))}</blockquote>`); continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line); const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/; const items = [];
        while (index < lines.length && pattern.test(lines[index])) items.push(`<li>${inlineMarkdown(lines[index++].replace(pattern,''))}</li>`);
        output.push(`<${ordered?'ol':'ul'}>${items.join('')}</${ordered?'ol':'ul'}>`); continue;
      }
      if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
        const cells = row => row.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell => inlineMarkdown(cell.trim()));
        const headers = cells(line); index += 2; const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(`<tr>${cells(lines[index++]).map(cell => `<td>${cell}</td>`).join('')}</tr>`);
        output.push(`<table><thead><tr>${headers.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`); continue;
      }
      const paragraph = [line]; index++;
      while (index < lines.length && lines[index].trim() && !/^\s*(#{1,4}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])) paragraph.push(lines[index++]);
      output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    }
    return output.join('');
  }

  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'America/New_York'}).format(parsed);
  }
  function badge(task) { return `<span class="status-badge status-${escape(task.status)}">${escape(statusNames[task.status] || task.status)}</span>`; }
  function modeName(result) { const name=result?.mode === 'ai' && result?.model === 'qwen2.5:1.5b' ? '本地模型选句' : (modeNames[result?.mode] || '模型整理'); return result?.model ? `${name} · ${result.model}` : name; }
  function taskById(id) { return state.tasks.find(task => task.id === id); }
  function emptyState(title, text, extra='') { return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">—</div><h3>${escape(title)}</h3><p>${escape(text)}</p>${extra}</div>`; }
  function toast(message, error = false) {
    const node = document.createElement('div'); node.className = `toast${error?' error':''}`; node.textContent = message; $('#toasts').append(node); setTimeout(() => node.remove(), error ? 6500 : 4000);
  }
  function connection(ok) {
    connected = ok; const node = $('#connection-status'); node.classList.toggle('offline', !ok); node.innerHTML = `<i></i>${ok?'本地已连接':'连接中断'}`;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {headers:{'Content-Type':'application/json'},...options});
    let data;
    try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); }
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  async function action(button, task) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try { await task(); } catch (error) { toast(error.message || '操作失败，请重试。', true); } finally { if (button?.isConnected) button.disabled = false; }
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const next = await api('/api/state');
      state = {...state,...next,tasks:next.tasks || [],knowledge:next.knowledge || []};
      connection(true); render();
    } catch (error) {
      connection(false);
    } finally { polling = false; }
  }

  function setView(name, scroll = true) {
    if (!(name in views)) return;
    if (currentView !== name) stopSimulation();
    currentView = name;
    $$('.view').forEach(node => node.hidden = node.id !== `view-${name}`);
    $$('.nav-item').forEach(node => node.classList.toggle('active',node.dataset.view === name));
    $('#current-view-name').textContent = views[name];
    if (location.hash !== `#${name}`) history.replaceState(null,'',`#${name}`);
    render();
    if (scroll) window.scrollTo({top:0,behavior:'instant'});
  }
  function selectTask(id) { selectedTaskId = id; detailSignature = ''; setView('tasks'); }

  function render() {
    $('#task-count').textContent = state.tasks.length;
    $('#knowledge-count').textContent = state.knowledge.length;
    const provider = state.settings.provider;
    $('#provider-label').textContent = provider === 'extractive' ? '本地提取模式' : provider === 'ollama' ? '本地模型选句' : `云端模型 · ${state.settings.model || '待配置'}`;
    $('#mode-note').textContent = provider === 'extractive' ? '当前使用本地提取，按原文整理，不调用生成式 AI。' : provider === 'ollama' ? `${state.settings.model || '本地模型'} 辅助选取原文，材料在本机处理。` : `当前使用云端模型 ${state.settings.model || '（待配置）'}。开始任务时，目标和材料会发送给配置的服务。`;
    if (!initialSettings || !settingsDirty) fillSettings();
    if (currentView === 'workspace') renderRecent();
    if (currentView === 'tasks') { renderTaskList(); renderTaskDetail(); }
    if (currentView === 'knowledge') renderKnowledge();
  }

  function renderRecent() {
    const tasks = [...state.tasks].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,4);
    const signature = JSON.stringify(tasks);
    if (signature === recentSignature) return;
    recentSignature = signature; $('#recent-total').textContent = state.tasks.length ? `(${state.tasks.length})` : '';
    $('#recent-tasks').innerHTML = tasks.length ? tasks.map(task => `<button class="recent-row" data-task-id="${escape(task.id)}"><span class="recent-icon" aria-hidden="true">${task.kind==='study'?'▤':task.kind==='research'?'⌕':'☷'}</span><div><div class="recent-row-title">${escape(task.title)}</div><div class="recent-row-meta">${escape(kinds[task.kind] || task.kind)} · ${escape(date(task.createdAt))}</div></div>${badge(task)}<span class="recent-arrow" aria-hidden="true">↗</span></button>`).join('') : emptyState('尚无任务记录','在左侧填写目标与材料。任务确认后，可以在这里查看进展。');
  }

  function filteredTasks() {
    const filter = $('#task-filter').value;
    return [...state.tasks].filter(task => filter==='all' || (filter==='active' ? ['queued','running'].includes(task.status) : filter==='failed' ? ['failed','cancelled'].includes(task.status) : task.status===filter)).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function renderTaskList() {
    const tasks = filteredTasks();
    const signature = JSON.stringify([tasks,selectedTaskId]);
    if (signature === taskListSignature) return;
    taskListSignature = signature;
    $('#task-list-count').textContent = `${tasks.length} 项`;
    $('#task-list').innerHTML = tasks.length ? tasks.map(task => `<button class="task-list-item${selectedTaskId===task.id?' selected':''}" data-task-id="${escape(task.id)}" ${selectedTaskId===task.id?'aria-current="true"':''}><div class="task-item-title">${escape(task.title)}</div><div class="task-item-meta">${badge(task)}<span>${escape(date(task.createdAt))}</span></div></button>`).join('') : emptyState(state.tasks.length ? '这里还没有任务':'还没有任务',state.tasks.length ? '换一个筛选条件看看。':'创建一个学习或研究任务，进展会保存在这里。',state.tasks.length?'':'<button class="button secondary" data-view="workspace">创建第一个任务 ↗</button>');
  }
  function sourcesMarkup(sources) {
    if (!sources?.length) return '';
    return `<section class="sources-block"><h3>资料来源</h3>${sources.map(source => { const url = safeURL(source.url); return url ? `<a class="source-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">↗ ${escape(source.title || source.url)}</a>` : `<span class="source-link">${escape(source.title || source.url)}</span>`; }).join('')}</section>`;
  }
  function nativeLinkMarkup(taskId, link) {
    const url = safeURL(link?.url);
    return `<div class="native-document-links"><button type="button" class="text-button" data-native-result="${escape(taskId)}">读取 ThinkFlow 文档 ↗</button>${url?`<a class="text-button" href="${escape(url)}" target="_blank" rel="noopener">打开 ThinkFlow ↗</a>`:''}</div>`;
  }

  function renderTaskDetail() {
    const task = taskById(selectedTaskId);
    if (!task) {
      if (detailSignature !== 'empty') $('#task-detail').innerHTML = emptyState('选择一项任务','在左侧打开任务，查看进展、审阅结果或继续追问。');
      detailSignature = 'empty'; return;
    }
    const signature = JSON.stringify([task,editingResults.has(task.id),askingTasks.has(task.id)]);
    if (signature === detailSignature) return;
    const focused = document.activeElement;
    const focusName = focused?.id;
    const selection = (focused?.tagName === 'TEXTAREA') ? [focused.selectionStart,focused.selectionEnd] : null;
    detailSignature = signature;
    const completed = task.status === 'completed';
    const running = ['queued','running'].includes(task.status);
    const result = task.result?.markdown || '';
    const editing = editingResults.has(task.id) && !task.knowledgeId && !task.writebackIntent;
    const editor = resultEdits.has(task.id) ? resultEdits.get(task.id) : result;
    const conversation = task.conversation || [];
    $('#task-detail').innerHTML = `<div class="detail-eyebrow"><span>${escape(kinds[task.kind] || task.kind)}</span><span>·</span>${badge(task)}</div><h2 class="detail-title">${escape(task.title)}</h2><p class="detail-date">创建于 ${escape(date(task.createdAt))} · 时间以纽约时区显示</p>${task.instruction?`<div class="detail-instruction"><strong>任务目标</strong>${escape(task.instruction)}</div>`:''}${running?`<div class="task-progress"><span class="progress-spinner"></span>${task.status==='queued'?'任务已接收，准备处理':'正在整理这份材料'}<p>可以继续使用其他页面，任务会在后台运行。</p></div>`:''}${task.error?`<div class="task-error">${escape(task.error)}</div>`:''}${task.status==='draft'?'<div class="detail-actions"><button class="button primary" data-action="preview">确认并开始 ↗</button><button class="button secondary" data-action="cancel">取消任务</button></div>':''}${running?'<div class="detail-actions"><button class="button secondary" data-action="cancel">取消处理</button></div>':''}${['failed','cancelled'].includes(task.status)?'<div class="detail-actions"><button class="button primary" data-action="preview">重新尝试 ↗</button></div>':''}${completed?`<div class="result-header"><h3>整理结果</h3><div class="result-actions"><span>${escape(modeName(task.result))}</span><button class="text-button" data-action="speak">朗读</button><button class="text-button" data-action="edit">${editing?'预览结果':'编辑'}</button></div></div>${editing?`<label class="sr-only" for="result-editor">编辑整理结果</label><textarea id="result-editor" class="result-editor">${escape(editor)}</textarea><p class="edit-note">支持 Markdown。修改会保存；追问仍以原始材料为证据。</p><button class="button secondary" data-action="save-result">保存修改</button>`:`<div class="markdown">${markdown(editor)}</div>${resultEdits.has(task.id)?'<p class="edit-note">有未保存的修改，可返回编辑后保存，或直接确认入库。</p>':''}`}<div class="result-footer"><p>${task.knowledgeId?'✓ 这份成果已收入知识库':'由你审阅并确认后，才会写入知识库。'}</p>${task.knowledgeId?'<button class="button secondary" data-action="open-knowledge">前往知识库 ↗</button>':'<button class="button primary" data-action="archive">确认存入知识库 ↗</button>'}</div>`:''}${sourcesMarkup(task.sources)}${task.sourceText?`<details class="task-source-preview"><summary>查看原始材料（${task.sourceText.length.toLocaleString('zh-CN')} 字符）</summary><pre>${escape(task.sourceText)}</pre></details>`:''}${completed?`<section class="ask-section"><h3>继续思考</h3><p>${task.result?.mode==='extractive'?'本地模式会检索原文中的相关片段，不会生成新的推论。':'围绕原始材料继续追问。'}</p><div class="conversation">${conversation.map(item => `<div class="conversation-item"><div class="conversation-question">${escape(item.question)}</div><div class="conversation-answer"><div class="markdown">${markdown(item.answer)}</div><p class="answer-mode">${escape(task.execution?.provider === 'ollama' ? '本地原文检索' : (modeNames[item.mode] || item.mode || ''))} · ${escape(date(item.createdAt))}</p></div></div>`).join('')}</div><form id="ask-form" data-task="${escape(task.id)}"><label class="sr-only" for="ask-question">关于任务的问题</label><div class="ask-input-row"><textarea id="ask-question" required maxlength="4000" placeholder="输入关于这份材料的问题…" ${askingTasks.has(task.id)?'disabled':''}>${escape(questionDrafts.get(task.id) || '')}</textarea><button class="button primary" type="submit" ${askingTasks.has(task.id)?'disabled':''}>${askingTasks.has(task.id)?'思考中…':'追问 ↗'}</button></div></form></section>`:''}`;
    if (task.knowledgeId || task.writebackIntent) $('#task-detail [data-action="edit"]')?.remove();
    if (task.thinkflow) {
      const tf = task.thinkflow;
      $('.detail-date',$('#task-detail')).insertAdjacentHTML('afterend',`<div class="notebook-provenance"><span class="eyebrow">ThinkFlow notebook</span><strong>${escape(tf.notebookName)}</strong><p>${tf.sources.length} 份正文 · 读取于 ${escape(date(tf.readAt))} · 使用资料快照</p>${tf.writeback?`<p>✓ 已写回并读取核对 · 文档 ${escape(tf.writeback.documentId)}</p>${nativeLinkMarkup(task.id,tf.writeback)}`:'<p>结果经你确认后，保存为这个笔记本中的原生文档。</p>'}</div>`);
      const archive = $('[data-action="archive"]',$('#task-detail'));
      if (archive) archive.textContent = task.writebackIntent ? '重试核对并写回 ↗' : '确认并写回 ThinkFlow ↗';
      const footer = $('.result-footer p',$('#task-detail'));
      if (footer) footer.textContent = tf.writeback ? '✓ 已写入 ThinkFlow，并保留本地确认记录。' : '审阅后确认，结果才会写入这个 ThinkFlow 笔记本。';
      if (task.writebackIntent?.status === 'failed') $('.result-footer',$('#task-detail')).insertAdjacentHTML('beforebegin',`<div class="task-error">${escape(task.writebackIntent.error)}<p>已确认的内容暂时锁定。重试会先查找已有文档，核对后恢复，不会覆盖其他内容。</p></div>`);
    }
    if (focusName && ['result-editor','ask-question'].includes(focusName)) {
      const replacement = document.getElementById(focusName);
      if (replacement && !replacement.disabled) { replacement.focus({preventScroll:true}); if (selection) replacement.setSelectionRange(...selection); }
    }
  }

  function renderKnowledge() {
    const query = $('#knowledge-search').value.trim().toLocaleLowerCase();
    const entries = [...state.knowledge].filter(entry => `${entry.title}\n${entry.content}`.toLocaleLowerCase().includes(query)).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    $('#knowledge-total').textContent = `${entries.length} 份已确认成果`;
    const signature = JSON.stringify([entries,selectedKnowledgeId]);
    if (signature !== knowledgeSignature) {
      knowledgeSignature = signature;
      $('#knowledge-list').innerHTML = entries.length ? entries.map(entry => `<button class="card knowledge-card${entry.id===selectedKnowledgeId?' selected':''}" data-knowledge-id="${escape(entry.id)}"><div class="eyebrow">${escape(kinds[entry.kind] || '知识积累')}</div><h3>${escape(entry.title)}</h3><p class="knowledge-excerpt">${escape(String(entry.content || '').replace(/[#*_`>\[\]]/g,''))}</p><div class="knowledge-card-footer"><span>${escape(date(entry.createdAt))}</span><span aria-hidden="true">↗</span></div></button>`).join('') : emptyState(query?'没有找到相关成果':'让知识在这里慢慢积累',query?'试试其他关键词，或清空搜索。':'完成任务后，审阅整理结果并点击“确认存入知识库”，成果就会出现在这里。');
    }
    const entry = state.knowledge.find(item => item.id === selectedKnowledgeId);
    $('.knowledge-layout').classList.toggle('has-selection', !!entry);
    $('#knowledge-detail').hidden = !entry;
    const detail = JSON.stringify(entry);
    if (entry && detail !== knowledgeDetailSignature) {
      knowledgeDetailSignature = detail;
      $('#knowledge-detail').innerHTML = `<div class="knowledge-detail-header"><span class="eyebrow">${escape(kinds[entry.kind] || '知识积累')} · 已确认</span><div class="knowledge-detail-actions"><button class="button secondary" data-download="${escape(entry.id)}">↓ 下载 Markdown</button><button class="icon-button" data-action="close-knowledge" aria-label="关闭知识详情">×</button></div></div><h2>${escape(entry.title)}</h2><p class="detail-date">存入于 ${escape(date(entry.createdAt))}</p><div class="markdown">${markdown(entry.content)}</div>${sourcesMarkup(entry.sources)}<div class="detail-actions"><button class="text-button" data-task-id="${escape(entry.taskId)}">查看原任务 ↗</button></div>`;
      if (entry.thinkflow) $('.detail-date',$('#knowledge-detail')).insertAdjacentHTML('afterend',`<div class="notebook-provenance"><span class="eyebrow">saved in ThinkFlow</span><strong>${escape(entry.thinkflow.notebookName)}</strong><p>已读取核对 · ${escape(entry.thinkflow.documentId)}</p>${nativeLinkMarkup(entry.taskId,entry.thinkflow)}</div>`);
    }
  }

  function fillSettings() {
    if (settingsDirty) return;
    const {provider,baseUrl,model,hasApiKey} = state.settings;
    $('#provider').value = provider || 'extractive';
    $('#base-url').value = baseUrl || '';
    $('#model-name').value = model || '';
    $('#key-status').textContent = hasApiKey ? '已有本机凭证，留空保留' : '尚未配置';
    $('#api-key').placeholder = hasApiKey ? '已有本机凭证，留空保留' : '填写 API Key';
    initialSettings = true; updateProviderFields();
  }
  function updateProviderFields() {
    const provider = $('#provider').value;
    $('#model-settings').hidden = provider === 'extractive';
    $('#api-key-field').hidden = provider !== 'openai';
    $('#provider-description').textContent = provider === 'extractive' ? '无需网络与密钥。按原文提取句子、关键词和待办，不具备生成式推理能力。' : provider === 'ollama' ? '用小模型选择相关原句，由程序保留原文；解释、推理和综合总结可切换云端。材料上限为 5,000 字符，完整任务亦有上下文限制。请确保 Ollama 服务已启动、模型已安装。' : '通过你配置的 OpenAI 兼容服务调用模型；本机代理可能继续向云端转发。任务和材料会发送给该服务。';
    $('#base-url').required = provider !== 'extractive';
    $('#model-name').required = provider !== 'extractive';
  }
  function showConfirmation(task) {
    draftToConfirm = task.id;
    $('#confirm-content').innerHTML = `<h3 class="confirm-title">${escape(task.title)}</h3><div class="confirm-meta"><span>${escape(kinds[task.kind])}</span><span>${Number(task.sourceText?.length || 0).toLocaleString('zh-CN')} 字符材料</span><span>${task.sources?.length || 0} 个来源</span></div><div class="confirm-instruction">${escape(task.instruction || '按任务类型整理提供的材料。')}</div>`;
    $('#confirm-mode-note').textContent = state.settings.provider === 'extractive' ? '将使用本地提取模式，仅从材料原文中提取信息。完成后可审阅、修改和追问。' : state.settings.provider === 'ollama' ? `将由本机模型 ${state.settings.model} 选择相关原句，由程序保留原文。材料上限为 5,000 字符，完整任务亦有上下文限制；解释、推理和综合总结可切换云端。` : `将由配置的云端模型 ${state.settings.model} 处理。任务目标与材料会发送给配置的服务，请确认材料适合提交。`;
    $('#confirm-dialog').showModal();
    if (task.thinkflow) $('#confirm-content').insertAdjacentHTML('beforeend',`<p class="notebook-confirm-note">资料来自 ThinkFlow「${escape(task.thinkflow.notebookName)}」。本次只处理材料；结果完成后需你再次确认才会写回。</p>`);
  }

  function bindThinkFlow(preview) {
    sourceBinding = preview ? {notebookId:preview.notebook.id,sourceIds:preview.sources.map(s=>s.id),sourceHashes:Object.fromEntries(preview.sources.map(s=>[s.id,s.sha256]))} : null;
    $('#task-source').readOnly = Boolean(preview);
    $('#task-sources').disabled = Boolean(preview);
    $('#detach-thinkflow').hidden = !preview;
    $('#thinkflow-binding-title').textContent = preview ? preview.notebook.name : '从 ThinkFlow 带入研究资料';
    $('#thinkflow-binding-note').textContent = preview ? `${preview.sources.length} 份正文已读取 · 确认后的结果写回此笔记本` : '选取笔记本中的正文，整理后由你确认写回。';
    $('#choose-thinkflow').textContent = preview ? '重新选取 ↗' : '选取资料 ↗';
    if (preview) { $('#task-source').value=preview.sourceText; $('#task-sources').value=''; }
  }
  function invalidateNotebookPreview() {
    notebookPreview=null; $('#attach-thinkflow').disabled=true;
    $('#thinkflow-preview').textContent='选取资料后，点击“读取预览”。'; $('#thinkflow-preview-count').textContent='';
  }
  async function loadNotebookSources() {
    invalidateNotebookPreview();
    const id=$('#thinkflow-notebook').value;
    const version=++notebookLoadVersion;
    $('#thinkflow-sources').textContent=id?'正在读取资料清单…':'先创建一个笔记本，或在 ThinkFlow 中添加资料。';
    if (!id) return;
    const data=await api(`/api/thinkflow/notebooks/${encodeURIComponent(id)}/sources`);
    if (version!==notebookLoadVersion) return;
    $('#thinkflow-sources').innerHTML=data.sources.length ? data.sources.map(s=>`<label class="notebook-source-row"><input type="checkbox" value="${escape(s.id)}"><span><strong>${escape(s.name)}</strong><small>${escape(s.type || '文字资料')} · ${s.indexed?'ThinkFlow 标记为已索引':'直接读取正文'}</small></span></label>`).join('') : '<p class="field-help">这个笔记本还没有资料。可在下方添加文字资料。</p>';
    $('#thinkflow-status').textContent=`已连接 · ${data.notebook.name} · ${data.sources.length} 份资料`;
  }
  async function loadNotebooks(selectId) {
    $('#thinkflow-status').textContent='正在连接本机 ThinkFlow…';
    const data=await api('/api/thinkflow/notebooks');
    const current=selectId || $('#thinkflow-notebook').value || sourceBinding?.notebookId;
    $('#thinkflow-notebook').innerHTML=data.notebooks.length ? data.notebooks.map(n=>`<option value="${escape(n.id)}">${escape(n.name)}</option>`).join('') : '<option value="">暂无笔记本</option>';
    if (data.notebooks.some(n=>n.id===current)) $('#thinkflow-notebook').value=current;
    $('#thinkflow-status').textContent='已连接本机 ThinkFlow';
    await loadNotebookSources();
  }
  $('#choose-thinkflow').addEventListener('click',()=> {
    $('#thinkflow-dialog').showModal();
    action(null,async()=> { try { await loadNotebooks(); } catch(error) { $('#thinkflow-status').textContent=error.message; throw error; } });
  });
  $('#close-thinkflow').addEventListener('click',()=>$('#thinkflow-dialog').close());
  $('#detach-thinkflow').addEventListener('click',()=> { bindThinkFlow(null); toast('已转为手动材料，后续结果将存入本地知识库。'); });
  $('#refresh-thinkflow').addEventListener('click',event=>action(event.currentTarget,()=>loadNotebooks()));
  $('#thinkflow-notebook').addEventListener('change',()=>action(null,loadNotebookSources));
  $('#thinkflow-sources').addEventListener('change',invalidateNotebookPreview);
  $('#read-thinkflow').addEventListener('click',event=>action(event.currentTarget,async()=> {
    const notebookId=$('#thinkflow-notebook').value;
    const sourceIds=$$('#thinkflow-sources input:checked').map(n=>n.value);
    if (!sourceIds.length) throw new Error('请先勾选要读取的资料。');
    $('#thinkflow-status').textContent='正在读取资料正文…';
    const preview=await api('/api/thinkflow/read',{method:'POST',body:JSON.stringify({notebookId,sourceIds})});
    if ($('#thinkflow-notebook').value!==notebookId || JSON.stringify($$('#thinkflow-sources input:checked').map(n=>n.value))!==JSON.stringify(sourceIds)) return;
    notebookPreview=preview; $('#thinkflow-preview').textContent=preview.sourceText; $('#thinkflow-preview-count').textContent=`${preview.sourceText.length.toLocaleString('zh-CN')} 字符`;
    $('#attach-thinkflow').disabled=false; $('#thinkflow-status').textContent='正文已读取，请检查预览后使用。未执行向量检索。';
  }));
  $('#attach-thinkflow').addEventListener('click',()=> { if (!notebookPreview) return; bindThinkFlow(notebookPreview); $('#thinkflow-dialog').close(); toast('ThinkFlow 资料已带入。填写目标后预览任务。'); });
  $('#create-notebook').addEventListener('click',event=>action(event.currentTarget,async()=> {
    const name=$('#new-notebook-name').value.trim(); if (!name) throw new Error('请填写新笔记本名称。');
    const notebook=await api('/api/thinkflow/notebooks',{method:'POST',body:JSON.stringify({name})});
    $('#new-notebook-name').value=''; await loadNotebooks(notebook.id); toast('ThinkFlow 笔记本已创建。');
  }));
  $('#add-thinkflow-source').addEventListener('click',event=>action(event.currentTarget,async()=> {
    const id=$('#thinkflow-notebook').value, title=$('#thinkflow-source-title').value.trim(),content=$('#thinkflow-source-text').value.trim();
    if (!id || !title || !content) throw new Error('请选择笔记本，并填写资料标题与正文。');
    await api(`/api/thinkflow/notebooks/${encodeURIComponent(id)}/sources`,{method:'POST',body:JSON.stringify({title,content})});
    $('#thinkflow-source-title').value=''; $('#thinkflow-source-text').value=''; await loadNotebookSources(); toast('原始资料已保存到 ThinkFlow。');
  }));
  $('#close-native-result').addEventListener('click',()=>$('#native-result-dialog').close());

  function parseSources(text) {
    return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const url = safeURL(line);
      if (!url) throw new Error(`资料链接格式不正确：${line.slice(0,70)}`);
      return {title:new URL(url).hostname,url};
    });
  }

  function stopSpeech() {
    if (activeRecognition) { activeRecognition.stop(); activeRecognition = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    clearTimeout(speechTimer); $('#speech-bar').hidden = true;
  }
  function stopSimulation(finished = false) {
    if (!simulationTimer) return;
    clearInterval(simulationTimer); simulationTimer=null;
    if (simulationTarget) { const target=document.getElementById(simulationTarget); if (target) { target.value=simulatedText; target.dispatchEvent(new Event('input',{bubbles:true})); } }
    $('#simulation-text').disabled=false; $('#simulation-preset').disabled=false; $('#start-simulation').disabled=false; $('#stop-simulation').disabled=true;
    $('#simulation-progress').textContent=finished?'模拟完成，文字已填入目标与要求。可以关闭窗口继续编辑。':'已停止模拟，已显示的字幕已保留在目标与要求中。';
  }
  function showSimulation(targetId) {
    stopSpeech(); stopSimulation(); simulationTarget=targetId; simulatedText='';
    const current=document.getElementById(targetId).value.trim();
    $('#simulation-text').value=current || simulationExamples[$('#simulation-preset').value];
    $('#simulation-caption').textContent='点击下方按钮，开始播放文字输入过程。';
    $('#simulation-progress').textContent='播放完成或手动停止后，字幕会填入任务目标。';
    $('#simulate-dialog').showModal();
  }
  function startSimulation() {
    stopSimulation(); const text=$('#simulation-text').value.trim();
    if (!text) { toast('请先填写要模拟的口述文字。',true); return; }
    simulatedText=''; let index=0; const step=Math.max(1,Math.ceil(text.length/180));
    $('#simulation-text').disabled=true; $('#simulation-preset').disabled=true; $('#start-simulation').disabled=true; $('#stop-simulation').disabled=false;
    $('#simulation-caption').textContent=''; $('#simulation-progress').textContent='正在播放模拟输入 · 未使用麦克风';
    simulationTimer=setInterval(()=> { index=Math.min(text.length,index+step); simulatedText=text.slice(0,index); $('#simulation-caption').textContent=simulatedText; if (index>=text.length) stopSimulation(true); },45);
  }
  function speechStatus(text) { clearTimeout(speechTimer); $('#speech-status').textContent = text; $('#speech-bar').hidden = false; }
  function dictate(targetId) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { toast('这个浏览器暂不支持语音识别。可以使用文字输入，或在 Chrome / Edge 中重试。', true); return; }
    stopSpeech();
    const target = document.getElementById(targetId);
    const prefix = target.value.trim() ? `${target.value.trim()}\n` : '';
    const recognition = new SpeechRecognition(); activeRecognition = recognition;
    recognition.lang = 'zh-CN'; recognition.interimResults = true; recognition.continuous = true;
    let failure = false;
    recognition.onstart = () => speechStatus('正在聆听 · 浏览器可能通过在线服务识别音频');
    recognition.onresult = event => { let text=''; for (let i=0; i<event.results.length; i++) text += event.results[i][0].transcript; target.value = prefix + text; target.dispatchEvent(new Event('input',{bubbles:true})); speechStatus(`正在识别：${text.slice(-50) || '请开始说话'}`); };
    recognition.onerror = event => { failure=true; const messages = {'not-allowed':'麦克风未获授权，请检查浏览器权限，或使用文字输入。','audio-capture':'没有检测到可用麦克风，请使用文字输入。','network':'语音识别服务连接失败，请使用文字输入。','no-speech':'没有听到语音，可以重试或直接输入文字。'}; toast(messages[event.error] || '语音识别失败，请使用文字输入。', true); };
    recognition.onend = () => { if (activeRecognition===recognition) activeRecognition=null; $('#speech-bar').hidden=true; if (!failure) target.focus(); };
    try { recognition.start(); speechStatus('正在请求麦克风权限 · 浏览器可能在线处理音频'); } catch { activeRecognition=null; toast('无法启动语音识别，请使用文字输入。', true); }
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) { toast('这个浏览器不支持朗读，请直接阅读整理结果。',true); return; }
    stopSpeech();
    const clean = String(text).replace(/```[\s\S]*?```/g,'代码块。').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[#*_`>|]/g,'');
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang='zh-CN'; utterance.rate=.95;
    const voice = window.speechSynthesis.getVoices().find(item => /^zh/i.test(item.lang)); if (voice) utterance.voice=voice;
    utterance.onstart = () => speechStatus('正在朗读整理结果 · 点击停止可随时打断');
    utterance.onboundary = event => { if (typeof event.charIndex === 'number') speechStatus(`朗读中：${clean.slice(event.charIndex,event.charIndex+45)}`); };
    utterance.onend = () => { $('#speech-bar').hidden=true; };
    utterance.onerror = event => { $('#speech-bar').hidden=true; if (!['interrupted','canceled'].includes(event.error)) toast('朗读失败，浏览器可能没有可用的中文语音。',true); };
    speechStatus('准备朗读…'); window.speechSynthesis.speak(utterance);
  }

  $('#task-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('#create-task-button'), async () => {
      const form = new FormData(event.target);
      const data = {title:form.get('title').trim(),kind:form.get('kind'),instruction:form.get('instruction').trim(),sourceText:form.get('sourceText').trim(),sources:parseSources(form.get('sources'))};
      if (sourceBinding) { data.thinkflow=sourceBinding; data.sourceText=''; data.sources=[]; }
      if (!data.title) throw new Error('请为任务填写一个名称。');
      if (!data.instruction) throw new Error('请填写目标与要求。');
      if (!data.sourceText && !sourceBinding && state.settings.provider==='extractive') throw new Error('本地提取需要学习材料，请粘贴笔记或选择一个示例。');
      const task = await api('/api/tasks',{method:'POST',body:JSON.stringify(data)});
      state.tasks.unshift(task); render(); showConfirmation(task);
    });
  });
  $('#source-file').addEventListener('change', event => {
    const file = event.target.files[0]; if (!file) return;
    action(null, async () => { if (file.size > 1000000) throw new Error('请导入 1 MB 以内的文本文件。'); const text=await file.text(); if (text.length>100000) throw new Error('材料不能超过 100,000 字符，请分批整理。'); bindThinkFlow(null); $('#task-source').value=text; toast(`已导入 ${file.name}`); });
    event.target.value='';
  });
  $('#run-confirmed').addEventListener('click', event => action(event.currentTarget, async () => {
    const id = draftToConfirm;
    if (!id) return;
    await api(`/api/tasks/${encodeURIComponent(id)}/run`,{method:'POST',body:'{}'});
    $('#confirm-dialog').close(); await refresh(); selectTask(id); toast('任务已开始，可以在这里查看处理进展。');
  }));
  $('#close-confirm').addEventListener('click',() => $('#confirm-dialog').close());
  $('#keep-draft').addEventListener('click',() => { $('#confirm-dialog').close(); toast('任务已保留，可在“我的任务”中继续。'); });
  $('#confirm-dialog').addEventListener('click', event => { if (event.target===$('#confirm-dialog')) { const rect=event.target.getBoundingClientRect(); if (event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) event.target.close(); } });
  $('#task-filter').addEventListener('change',() => { taskListSignature=''; renderTaskList(); });
  $('#knowledge-search').addEventListener('input',renderKnowledge);
  $('#settings-form').addEventListener('input',() => { settingsDirty=true; });
  $('#provider').addEventListener('change',() => { settingsDirty=true; updateProviderFields(); });
  $('#settings-form').addEventListener('submit',event => {
    event.preventDefault();
    action($('#save-settings'),async () => {
      const data = {provider:$('#provider').value,baseUrl:$('#base-url').value.trim(),model:$('#model-name').value.trim()};
      if ($('#api-key').value.trim()) data.apiKey=$('#api-key').value.trim();
      await api('/api/settings',{method:'POST',body:JSON.stringify(data)});
      settingsDirty=false; $('#api-key').value=''; $('#connection-result').textContent='设置已保存。可以测试连接后再开始任务。'; await refresh(); toast('设置已保存。');
    });
  });
  $('#test-connection').addEventListener('click',event => action(event.currentTarget,async () => {
    $('#connection-result').textContent='正在测试已保存的配置…';
    try { const result=await api('/api/settings/test',{method:'POST',body:'{}'}); $('#connection-result').textContent=result.message || (result.ok?'连接成功。':'连接失败。'); toast(result.message || (result.ok?'连接成功。':'连接失败。'),!result.ok); }
    catch(error) { $('#connection-result').textContent=error.message; throw error; }
  }));
  $('#stop-speech').addEventListener('click',stopSpeech);
  $('#start-simulation').addEventListener('click',startSimulation);
  $('#stop-simulation').addEventListener('click',()=>stopSimulation());
  $('#simulation-preset').addEventListener('change',event=> { $('#simulation-text').value=simulationExamples[event.target.value]; });
  $('#close-simulation').addEventListener('click',()=> { stopSimulation(); $('#simulate-dialog').close(); });
  $('#simulate-dialog').addEventListener('cancel',()=>stopSimulation());
  $('#simulate-dialog').addEventListener('close',()=>stopSimulation());

  document.addEventListener('input',event => {
    if (event.target.id==='result-editor' && selectedTaskId) resultEdits.set(selectedTaskId,event.target.value);
    if (event.target.id==='ask-question' && selectedTaskId) questionDrafts.set(selectedTaskId,event.target.value);
  });
  document.addEventListener('submit',event => {
    if (event.target.id!=='ask-form') return;
    event.preventDefault();
    const id=event.target.dataset.task; const question=$('#ask-question').value.trim(); if (!question || askingTasks.has(id)) return;
    askingTasks.add(id); detailSignature=''; renderTaskDetail();
    action(null,async () => {
      try { await api(`/api/tasks/${encodeURIComponent(id)}/ask`,{method:'POST',body:JSON.stringify({question})}); questionDrafts.delete(id); await refresh(); }
      finally { askingTasks.delete(id); detailSignature=''; renderTaskDetail(); }
    });
  });
  document.addEventListener('click',event => {
    const button=event.target.closest('button,a');
    if (!button) return;
    if (button.dataset.view) { event.preventDefault(); setView(button.dataset.view); return; }
    if (button.dataset.taskId) { selectTask(button.dataset.taskId); return; }
    if (button.dataset.knowledgeId) { selectedKnowledgeId=button.dataset.knowledgeId; knowledgeDetailSignature=''; renderKnowledge(); $('#knowledge-detail').scrollIntoView({block:'start',behavior:'smooth'}); return; }
    if (button.dataset.nativeResult) { action(button,async()=> {
      const data=await api(`/api/tasks/${encodeURIComponent(button.dataset.nativeResult)}/thinkflow-result`);
      $('#native-result-title').textContent=data.document.title;
      $('#native-result-meta').textContent=`直接读取自 ThinkFlow「${data.notebook.name}」 · ${data.document.id} · 当前正文`;
      $('#native-result-content').innerHTML=markdown(data.document.content); $('#native-result-dialog').showModal();
    }); return; }
    if (button.dataset.dictate) { dictate(button.dataset.dictate); return; }
    if (button.dataset.simulate) { showSimulation(button.dataset.simulate); return; }
    if (button.dataset.example) {
      const example=examples[button.dataset.example];
      bindThinkFlow(null);
      $('#task-title').value=example.title; $(`#task-form input[value="${example.kind}"]`).checked=true; $('#task-instruction').value=example.instruction; $('#task-source').value=example.sourceText; $('#task-sources').value=''; toast('示例已填入。可以修改后再确认任务。'); $('#task-title').focus(); return;
    }
    if (button.dataset.preset) {
      const local=button.dataset.preset==='local'; $('#provider').value=local?'ollama':'openai'; $('#base-url').value=local?'http://127.0.0.1:11434':'http://127.0.0.1:8317/v1'; $('#model-name').value=local?'qwen2.5:1.5b':'gpt-6-luna'; settingsDirty=true; updateProviderFields(); toast('预设已填入，点击保存设置后启用。'); return;
    }
    if (button.dataset.download) {
      const entry=state.knowledge.find(item=>item.id===button.dataset.download); if (!entry) return;
      const blob=new Blob([entry.content || ''],{type:'text/markdown;charset=utf-8'}); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`${entry.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g,'_') || '知识成果'}.md`; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); return;
    }
    const task=taskById(selectedTaskId);
    const actionName=button.dataset.action;
    if (actionName==='close-knowledge') { selectedKnowledgeId=null; renderKnowledge(); return; }
    if (!actionName || !task) return;
    if (actionName==='preview') { showConfirmation(task); return; }
    if (actionName==='edit') { if (editingResults.has(task.id)) editingResults.delete(task.id); else editingResults.add(task.id); detailSignature=''; renderTaskDetail(); return; }
    if (actionName==='speak') { speak(resultEdits.has(task.id)?resultEdits.get(task.id):task.result?.markdown); return; }
    if (actionName==='open-knowledge') { selectedKnowledgeId=task.knowledgeId; knowledgeDetailSignature=''; setView('knowledge'); return; }
    action(button,async () => {
      const path=`/api/tasks/${encodeURIComponent(task.id)}`;
      if (actionName==='cancel') { await api(`${path}/cancel`,{method:'POST',body:'{}'}); await refresh(); toast('任务已取消。'); }
      if (actionName==='save-result') { const content=resultEdits.has(task.id)?resultEdits.get(task.id):task.result?.markdown; if (!content?.trim()) throw new Error('整理结果不能为空。'); await api(`${path}/result`,{method:'PUT',body:JSON.stringify({markdown:content})}); resultEdits.delete(task.id); await refresh(); toast('修改已保存。'); }
      if (actionName==='archive') { const content=resultEdits.has(task.id)?resultEdits.get(task.id):task.result?.markdown; if (!content?.trim()) throw new Error('整理结果不能为空。'); if (resultEdits.has(task.id)) await api(`${path}/result`,{method:'PUT',body:JSON.stringify({markdown:content})}); try { await api(`${path}/archive`,{method:'POST',body:JSON.stringify({content})}); resultEdits.delete(task.id); toast(task.thinkflow?'已确认，结果已写入 ThinkFlow 并读取核对。':'已确认，成果已收入知识库。'); } finally { await refresh(); } }
    });
  });

  window.addEventListener('hashchange',()=>setView(location.hash.slice(1) || 'workspace'));
  document.addEventListener('visibilitychange',()=> { if (document.visibilityState==='visible') refresh(); });
  window.addEventListener('beforeunload',()=> { stopSpeech(); stopSimulation(); });
  $('#workspace-date').textContent=new Intl.DateTimeFormat('en-GB',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/New_York'}).format(new Date()).split('/').reverse().join(' / ');
  setView(location.hash.slice(1) || 'workspace',false);
  refresh();
  setInterval(()=> { if (document.visibilityState==='visible') refresh(); },1500);
})();
