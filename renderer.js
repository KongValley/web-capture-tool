'use strict';
// 面板渲染进程：无框架，纯 DOM。nodeIntegration=true，因此可直接用 require('electron') 拿 ipcRenderer / clipboard。
const { ipcRenderer, clipboard } = require('electron');

const $ = (id) => document.getElementById(id);
const el = { list: $('list'), ws: $('ws'), detail: $('detail'), filter: $('filter'), type: $('typeFilter') };

const rows = new Map();     // id -> {rec, node}
let selected = null;
let detailId = null;
let view = 'list';

/* ------------------------------------------------------------- 列表渲染 */

const statusClass = (s) => (s === 0 ? '' : s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2');

function matches(rec) {
  const f = el.filter.value.trim().toLowerCase();
  if (el.type.value && rec.type !== el.type.value) return false;
  if (!f) return true;
  return rec.url.toLowerCase().includes(f) || rec.method.toLowerCase().includes(f) || rec.type.toLowerCase().includes(f);
}

function visible(node) { return node.style.display !== 'none'; }

function makeRow(rec) {
  const node = document.createElement('div');
  node.className = 'row';
  node.innerHTML = '<span class="m"></span><span class="s"></span><span class="u"></span><span class="t"></span>';
  node.onclick = () => select(rec.id);
  return node;
}

function paintRow(node, rec) {
  node.dataset.m = rec.method;
  node.children[0].textContent = rec.method;
  const s = node.children[1];
  s.textContent = rec.status || (rec.failed ? '×' : '…');
  s.className = 's ' + statusClass(rec.status);
  node.children[2].textContent = rec.url;
  node.title = rec.url;
  node.children[3].textContent = rec.duration != null ? rec.duration + 'ms' : rec.type;
  node.children[3].className = 't' + (rec.failed ? ' s4' : '');
}

function appendRecord(rec) {
  if (rows.has(rec.id)) return;
  const node = makeRow(rec);
  paintRow(node, rec);
  node.style.display = matches(rec) ? '' : 'none';
  const empty = el.list.querySelector('.empty');
  if (empty) empty.remove();
  el.list.appendChild(node);
  rows.set(rec.id, { rec, node });
  if (selected === rec.id) node.classList.add('sel');
  updateCounts();
}

function updateRecord(rec) {
  const r = rows.get(rec.id);
  if (!r) return appendRecord(rec);
  r.rec = rec;
  paintRow(r.node, rec);
  r.node.style.display = matches(rec) ? '' : 'none';
  if (selected === rec.id) renderDetail(rec.id);
  updateCounts();
}

function updateCounts() {
  let n = 0;
  for (const { node } of rows.values()) if (visible(node)) n++;
  $('nReq').textContent = n;
  $('count').textContent = rows.size;
}

function refilter() { for (const { rec, node } of rows.values()) node.style.display = matches(rec) ? '' : 'none'; updateCounts(); }

/* ------------------------------------------------------------- 详情渲染 */

const esc = (s) => String(s == null ? '' : s);

function headersBlock(title, headers, raw) {
  const merged = [];
  const seen = new Set();
  for (const src of [raw, headers]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (seen.has(k.toLowerCase())) continue;   // 原始头优先，去重
      seen.add(k.toLowerCase());
      merged.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
  }
  return merged.length ? `<h3>${title}</h3><pre>${merged.map(esc).join('\n')}</pre>` : '';
}

function bodyBlock(r) {
  if (r.bodyError) return `<h3>响应体</h3><pre class="muted">未保存：${esc(r.bodyError)}</pre>`;
  if (r.body == null) return `<h3>响应体</h3><pre class="muted">（无 / 未捕获）</pre>`;
  if (r.bodyBase64) {
    const kb = Math.round((r.body.length * 3) / 4096);
    return `<h3>响应体（二进制 ≈${kb}KB）</h3><pre class="muted">base64 已保存在「导出全部」的 JSON 与「响应体存盘」的文件中，此处不展开。</pre>`;
  }
  return `<h3>响应体</h3><pre>${esc(r.body)}</pre>`;
}

function renderDetail(id) {
  const entry = rows.get(id);
  detailId = id;
  el.detail.classList.add('on');
  if (!entry) { el.detail.innerHTML = '<div class="empty">记录已被清理</div>'; return; }
  ipcRenderer.invoke('cap:detail', id).then((d) => {
    if (!d) { el.detail.innerHTML = '<div class="empty">未找到记录 #' + esc(id) + '</div>'; return; }
    el.detail.innerHTML =
      `<div class="dbar"><button id="copyCurl">复制 cURL</button><button id="replayReq">重放请求</button></div>` +
      `<h3>概要</h3><pre><span class="kv">URL     </span>${esc(d.url)}
<span class="kv">方法    </span>${esc(d.method)}  <span class="kv">状态</span> ${esc(d.status)} ${esc(d.statusText)}
<span class="kv">类型    </span>${esc(d.type)}  <span class="kv">MIME</span> ${esc(d.mime)}
<span class="kv">远端    </span>${esc(d.remoteIP)}  ${esc(d.protocol)}  <span class="kv">耗时</span> ${d.durationMs == null ? '-' : d.durationMs + 'ms'}  <span class="kv">大小</span> ${d.encodedDataLength}B
<span class="kv">时间    </span>${esc(d.time)}</pre>` +
      (d.failed ? `<h3>失败</h3><pre class="s4">${esc(d.failed.errorText)}${d.failed.blockedReason ? ' · ' + esc(d.failed.blockedReason) : ''}</pre>` : '') +
      (d.redirects.length ? `<h3>重定向链</h3><pre>${d.redirects.map((x) => `${x.status} ${esc(x.url)}\n   → ${esc(x.location)}`).join('\n')}</pre>` : '') +
      headersBlock('请求头（原始，含 Cookie）', d.requestHeaders, d.requestHeadersRaw) +
      (d.postData ? `<h3>请求体</h3><pre>${esc(d.postData)}</pre>` : '') +
      headersBlock('响应头（原始，含 Set-Cookie）', d.responseHeaders, d.responseHeadersRaw) +
      bodyBlock(d);
  });
}

function select(id) {
  if (selected && rows.has(selected)) rows.get(selected).node.classList.remove('sel');
  selected = id;
  if (rows.has(id)) rows.get(id).node.classList.add('sel');
  view = 'list';
  syncTabs();
  renderDetail(id);
}

/* --------------------------------------------------------------- 视图切换 */

function syncTabs() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
  el.list.classList.toggle('on', view === 'list');
  el.ws.classList.toggle('on', view === 'ws');
  el.detail.classList.toggle('on', view === 'list' && selected != null);
}

/* -------------------------------------------------------------- WebSocket */

function appendWs(frame) {
  const empty = el.ws.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  const t = new Date(frame.time).toLocaleTimeString();
  const map = { open: '⇡ 建立', close: '✕ 关闭', error: '! 错误', sent: '→ 发送', recv: '← 接收' };
  div.textContent = `[${t}] ${map[frame.kind] || frame.kind} ${frame.url || ''} ${frame.error || ''}\n${frame.payload || ''}`.trimEnd();
  el.ws.appendChild(div);
  $('nWs').textContent = el.ws.children.length;
  if (view === 'ws') el.ws.scrollTop = el.ws.scrollHeight;
}

/* ---------------------------------------------------------------- 模态框 */

function openModal(title, bodyParts, buttons) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = '';
  for (const p of [].concat(bodyParts)) if (p) body.appendChild(p);
  const foot = $('modalFoot');
  foot.innerHTML = '';
  for (const b of buttons || []) {
    const btn = document.createElement('button');
    btn.id = b.id || '';
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    btn.onclick = b.onClick;
    foot.appendChild(btn);
  }
  $('modal').hidden = false;
}

function closeModal() { $('modal').hidden = true; }

function labelled(text, inputEl) {
  const w = document.createElement('div');
  w.style.marginBottom = '8px';
  const l = document.createElement('div');
  l.className = 'lbl';
  l.textContent = text;
  w.appendChild(l);
  w.appendChild(inputEl);
  return w;
}

function textarea(placeholder, value) {
  const t = document.createElement('textarea');
  t.placeholder = placeholder;
  if (value) t.value = value;
  return t;
}

function dataTable(cols, rows) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c; htr.appendChild(th); }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      td.textContent = row[c] == null ? '' : String(row[c]);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/* ---------------------------------------------------------------- 轻提示 */

// 非阻塞提示：最多同时 4 条，超出移除最早的一条
function toast(msg, kind = 'info', ms = 4000) {
  const box = $('toasts');
  const div = document.createElement('div');
  div.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  div.textContent = String(msg);
  box.appendChild(div);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => div.remove(), ms);
  return div;
}

/* ------------------------------------------------------------ 保存与导出 */

function saveText(content, defaultName) {
  return ipcRenderer.invoke('cap:saveText', { defaultName, content }).then((r) => {
    if (r && r.ok) $('status').textContent = '已保存：' + r.file;
    else if (r && r.canceled) $('status').textContent = '已取消保存';
    else if (r && r.error) toast('保存失败：' + r.error, 'err');
  });
}

function exportResult(p) {
  p.then((r) => {
    if (r && r.ok) $('status').textContent = '已保存：' + r.file;
    else if (r && r.canceled) $('status').textContent = '已取消保存';
    else if (r && r.error) toast('导出失败：' + r.error, 'err');
  });
}

/* ------------------------------------------------------------------ 事件 */

$('go').onclick = () => navigate($('url').value);
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate($('url').value); });
$('back').onclick = () => ipcRenderer.invoke('cap:back');
$('fwd').onclick = () => ipcRenderer.invoke('cap:forward');
$('reload').onclick = () => ipcRenderer.invoke('cap:reload');
$('clear').onclick = () => ipcRenderer.invoke('cap:clear').then(() => {
  rows.clear(); el.list.innerHTML = '<div class="empty">等待抓取…</div>';
  el.ws.innerHTML = ''; el.detail.innerHTML = ''; selected = null; detailId = null;
  $('nWs').textContent = '0'; updateCounts();
});
$('toggle').onclick = () => ipcRenderer.invoke('cap:setEnabled', !toggleState).then((v) => {
  toggleState = v; $('toggle').textContent = v ? '暂停' : '继续';
});
$('pageData').onclick = () => ipcRenderer.invoke('cap:pageData').then((d) => {
  const pre = document.createElement('pre');
  pre.textContent = `当前页：${d.title || '(无标题)'}\nURL：${d.url}\nHTML：${d.htmlLength} 字符\nCookie：${d.cookies.length} 条\nlocalStorage：${Object.keys(d.page.localStorage || {}).length} 项\nsessionStorage：${Object.keys(d.page.sessionStorage || {}).length} 项\n\ndocument.cookie：\n${d.page.cookies || '(空)'}`;
  openModal('页面数据', [pre], [{ label: '关闭', onClick: closeModal }]);
});
$('expAll').onclick = () => exportResult(ipcRenderer.invoke('cap:exportAll'));
$('expHtml').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHtml'));
$('expCookie').onclick = () => exportResult(ipcRenderer.invoke('cap:exportCookieJson'));
$('expHar').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHar'));
$('modalClose').onclick = closeModal;

/* ---- 详情：复制 cURL / 重放（详情 HTML 每次重建，只能事件委托）---- */
el.detail.addEventListener('click', async (e) => {
  const id = e.target && e.target.id;
  if (id === 'copyCurl') {
    if (detailId == null) return;
    const r = await ipcRenderer.invoke('cap:format', 'curl', detailId);
    if (!r.ok) return toast(r.error, 'err');
    clipboard.writeText(r.text);
    $('status').textContent = '已复制 cURL 到剪贴板';
  } else if (id === 'replayReq') {
    if (detailId == null) return;
    $('status').textContent = '重放中…';
    const r = await ipcRenderer.invoke('cap:replay', detailId);
    const h = document.createElement('h3');
    h.textContent = '重放结果';
    const pre = document.createElement('pre');
    pre.textContent = r.ok
      ? `${r.status} ${r.statusText}  ${r.tookMs}ms${r.truncated ? '（响应体已截断到 1MB）' : ''}\n${JSON.stringify(r.headers, null, 2)}\n\n${r.body}`
      : '重放失败：' + r.error;
    el.detail.appendChild(h);
    el.detail.appendChild(pre);
    $('status').textContent = r.ok ? `重放完成：${r.status}` : '重放失败';
  }
});

/* ---- 抓取设置 ---- */
const UA_PRESETS = {
  win10: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  win7: 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36',
};

function cfg(key, value) {
  return ipcRenderer.invoke('cap:cfg', { key, value }).then((r) => {
    if (!r || !r.ok) { toast('设置失败：' + ((r && r.error) || '未知错误'), 'err'); return r; }
    if (r.needReload) $('status').textContent = '已应用（刷新页面后生效）';
    if (r.needRestart) $('status').textContent = '已应用（重启后生效）';
    return r;
  });
}

$('blockMode').addEventListener('change', () => cfg('blockMode', $('blockMode').value));
$('blockKeywords').addEventListener('change', () => cfg('blockKeywords', $('blockKeywords').value));
$('recordOnly').addEventListener('change', () => cfg('recordOnly', $('recordOnly').checked));
$('throttle').addEventListener('change', () => cfg('throttle', $('throttle').value));
$('headers').addEventListener('change', () => cfg('headers', $('headers').value));
$('proxy').addEventListener('change', () => cfg('proxy', $('proxy').value));
$('uaSel').addEventListener('change', () => {
  const v = $('uaSel').value;
  const custom = v === 'custom';
  $('uaCustom').hidden = !custom;
  if (custom) { $('uaCustom').focus(); return; }
  cfg('ua', UA_PRESETS[v] || '');
});
$('uaCustom').addEventListener('change', () => cfg('ua', $('uaCustom').value));

/* ---- 自动化 ---- */
const REASON = { done: '完成', 'no-next': '未找到「下一页」', stopped: '已停止', timeout: '超时' };

function setAutoBusy(busy) {
  $('autoScroll').disabled = busy;
  $('autoPage').disabled = busy;
  $('autoStop').disabled = !busy;
}

async function runAuto(opts) {
  setAutoBusy(true);
  try {
    const r = await ipcRenderer.invoke('cap:auto', opts);
    if (!r || !r.ok) return toast('自动化失败：' + ((r && r.error) || '未知错误'), 'err');
    const amount = r.mode === 'scroll' ? `${r.rounds} 轮` : `${r.pages} 页`;
    $('status').textContent = `自动化${REASON[r.reason] || r.reason}：${amount}`;
  } finally {
    setAutoBusy(false);
  }
}

$('autoScroll').onclick = () => runAuto({ mode: 'scroll', rounds: +$('scrollRounds').value });
$('autoPage').onclick = () => runAuto({ mode: 'page', pages: +$('pageCount').value, delay: +$('pageDelay').value });
$('autoStop').onclick = () => ipcRenderer.invoke('cap:autoStop');

/* ---- CSS 选择器提取 ---- */
let lastExtract = null;

$('extract').onclick = () => {
  const selRows = textarea('行选择器，例如 .item', '');
  const selFields = textarea('每行 名称=选择器[@属性]，例如\n标题=.title\n链接=a@href\n正文=@html', '');
  const out = document.createElement('div');

  const run = async () => {
    const r = await ipcRenderer.invoke('cap:extract', { rows: selRows.value, fields: selFields.value });
    out.innerHTML = '';
    if (!r || !r.ok) { toast('提取失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    lastExtract = r.rows;
    const cols = [];
    for (const row of r.rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
    out.appendChild(dataTable(cols, r.rows.slice(0, 20)));
    const tip = document.createElement('div');
    tip.className = 'lbl';
    tip.textContent = `共 ${r.count} 行${r.truncated ? '（已截断到 5000）' : ''}${r.count > 20 ? '，预览前 20 行' : ''}`;
    out.appendChild(tip);
    $('status').textContent = `提取 ${r.count} 行`;
  };

  openModal('CSS 选择器提取', [
    labelled('行选择器（每条记录的容器）', selRows),
    labelled('字段（每行 名称=选择器[@属性]）', selFields),
    out,
  ], [
    { id: 'extractRun', label: '提取', primary: true, onClick: run },
    { label: '导出 CSV', onClick: async () => {
      if (!lastExtract) return toast('请先提取', 'warn');
      const f = await ipcRenderer.invoke('cap:format', 'rowsCsv', lastExtract);
      saveText(f.text, 'data.csv');
    } },
    { label: '导出 JSON', onClick: () => {
      if (!lastExtract) return toast('请先提取', 'warn');
      saveText(JSON.stringify(lastExtract, null, 2), 'data.json');
    } },
  ]);
};

/* ---- 页面清单 / 表格 CSV ---- */
$('harvest').onclick = async () => {
  const hv = await ipcRenderer.invoke('cap:harvest');
  if (!hv || !hv.ok) return toast('提取失败：' + ((hv && hv.error) || '未知错误'), 'err');
  const stat = document.createElement('div');
  stat.textContent = `链接 ${hv.links.length} · 图片 ${hv.images.length} · 表单 ${hv.forms.length} · 表格 ${hv.tables.length}`;
  const table = dataTable(['序号', '行数', '列数', '表头'], hv.tables.map((t) => ({
    序号: t.index + 1, 行数: t.rows.length, 列数: (t.headers || []).length, 表头: (t.headers || []).join(' | '),
  })));
  openModal(`页面清单 — ${hv.title || hv.url}`, [stat, table, labelled('表格（每表一段，导出为一个 CSV 文件）', document.createElement('div'))], [
    { label: '导出清单 JSON', primary: true, onClick: () => saveText(JSON.stringify(hv, null, 2), 'harvest.json') },
    { label: '表格 → CSV', onClick: async () => {
      if (!hv.tables.length) return toast('本页没有表格', 'warn');
      const f = await ipcRenderer.invoke('cap:format', 'tablesCsv', hv.tables);
      saveText(f.text, 'tables.csv');
    } },
  ]);
};

/* ---- 响应体存盘 ---- */
$('saveBodies').onclick = () => ipcRenderer.invoke('cap:saveBodies').then((r) => {
  if (!r) return;
  if (r.canceled) return void ($('status').textContent = '已取消');
  if (!r.ok) return toast('存盘失败：' + r.error, 'err');
  toast(`已写入 ${r.written} 个文件 → ${r.dir}（跳过 ${r.skipped} 条无响应体）`, 'ok', 7000);
});

/* ---- 应用设置：软件渲染 / GPU 状态 ---- */
async function openAppSettings() {
  const gs = await ipcRenderer.invoke('cap:gpuStatus');
  const box = document.createElement('div');

  const hint = document.createElement('div');
  hint.className = 'lbl';
  hint.hidden = true;
  hint.style.margin = '6px 0';

  const row = document.createElement('label');
  row.className = 'lbl';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'swRender';
  cb.checked = !!gs.softwareMode;
  cb.onchange = async () => {
    const r = await ipcRenderer.invoke('cap:cfg', { key: 'softwareRendering', value: cb.checked });
    if (!r || !r.ok) {
      toast('设置失败：' + ((r && r.error) || '未知错误'), 'err');
      cb.checked = !cb.checked;
      return;
    }
    hint.textContent = `已${cb.checked ? '开启' : '关闭'}软件渲染，重启后生效`;
    hint.hidden = false;
  };
  row.appendChild(cb);
  row.appendChild(document.createTextNode(' 强制软件渲染（无显卡 / 驱动异常的机器）'));
  box.appendChild(row);
  box.appendChild(hint);

  const info = document.createElement('pre');
  info.style.marginTop = '4px';
  info.textContent = `GPU 合成状态：${gs.gpuCompositing || '(未知)'}
判定为软件渲染：${gs.looksSoftware ? '是' : '否'}
当前运行模式：${gs.softwareMode ? '软件渲染' : '硬件加速'}
GPU 进程异常次数：${gs.crashes}

说明：核显（Intel HD/UHD、AMD APU）同样属于硬件加速，正常不会被判定为不可用；
只有驱动缺失、显卡过老（不满足 D3D11）或虚拟机/远程桌面才会落到软件渲染。`;
  box.appendChild(info);

  openModal('设置', [box], [
    { label: '立即重启', onClick: () => ipcRenderer.invoke('cap:restart') },
    { label: '关闭', primary: true, onClick: closeModal },
  ]);
}

$('appSettings').onclick = openAppSettings;
$('bannerClose').onclick = () => { $('banner').hidden = true; };
ipcRenderer.on('cap:banner', (_e, b) => {
  $('bannerText').textContent = b.text;
  const act = $('bannerAction');
  const isRestart = b.action === 'restart';
  act.textContent = isRestart ? '立即重启' : '打开设置';
  act.onclick = () => { if (isRestart) ipcRenderer.invoke('cap:restart'); else openAppSettings(); };
  $('banner').hidden = false;
});

async function navigate(input) {
  const r = await ipcRenderer.invoke('cap:navigate', input);
  if (!r.ok) $('status').textContent = r.error;
  else $('url').value = input.trim();
}

el.filter.addEventListener('input', refilter);
el.type.addEventListener('change', refilter);
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => { view = t.dataset.view; syncTabs(); }; });

ipcRenderer.on('cap:record', (_e, rec) => appendRecord(rec));
ipcRenderer.on('cap:update', (_e, rec) => updateRecord(rec));
ipcRenderer.on('cap:drop', (_e, id) => { const r = rows.get(id); if (r) r.node.remove(); rows.delete(id); updateCounts(); });
ipcRenderer.on('cap:ws', (_e, frame) => appendWs(frame));
ipcRenderer.on('cap:status', (_e, s) => { $('status').textContent = s; });
ipcRenderer.on('cap:navigated', (_e, d) => {
  $('url').value = d.url;
  $('back').disabled = !d.canGoBack;
  $('fwd').disabled = !d.canGoForward;
});

/* -------------------------------------------------------------- 初始化 */

let toggleState = true;
(async () => {
  const d = await ipcRenderer.invoke('cap:list');
  toggleState = d.enabled;
  $('toggle').textContent = d.enabled ? '暂停' : '继续';
  $('status').textContent = d.status;
  if (d.url && d.url !== 'about:blank') $('url').value = d.url;
  // 同步面板宽度：主进程按 panelWidth 摆放原生视图
  await ipcRenderer.invoke('cap:panelWidth', $('panel').offsetWidth);
  d.records.forEach(appendRecord);
  (d.wsFrames || []).forEach(appendWs);
  updateCounts();
  syncTabs();

  // 回填爬虫设置控件
  const cfgAll = await ipcRenderer.invoke('cap:cfgAll');
  $('blockMode').value = cfgAll.blockMode;
  $('blockKeywords').value = cfgAll.blockKeywords;
  $('recordOnly').checked = !!cfgAll.recordOnly;
  $('throttle').value = cfgAll.throttle;
  $('headers').value = cfgAll.headers;
  $('proxy').value = cfgAll.proxy;
  if (cfgAll.ua) {
    const preset = Object.keys(UA_PRESETS).find((k) => UA_PRESETS[k] === cfgAll.ua);
    if (preset) $('uaSel').value = preset;
    else { $('uaSel').value = 'custom'; $('uaCustom').hidden = false; $('uaCustom').value = cfgAll.ua; }
  }
})();
