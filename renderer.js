'use strict';
// 面板渲染进程：无框架，纯 DOM。nodeIntegration=true，因此可直接用 require('electron') 拿 ipcRenderer / clipboard。
const { ipcRenderer, clipboard } = require('electron');

const $ = (id) => document.getElementById(id);
const el = { list: $('list'), ws: $('ws'), wsView: $('wsView'), detail: $('detail'), filter: $('filter'), type: $('typeFilter') };

const rows = new Map();     // id -> {rec, node, visible}（node 可能为 null：超出渲染上限后仅保留数据）
const LIST_MAX_ROWS = 3000; // 列表最多渲染的行数（超出后移除最早的 DOM，数据仍在内存与导出里）
let domRows = 0;            // 当前 DOM 里的行数
let visibleCount = 0;       // 当前可见行数（过滤命中的行，增量维护；updateCounts 直接用它）
let listNew = 0;            // 未读新记录数（用户不在底部时累计）
let selected = null;
let detailId = null;
let detailData = null;      // 当前详情面板对应的记录（复制按钮用）
let view = 'list';
let pickTarget = '';      // 元素拾取的回填目标：'tools' | 'extract' | ''（空 = 只写剪贴板）

const BODY_PREVIEW = 200 * 1024;          // 详情里文本响应体的预览上限
const detailFull = new Set();             // 记录「已展开全文」的记录 id

/* ---------------------------------------------------------- 面板宽度拖拽 */

const PANEL_MIN = 320, PANEL_MAX = 1000;
let dragging = false, dragRaf = 0;
const applyPanelWidth = (w) => { $('panel').style.width = w + 'px'; };
const readPanelWidth = () => Math.round($('panel').getBoundingClientRect().width);

// mousedown/mousemove/mouseup（合成事件在自检里可用；Pointer Events 的 setPointerCapture 不能）
$('splitter').addEventListener('mousedown', (e) => {
  dragging = true;
  $('splitter').classList.add('on');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - e.clientX));
  applyPanelWidth(w);
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => { dragRaf = 0; ipcRenderer.invoke('cap:panelWidth', readPanelWidth()); });
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  $('splitter').classList.remove('on');
  ipcRenderer.invoke('cap:panelWidth', readPanelWidth());   // 收尾：主进程按最终宽度摆放视图并落盘
});

/* ------------------------------------------------------------- 列表渲染 */

const statusClass = (s) => (s === 0 ? '' : s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2');

// 响应体全文搜索（过滤语法 body:"文本"）：命中集合由主进程算，300ms 防抖后回填
let bodyHits = null;      // Set<id>；null = 当前没有生效中的 body 过滤
let bodyQuery = '';
let bodySearchTimer = null;

/* --------------------------------------------------------- 过滤语法（纯函数） */

// 数字带 k/m 后缀：100k = 102400
function parseNumToken(v) {
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(v);
  if (!m) return null;
  const mult = m[2] === 'k' ? 1024 : m[2] === 'm' ? 1048576 : 1;
  return Number(m[1]) * mult;
}

// '>100k' / '>=400' / '<500' / '204'；没有比较符时是精确相等
function cmpNumber(value, v) {
  if (value == null) return false;
  const c = /^(>=|<=|>|<)(.+)$/.exec(v);
  const target = parseNumToken(c ? c[2] : v);
  if (target == null) return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (!c) return n === target;
  if (c[1] === '>=') return n >= target;
  if (c[1] === '<=') return n <= target;
  if (c[1] === '>') return n > target;
  return n < target;
}

function matchStatus(status, v) {
  const s = Number(status) || 0;
  const klass = /^(\d)xx$/.exec(v);
  if (klass) { const d = Number(klass[1]) * 100; return s >= d && s < d + 100; }
  return cmpNumber(s, v);
}

function matchToken(rec, token) {
  const i = token.indexOf(':');
  if (i <= 0) return String(rec.url || '').toLowerCase().includes(token);
  const key = token.slice(0, i);
  const v = token.slice(i + 1);
  switch (key) {
    case 'method': return String(rec.method || '').toLowerCase() === v;
    case 'status': return matchStatus(rec.status, v);
    case 'type': return String(rec.type || '').toLowerCase() === v;
    case 'mime': return String(rec.mime || '').toLowerCase().includes(v);
    case 'domain': {
      let h = '';
      try { h = new URL(rec.url).hostname.toLowerCase(); } catch (e) { return false; }
      return h === v || h.endsWith('.' + v);
    }
    case 'size': return cmpNumber(rec.size, v);
    case 'time': return cmpNumber(rec.duration, v);
    case 'star': return (v === '1' || v === 'yes') === !!rec.star;
    case 'body': return bodyHits ? bodyHits.has(rec.id) : false;
    default: return String(rec.url || '').toLowerCase().includes(token);
  }
}

// 空白切分，全部命中才算匹配（AND）；以 ! 开头的 token 取反
function matchQuery(rec, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  for (const part of q.split(/\s+/)) {
    if (!part) continue;
    const neg = part.startsWith('!');
    const token = neg ? part.slice(1) : part;
    if (!token) continue;
    const hit = matchToken(rec, token);
    if (neg ? hit : !hit) return false;
  }
  return true;
}

function matches(rec) {
  if (el.type.value && rec.type !== el.type.value) return false;
  return matchQuery(rec, el.filter.value);
}

// 行在 DOM 里且没被过滤隐藏
const visible = (node) => !!node && node.style.display !== 'none';

// 行可见性的唯一入口：display 与 visibleCount 永远一起改（过滤 / 新记录 / 上限移除都走这里）
function setRowVisible(id, want) {
  const r = rows.get(id);
  if (!r || !r.node) return;
  const should = !!want;
  if (r.visible === should) return;
  r.visible = should;
  visibleCount += should ? 1 : -1;
  r.node.style.display = should ? '' : 'none';
}

// 把行从列表里移除（超出上限 / 主进程 drop），计数一起维护
function dropRow(id) {
  const r = rows.get(id);
  if (!r) return;
  if (r.node) r.node.remove();
  if (r.visible) visibleCount--;
  domRows--;
  rows.delete(id);
}

// 清空列表与计数（「清空」按钮 / 会话恢复前调用）
function resetListDom() {
  rows.clear();
  visibleCount = 0;
  domRows = 0;
  listNew = 0;
  el.list.innerHTML = '<div class="empty">等待抓取…</div>';
  el.ws.innerHTML = '';
  $('nWs').textContent = '0';
  updateListNew();
  updateListNote();
  updateCounts();
}

function makeRow(rec) {
  const node = document.createElement('div');
  node.className = 'row';
  node.dataset.id = rec.id;
  node.innerHTML = '<span class="m"></span><span class="s"></span><span class="u"></span><span class="t"></span><span class="z"></span>';
  node.onclick = () => select(rec.id);
  node.oncontextmenu = (e) => {
    e.preventDefault();
    select(rec.id);
    showContextMenu(e.clientX, e.clientY, rowMenuItems(rec.id));
  };
  return node;
}

function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
  return (n / 1048576).toFixed(1) + 'M';
}

function paintRow(node, rec) {
  const mode = $('colSet').value;
  el.list.dataset.cols = mode;
  node.dataset.restored = rec.restored ? '1' : '';
  node.dataset.star = rec.star ? '1' : '';
  node.dataset.m = rec.method;
  node.children[0].textContent = rec.method;
  const s = node.children[1];
  s.textContent = rec.status || (rec.failed ? '×' : '…');
  s.className = 's ' + statusClass(rec.status);
  node.children[2].textContent = rec.url;
  node.title = rec.url;
  const t = node.children[3];
  const z = node.children[4];
  if (mode === 't') {
    t.textContent = String(rec.time || '').slice(11, 19);
    z.textContent = '';
  } else {
    t.textContent = rec.duration != null ? rec.duration + 'ms' : rec.type;
    z.textContent = mode === 'dt' ? `${rec.type} ${humanSize(rec.size)}` : '';
  }
  t.className = 't' + (rec.failed ? ' s4' : '');
  z.className = 'z';
}

function listAtBottom() {
  return el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight <= 40;
}

function updateListNew() {
  $('listNew').hidden = listNew <= 0;
  $('listNew').textContent = `↓ ${listNew} 条新记录`;
}

function updateListNote() {
  if (bodyHits) {                                  // body: 生效期间优先显示命中数
    $('listNote').hidden = false;
    $('listNote').textContent = `响应体命中 ${bodyHits.size} 条`;
    return;
  }
  const hidden = rows.size - domRows;
  $('listNote').hidden = hidden <= 0;
  $('listNote').textContent = hidden > 0 ? `已隐藏更早 ${hidden} 条（可导出）` : '';
}

function appendRecord(rec) {
  if (rows.has(rec.id)) return;
  const node = makeRow(rec);
  paintRow(node, rec);
  const empty = el.list.querySelector('.empty');
  if (empty) empty.remove();
  el.list.appendChild(node);
  rows.set(rec.id, { rec, node, visible: false });
  domRows++;
  setRowVisible(rec.id, matches(rec));
  if (selected === rec.id) node.classList.add('sel');
  if (listAtBottom()) el.list.scrollTop = el.list.scrollHeight;
  else { listNew++; updateListNew(); }
  while (domRows > LIST_MAX_ROWS) {
    const first = el.list.querySelector('.row');
    if (!first) break;
    const item = rows.get(Number(first.dataset.id));
    if (item) {                                   // 只丢 DOM，数据留在内存（导出/过滤仍可用）
      if (item.visible) visibleCount--;
      item.node = null;
      item.visible = false;
    }
    first.remove();
    domRows--;
  }
  updateCounts();
  updateListNote();
  if (view === 'wf') scheduleWaterfall();
}

function updateRecord(rec) {
  const r = rows.get(rec.id);
  if (!r) return appendRecord(rec);
  r.rec = rec;
  if (r.node) {
    paintRow(r.node, rec);
    setRowVisible(rec.id, matches(rec));
  }
  if (selected === rec.id) scheduleDetailRender(rec.id);
  updateCounts();
  if (view === 'wf') scheduleWaterfall();
}

// 可见数由 setRowVisible / dropRow 增量维护，这里只写文本（O(1)，不再每行扫 DOM）
function updateCounts() {
  $('nReq').textContent = visibleCount;
  $('count').textContent = rows.size;
}

function refilter() {
  for (const [id, r] of rows) {
    if (!r.node) continue;                  // 已超出渲染上限的行只在内存里
    paintRow(r.node, r.rec);                // 列预设可能刚切换，逐行重画
    setRowVisible(id, matches(r.rec));
  }
  updateCounts();
}

/* ------------------------------------------------------------- 详情渲染 */

const esc = (s) => String(s == null ? '' : s);
// HTML 属性值转义（详情面板里的输入框 value=...）；页面文本本身按既有做法不转义
const escAttr = (s) => esc(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// 原始头优先去重后的「名称: 值」行（列表展示与复制共用一份实现）
function headersLines(headers, raw) {
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
  return merged;
}

function headersText(headers, raw) {
  return headersLines(headers, raw).join('\n');
}

function headersBlock(title, headers, raw) {
  const merged = headersLines(headers, raw);
  return merged.length ? `<h3>${title}</h3><pre>${merged.map(esc).join('\n')}</pre>` : '';
}

function bodyBlock(r) {
  if (r.bodyError) return `<h3>响应体</h3><pre class="muted">未保存：${esc(r.bodyError)}</pre>`;
  if (r.body == null) return `<h3>响应体</h3><pre class="muted">（无 / 未捕获）</pre>`;
  if (r.bodyBase64) {
    const kb = Math.round((r.body.length * 3) / 4096);
    return `<h3>响应体（二进制）</h3><pre class="muted">二进制 ≈${kb}KB，不在此展开</pre>` +
      '<div class="dbar"><button id="bodySave">另存为文件</button></div>';
  }
  const big = r.body.length > BODY_PREVIEW;
  const expanded = !!detailFull.has(r.id);
  const shown = big && !expanded ? r.body.slice(0, BODY_PREVIEW) : r.body;
  const size = (r.body.length / 1048576).toFixed(1);
  const note = !big ? '' : expanded
    ? `<div class="lbl">已展开全部 ${size}MB</div>`
    : `<div class="lbl">已截断显示前 200KB（完整 ${size}MB）</div>`;
  return `<h3>响应体</h3><pre>${esc(shown)}</pre>${note}` +
    `<div class="dbar"><button id="bodySave">另存为文件</button>${big ? `<button id="bodyToggle">${expanded ? '收起' : '查看全文'}</button>` : ''}</div>`;
}

function renderDetail(id) {
  window.__detailRenders = (window.__detailRenders || 0) + 1;   // 自检观测点
  const entry = rows.get(id);
  detailId = id;
  el.detail.classList.add('on');
  if (!entry) { el.detail.innerHTML = '<div class="empty">记录已被清理</div>'; return; }
  ipcRenderer.invoke('cap:detail', id).then((d) => {
    if (!d) { el.detail.innerHTML = '<div class="empty">未找到记录 #' + esc(id) + '</div>'; return; }
    detailData = d;
    el.detail.innerHTML =
      `<div class="dbar"><button id="markStar">${d.star ? '★ 已标记（点击取消）' : '★ 标记'}</button><button id="copyCurl">复制 cURL</button><button id="replayReq">重放请求</button><button id="expOne">导出此条</button><button id="saveReq">请求体另存</button><button id="copyUrl">复制 URL</button><button id="copyRespHeaders">复制响应头</button><button id="copyBody">复制响应体</button><button id="codeBtn">复制代码…</button></div>` +
      `<input id="markComment" placeholder="备注（回车保存）" value="${escAttr(d.comment || '')}">` +
      `<h3>概要</h3><pre><span class="kv">URL     </span>${esc(d.url)}
<span class="kv">方法    </span>${esc(d.method)}  <span class="kv">状态</span> ${esc(d.status)} ${esc(d.statusText)}
<span class="kv">类型    </span>${esc(d.type)}  <span class="kv">MIME</span> ${esc(d.mime)}
<span class="kv">远端    </span>${esc(d.remoteIP)}  ${esc(d.protocol)}  <span class="kv">耗时</span> ${d.durationMs == null ? '-' : d.durationMs + 'ms'}  <span class="kv">大小</span> ${d.encodedDataLength}B
<span class="kv">时间    </span>${esc(d.time)}</pre>` +
      (d.restored ? '<h3>来源</h3><pre class="muted">上次会话恢复（不是本次抓取）</pre>' : '') +
      (d.failed ? `<h3>失败</h3><pre class="s4">${esc(d.failed.errorText)}${d.failed.blockedReason ? ' · ' + esc(d.failed.blockedReason) : ''}</pre>` : '') +
      (d.redirects.length ? `<h3>重定向链</h3><pre>${d.redirects.map((x) => `${x.status} ${esc(x.url)}\n   → ${esc(x.location)}`).join('\n')}</pre>` : '') +
      headersBlock('请求头（原始，含 Cookie）', d.requestHeaders, d.requestHeadersRaw) +
      (d.postData ? `<h3>请求体</h3><pre>${esc(d.postData)}</pre>` : '') +
      headersBlock('响应头（原始，含 Set-Cookie）', d.responseHeaders, d.responseHeadersRaw) +
      bodyBlock(d);
  });
}

function select(id) {
  clearTimeout(detailTimer);
  detailTimer = null;
  detailDirty = false;
  const prev = selected != null ? rows.get(selected) : null;
  if (prev && prev.node) prev.node.classList.remove('sel');
  selected = id;
  const cur = rows.get(id);
  if (cur && cur.node) cur.node.classList.add('sel');
  view = 'list';
  syncTabs();
  renderDetail(id);
}

// 抓包事件密集时详情会被反复重建，统一节流到 200ms
let detailTimer = null, detailDirty = false;
function scheduleDetailRender(id) {
  detailDirty = true;
  if (detailTimer) return;
  detailTimer = setTimeout(() => {
    detailTimer = null;
    if (detailDirty) { detailDirty = false; renderDetail(id); }
  }, 200);
}

/* --------------------------------------------------------------- 视图切换 */

function syncTabs() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
  el.list.classList.toggle('on', view === 'list');
  el.wsView.classList.toggle('on', view === 'ws');
  $('wfView').classList.toggle('on', view === 'wf');
  el.detail.classList.toggle('on', view === 'list' && selected != null);
  if (view === 'wf') renderWaterfall();
}

/* -------------------------------------------------------------- 瀑布图 */

let wfTimer = null;

// 抓包事件密集时按 300ms 合并重画（与详情同一节奏）
function scheduleWaterfall() {
  if (wfTimer || view !== 'wf') return;
  wfTimer = setTimeout(() => {
    wfTimer = null;
    if (view === 'wf') renderWaterfall();
  }, 300);
}

// 时间轴：t0 = 最早一条的开始，span = 最晚结束 - t0；每条按开始时间偏移、按时长定宽
function renderWaterfall() {
  const list = [...rows.values()].map((v) => v.rec).filter((r) => r.time && r.duration != null);
  const box = $('wf');
  box.innerHTML = '';
  $('nWf').textContent = String(list.length);
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无可绘制的请求（需要已完成的响应）</div>';
    $('wfInfo').textContent = '';
    $('wfScale').textContent = '';
    return;
  }
  const t0 = Math.min(...list.map((r) => Date.parse(r.time)));
  const span = Math.max(1, Math.max(...list.map((r) => Date.parse(r.time) + (r.duration || 0))) - t0);
  for (const r of list) {
    const start = Date.parse(r.time);
    const row = document.createElement('div');
    row.className = 'wfrow';
    row.title = `${r.method} ${r.url}\n${r.status || (r.failed ? '×' : '…')} · ${r.duration}ms`;
    const name = document.createElement('span');
    name.className = 'wfurl';
    name.textContent = `${r.method} ${r.url}`;
    const bar = document.createElement('div');
    bar.className = 'wfbar2' + (statusClass(r.status) ? ' ' + statusClass(r.status) : '');
    bar.style.left = `${((start - t0) / span) * 100}%`;
    bar.style.width = `${Math.max(0.3, ((r.duration || 1) / span) * 100)}%`;
    row.appendChild(name);
    row.appendChild(bar);
    row.onclick = () => select(r.id);          // 与列表一致：切回列表并展开该条详情
    box.appendChild(row);
  }
  $('wfInfo').textContent = `${list.length} 条 · 跨度 ${Math.round(span)}ms`;
  $('wfScale').textContent = `起点 ${new Date(t0).toLocaleTimeString()}`;
}

/* -------------------------------------------------------------- 多标签 */

// 关闭标签后的可撤销提示（撤销窗口由主进程控制，超时会提示「撤销已过期」）
async function closeTabUi(t) {
  const r = await ipcRenderer.invoke('cap:tabClose', t.id);
  if (!r || !r.ok) return toast('关闭标签失败：' + ((r && r.error) || '未知错误'), 'err');
  toast(`已关闭「${String(r.title || '').slice(0, 30)}」`, 'info', r.undoMs || 8000, {
    label: '撤销',
    onClick: async () => {
      const u = await ipcRenderer.invoke('cap:tabUndo');
      if (!u || !u.ok) return toast('撤销失败：' + ((u && u.error) || '未知错误'), 'err');
      toast(`已恢复标签（${u.records} 条记录）`, 'ok');
      return undefined;
    },
  });
  return undefined;
}

function tabMenuItems(t) {
  return [
    { label: '复制 URL', onClick: () => { clipboard.writeText(t.url || ''); toast('已复制 URL', 'ok', 2000); } },
    { label: '重新加载', onClick: () => ipcRenderer.invoke('cap:tabReload', t.id) },
    { label: '关闭其他', onClick: () => ipcRenderer.invoke('cap:tabCloseOthers', t.id) },
    { label: '关闭', onClick: () => closeTabUi(t) },
  ];
}

function renderTabs(list, activeId) {
  const box = $('tabList');
  box.innerHTML = '';
  for (const t of list || []) {
    const chip = document.createElement('div');
    chip.className = 'tabchip' + (t.id === activeId ? ' on' : '');
    chip.title = t.url || '';
    const label = document.createElement('span');
    label.className = 't';
    label.textContent = String(t.title || t.url || '(新标签)').slice(0, 40);
    chip.appendChild(label);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = '关闭标签';
    x.onclick = (e) => { e.stopPropagation(); closeTabUi(t); };
    chip.appendChild(x);
    chip.onclick = () => ipcRenderer.invoke('cap:tabActivate', t.id);
    chip.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, tabMenuItems(t)); };
    box.appendChild(chip);
  }
}

// 整表同步（切换标签 / 恢复会话后）：按 id 差量更新，能原地保留的行不重建 DOM
// 边界：切标签时两个标签的记录 id 不重叠，差量退化为全量重建；收益在「同一批数据重刷」
// （横幅恢复、重复的 cap:tabChanged）和不再丢滚动位置/悬浮状态。
function refreshActiveList(d) {
  const incoming = d.records || [];
  const keep = new Set(incoming.map((r) => r.id));
  for (const id of [...rows.keys()]) if (!keep.has(id)) dropRow(id);
  for (const rec of incoming) {
    if (rows.has(rec.id)) updateRecord(rec);
    else appendRecord(rec);
  }
  if (!rows.size) el.list.innerHTML = '<div class="empty">等待抓取…</div>';
  // 整表同步是唯一允许 O(n) 扫一遍的地方：把 visible / domRows / visibleCount 与真实 DOM 对齐
  visibleCount = 0;
  domRows = 0;
  for (const r of rows.values()) {
    if (!r.node) continue;
    domRows++;
    r.visible = visible(r.node);
    if (r.visible) visibleCount++;
  }
  listNew = 0;
  updateListNew();
  updateListNote();
  rebuildWs(d.wsFrames || []);
  renderTabs(d.tabs, d.activeTabId);
  if (d.url && d.url !== 'about:blank') $('url').value = d.url;
  toggleState = d.enabled;
  $('toggle').textContent = d.enabled ? '暂停' : '继续';
  $('status').textContent = d.status;
  if (selected != null && !keep.has(selected)) {       // 选中的记录没了才收起详情
    selected = null;
    detailId = null;
    detailData = null;
    el.detail.innerHTML = '';
  }
  updateCounts();
  syncTabs();
}

/* -------------------------------------------------------------- 右键菜单 */

function hideContextMenu() {
  $('ctxMenu').hidden = true;
  $('ctxMenu').innerHTML = '';
}

// items: [{ label, onClick }]
function showContextMenu(x, y, items) {
  const box = $('ctxMenu');
  box.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ghost ctx-item';
    b.textContent = it.label;
    b.onclick = () => { hideContextMenu(); it.onClick(); };
    box.appendChild(b);
  }
  box.hidden = false;
  box.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  box.style.top = `${Math.min(y, window.innerHeight - (items.length * 26 + 8))}px`;
}

// 记录行菜单：复制类不动选中项；重放/导出/另存先切到该行
function rowMenuItems(id) {
  const r = rows.get(id);
  if (!r) return [];
  return [
    { label: '复制 URL', onClick: () => { clipboard.writeText(r.rec.url); toast('已复制 URL', 'ok', 2000); } },
    { label: '复制 cURL', onClick: async () => {
      const f = await ipcRenderer.invoke('cap:format', 'curl', id);
      if (!f || !f.ok) return toast('复制失败：' + ((f && f.error) || '未知错误'), 'err');
      clipboard.writeText(f.text);
      toast('已复制 cURL', 'ok', 2000);
      return undefined;
    } },
    { label: '复制 Python', onClick: () => copySnippet(id, 'python', 'Python') },
    { label: '复制 Node fetch', onClick: () => copySnippet(id, 'nodeFetch', 'Node fetch') },
    { label: '重放', onClick: () => { select(id); openReplayModal(); } },
    { label: '导出此条', onClick: () => exportResult(ipcRenderer.invoke('cap:exportAll', [id])) },
    { label: '另存响应体', onClick: async () => {
      const r2 = await ipcRenderer.invoke('cap:saveBody', id, 'response');
      if (r2 && r2.ok) toast('已保存：' + r2.file, 'ok');
      else if (r2 && r2.canceled) $('status').textContent = '已取消保存';
      else toast('保存失败：' + ((r2 && r2.error) || '未知错误'), 'err');
      return undefined;
    } },
  ];
}

/* -------------------------------------------------------------- WebSocket */

function wsText(frame) {
  const t = new Date(frame.time).toLocaleTimeString();
  const map = { open: '⇡ 建立', close: '✕ 关闭', error: '! 错误', sent: '→ 发送', recv: '← 接收' };
  return `[${t}] ${map[frame.kind] || frame.kind} ${frame.url || ''} ${frame.error || ''}\n${frame.payload || ''}`.trimEnd();
}

function wsMatch(frame) {
  const f = $('wsFilter').value.trim().toLowerCase();
  if (!f) return true;
  return wsText(frame).toLowerCase().includes(f);
}

function appendWs(frame) {
  if ($('wsPause').checked) return;                 // 暂停只影响显示，数据仍在主进程
  if (!wsMatch(frame)) return;
  const empty = el.ws.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.textContent = wsText(frame);
  el.ws.appendChild(div);
  $('nWs').textContent = el.ws.children.length;
  if (view === 'ws') el.ws.scrollTop = el.ws.scrollHeight;
}

// 过滤/恢复暂停时按主进程的当前标签帧整体重画
function rebuildWs(frames) {
  el.ws.innerHTML = '';
  $('nWs').textContent = '0';
  for (const f of frames || []) appendWs(f);
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

// 空表壳（表头 + tbody），用于需要输入控件 / 按钮的表格
function makeTable(cols) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c; htr.appendChild(th); }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  return { table, tbody };
}

function tdText(v) {
  const td = document.createElement('td');
  td.textContent = v == null ? '' : String(v);
  return td;
}

function tdInput(value, onChange) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.value = value == null ? '' : String(value);
  inp.style.width = '100%';
  inp.addEventListener('change', () => onChange(inp));
  td.appendChild(inp);
  return td;
}

function tdBtn(label, onClick) {
  const td = document.createElement('td');
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  td.appendChild(b);
  return td;
}

function sectionTitle(text) {
  const d = document.createElement('div');
  d.className = 'lbl';
  d.style.margin = '10px 0 4px';
  d.textContent = text;
  return d;
}

function cookieUrl(c) {
  return 'https://' + String(c.domain || '').replace(/^\./, '') + (c.path || '/');
}

function cookieAttrs(c) {
  const d = {};
  if (c.domain) d.domain = c.domain;
  if (c.path) d.path = c.path;
  if (c.secure != null) d.secure = !!c.secure;
  if (c.httpOnly != null) d.httpOnly = !!c.httpOnly;
  if (c.expirationDate) d.expirationDate = c.expirationDate;
  return d;
}

function originOf(url) {
  try { const u = new URL(url); return u.protocol + '//' + u.host + '/'; } catch (e) { return ''; }
}

/* ---- 会话数据：Cookie / Storage / 页面信息（写操作后整体刷新，界面与进程内一致）---- */

function cookieRow(c, refresh) {
  const tr = document.createElement('tr');
  tr.appendChild(tdText(c.name));
  tr.appendChild(tdText(c.domain));
  tr.appendChild(tdText(c.path));
  tr.appendChild(tdInput(c.value, async (inp) => {
    const r = await ipcRenderer.invoke('cap:cookieSet', Object.assign({ url: cookieUrl(c), name: c.name, value: inp.value }, cookieAttrs(c)));
    if (!r || !r.ok) {
      toast('修改失败：' + ((r && r.error) || '未知错误'), 'err');
      inp.value = c.value == null ? '' : String(c.value);
      return;
    }
    refresh();
  }));
  tr.appendChild(tdText(c.secure ? '是' : ''));
  tr.appendChild(tdText(c.httpOnly ? '是' : ''));
  tr.appendChild(tdBtn('删除', async () => {
    const r = await ipcRenderer.invoke('cap:cookieRemove', { url: cookieUrl(c), name: c.name });
    if (!r || !r.ok) return toast('删除失败：' + ((r && r.error) || '未知错误'), 'err');
    refresh();
  }));
  return tr;
}

function storageTable(area, obj) {
  const t = makeTable(['键', '值', '操作']);
  for (const [k, v] of Object.entries(obj || {})) {
    const tr = document.createElement('tr');
    tr.appendChild(tdText(k));
    tr.appendChild(tdInput(v, async (inp) => {
      const r = await ipcRenderer.invoke('cap:storageSet', { area, key: k, value: inp.value });
      if (!r || !r.ok) {
        toast('修改失败：' + ((r && r.error) || '未知错误'), 'err');
        inp.value = v == null ? '' : String(v);
        return;
      }
      openSessionData();
    }));
    tr.appendChild(tdBtn('删除', async () => {
      const r = await ipcRenderer.invoke('cap:storageRemove', { area, key: k });
      if (!r || !r.ok) return toast('删除失败：' + ((r && r.error) || '未知错误'), 'err');
      openSessionData();
    }));
    t.tbody.appendChild(tr);
  }
  const tr = document.createElement('tr');
  const kIn = document.createElement('input');
  const vIn = document.createElement('input');
  kIn.placeholder = '键';
  vIn.placeholder = '值';
  kIn.style.width = '100%';
  vIn.style.width = '100%';
  const tdKey = document.createElement('td');
  tdKey.appendChild(kIn);
  const tdVal = document.createElement('td');
  tdVal.appendChild(vIn);
  tr.appendChild(tdKey);
  tr.appendChild(tdVal);
  tr.appendChild(tdBtn('新增', async () => {
    const r = await ipcRenderer.invoke('cap:storageSet', { area, key: kIn.value.trim(), value: vIn.value });
    if (!r || !r.ok) return toast('新增失败：' + ((r && r.error) || '未知错误'), 'err');
    openSessionData();
  }));
  t.tbody.appendChild(tr);
  return t.table;
}

async function openSessionData() {
  const [pd, ck] = await Promise.all([ipcRenderer.invoke('cap:pageData'), ipcRenderer.invoke('cap:cookies')]);
  const origin = originOf(pd.url);
  const cookies = (ck && ck.cookies) || [];
  const box = document.createElement('div');

  const info = document.createElement('pre');
  info.textContent = `当前页：${pd.title || '(无标题)'}\nURL：${pd.url}\nHTML：${pd.htmlLength} 字符\n\ndocument.cookie：\n${pd.page.cookies || '(空)'}`;
  box.appendChild(info);

  const bar = document.createElement('div');
  bar.className = 'dbar';
  const mkBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; bar.appendChild(b); return b; };
  mkBtn('新增', () => {
    const nameIn = document.createElement('input');
    const valIn = document.createElement('input');
    openModal('新增 Cookie', [labelled('名称', nameIn), labelled('值', valIn)], [
      { label: '提交', primary: true, onClick: async () => {
        if (!origin) return toast('当前页面不是 http(s) 页面，无法添加 Cookie', 'warn');
        const r = await ipcRenderer.invoke('cap:cookieSet', { url: origin, name: nameIn.value.trim(), value: valIn.value });
        if (!r || !r.ok) return toast('添加失败：' + ((r && r.error) || '未知错误'), 'err');
        toast('已添加 ' + nameIn.value.trim(), 'ok');
        openSessionData();
      } },
      { label: '取消', onClick: () => openSessionData() },
    ]);
  });
  mkBtn('导入', () => {
    const ta = textarea('a=1; b=2 或 JSON 数组；Cookie 头形式会挂到当前页 origin', '');
    openModal('导入 Cookie', [labelled('内容', ta)], [
      { label: '导入', primary: true, onClick: async () => {
        const r = await ipcRenderer.invoke('cap:cookieImport', { text: ta.value, url: origin });
        if (!r || !r.ok) return toast('导入失败：' + ((r && r.error) || '未知错误'), 'err');
        const bad = (r.failed || []).length;
        toast(`已导入 ${r.added} 条${bad ? `，失败 ${bad} 条` : ''}`, bad ? 'warn' : 'ok');
        openSessionData();
      } },
      { label: '取消', onClick: () => openSessionData() },
    ]);
  });
  mkBtn('刷新', () => openSessionData());

  box.appendChild(sectionTitle(`Cookie（${cookies.length} 条）`));
  box.appendChild(bar);
  const ct = makeTable(['名称', '域', '路径', '值', 'Secure', 'HttpOnly', '操作']);
  for (const c of cookies) ct.tbody.appendChild(cookieRow(c, openSessionData));
  box.appendChild(ct.table);

  box.appendChild(sectionTitle(`localStorage（${Object.keys(pd.page.localStorage || {}).length} 项）`));
  box.appendChild(storageTable('local', pd.page.localStorage));
  box.appendChild(sectionTitle(`sessionStorage（${Object.keys(pd.page.sessionStorage || {}).length} 项）`));
  box.appendChild(storageTable('session', pd.page.sessionStorage));

  openModal('会话数据', [box], [
    { label: '导出 Cookie JSON', onClick: () => exportResult(ipcRenderer.invoke('cap:exportCookies', { format: 'json' })) },
    { label: '导出 Cookie Netscape', onClick: () => exportResult(ipcRenderer.invoke('cap:exportCookies', { format: 'netscape' })) },
    { label: '关闭', primary: true, onClick: closeModal },
  ]);
}

/* ---- 重放请求：可改写方法 / URL / 请求头 / 请求体 ---- */

async function openReplayModal() {
  if (detailId == null) return;
  const d = await ipcRenderer.invoke('cap:detail', detailId);
  if (!d) return toast('记录不存在', 'err');
  const hd = await ipcRenderer.invoke('cap:format', 'reqHeaders', detailId);

  const methodIn = document.createElement('input');
  methodIn.value = d.method || 'GET';
  const urlIn = document.createElement('input');
  urlIn.value = d.url || '';
  const headersTa = textarea('每行 名称: 值', hd && hd.ok ? hd.text : '');
  const bodyTa = textarea('请求体', d.postData || '');
  bodyTa.id = 'replayBody';
  const out = document.createElement('pre');
  out.id = 'replayOut';
  out.hidden = true;

  const send = async () => {
    out.hidden = false;
    out.textContent = '重放中…';
    $('status').textContent = '重放中…';
    const r = await ipcRenderer.invoke('cap:replay', detailId, {
      method: methodIn.value.trim(), url: urlIn.value.trim(),
      headers: headersTa.value, body: bodyTa.value,
    });
    const text = r.ok
      ? `${r.status} ${r.statusText}  ${r.tookMs}ms${r.truncated ? '（响应体已截断到 1MB）' : ''}\n${JSON.stringify(r.headers, null, 2)}\n\n${r.body}`
      : '重放失败：' + r.error;
    out.textContent = text;
    $('status').textContent = r.ok ? `重放完成：${r.status}` : '重放失败';
    const h = document.createElement('h3');
    h.textContent = '重放结果';
    const pre = document.createElement('pre');
    pre.textContent = text;
    el.detail.appendChild(h);
    el.detail.appendChild(pre);
  };

  openModal('重放请求', [
    labelled('方法', methodIn),
    labelled('URL', urlIn),
    labelled('请求头（每行 名称: 值）', headersTa),
    labelled('请求体', bodyTa),
    out,
  ], [
    { id: 'replaySend', label: '发送', primary: true, onClick: send },
    { label: '取消', onClick: closeModal },
  ]);
}

/* ---------------------------------------------------------------- 轻提示 */

// 非阻塞提示：最多同时 4 条，超出移除最早的一条；action = { label, onClick } 会在提示里加一个按钮
function toast(msg, kind = 'info', ms = 4000, action) {
  const box = $('toasts');
  const div = document.createElement('div');
  div.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  div.textContent = String(msg);
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = action.label;
    btn.style.marginLeft = '8px';
    btn.onclick = () => { div.remove(); action.onClick(); };
    div.appendChild(btn);
  }
  box.appendChild(div);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => div.remove(), ms);
  return div;
}

/* ------------------------------------------------------------ 键盘快捷键 */

function stepSelection(delta) {
  const nodes = [...el.list.querySelectorAll('.row')].filter(visible);
  if (!nodes.length) return;
  let idx = nodes.findIndex((n) => Number(n.dataset.id) === selected);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const node = nodes[Math.max(0, Math.min(nodes.length - 1, idx + delta))];
  if (!node) return;
  select(Number(node.dataset.id));
  node.scrollIntoView({ block: 'nearest' });
}

// 只注册这一个 keydown 监听；默认菜单栏已移除，Ctrl+R / Ctrl+Shift+R/I / F11 在这里补齐
function onKey(e) {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'l') { e.preventDefault(); $('url').focus(); $('url').select(); return; }
    if (k === 'f') { e.preventDefault(); $('filter').focus(); $('filter').select(); return; }
    if (k === 'p') { e.preventDefault(); $('toggle').click(); return; }
    if (k === 's') { e.preventDefault(); $('expFiltered').click(); return; }
    if (k === 'r') { e.preventDefault(); $('reload').click(); return; }          // 刷新页面
    return;
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); ipcRenderer.invoke('cap:reload', true); return; }   // 强制刷新（忽略缓存）
    if (k === 'i') { e.preventDefault(); ipcRenderer.invoke('cap:devtools'); return; }      // 页面 DevTools
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('back').click(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); $('fwd').click(); return; }
    return;
  }
  if (e.key === 'F5') { e.preventDefault(); $('reload').click(); return; }
  if (e.key === 'F11') { e.preventDefault(); ipcRenderer.invoke('cap:fullscreen'); return; }
  if (e.key === 'Escape') {
    if (!$('modal').hidden) { closeModal(); return; }
    if (!$('findbar').hidden) { $('findbar').hidden = true; ipcRenderer.invoke('cap:findStop'); return; }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return;
  }
  if (typing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepSelection(e.key === 'ArrowDown' ? 1 : -1); }
}
window.addEventListener('keydown', onKey);

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
  resetListDom();
  el.detail.innerHTML = '';
  selected = null;
  detailId = null;
  detailData = null;
  if (view === 'wf') renderWaterfall();
});
$('toggle').onclick = () => ipcRenderer.invoke('cap:setEnabled', !toggleState).then((v) => {
  toggleState = v; $('toggle').textContent = v ? '暂停' : '继续';
});
$('pageData').onclick = () => openSessionData();
$('expAll').onclick = () => exportResult(ipcRenderer.invoke('cap:exportAll'));
$('expFiltered').onclick = () => {
  const ids = [...el.list.querySelectorAll('.row')].filter(visible).map((n) => Number(n.dataset.id));
  if (!ids.length) return toast('当前没有筛选项', 'warn');
  exportResult(ipcRenderer.invoke('cap:exportAll', ids));
};
$('expHtml').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHtml'));
$('expCookie').onclick = () => exportResult(ipcRenderer.invoke('cap:exportCookieJson'));
$('expHar').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHar', {}));
$('expPostman').onclick = () => exportResult(ipcRenderer.invoke('cap:exportPostman', {}));
$('copyMd').onclick = async () => {
  const ids = [...el.list.querySelectorAll('.row')].filter(visible).map((n) => Number(n.dataset.id));
  if (!ids.length) return toast('当前没有筛选项', 'warn');
  const f = await ipcRenderer.invoke('cap:format', 'markdown', ids);
  if (!f || !f.ok) return toast('生成失败：' + ((f && f.error) || '未知错误'), 'err');
  clipboard.writeText(f.text);
  toast(`已复制 Markdown 表格（${ids.length} 行）`, 'ok', 3000);
  return undefined;
};
$('modalClose').onclick = closeModal;
$('status').onclick = () => {
  const t = $('status').textContent;
  if (!t) return;
  clipboard.writeText(t);
  toast('已复制状态栏内容', 'ok', 2000);
};

/* ---- 详情：复制 cURL / 重放（详情 HTML 每次重建，只能事件委托）---- */
el.detail.addEventListener('click', async (e) => {
  const id = e.target && e.target.id;
  if (id === 'markStar') {
    if (detailId == null) return;
    const cur = rows.get(detailId);
    const r = await ipcRenderer.invoke('cap:mark', detailId, { star: !(cur && cur.rec.star) });
    if (!r || !r.ok) return toast('标记失败：' + ((r && r.error) || '未知错误'), 'err');
    if (cur) {
      cur.rec = Object.assign({}, cur.rec, { star: r.record.star });
      if (cur.node) paintRow(cur.node, cur.rec);
    }
    if (detailData) detailData.star = r.record.star;
    renderDetail(detailId);
  } else if (id === 'copyCurl') {
    if (detailId == null) return;
    const r = await ipcRenderer.invoke('cap:format', 'curl', detailId);
    if (!r.ok) return toast(r.error, 'err');
    clipboard.writeText(r.text);
    $('status').textContent = '已复制 cURL 到剪贴板';
  } else if (id === 'replayReq') {
    openReplayModal();
  } else if (id === 'codeBtn') {
    openCodeModal();
  } else if (id === 'saveReq') {
    if (detailId == null) return;
    const r = await ipcRenderer.invoke('cap:saveBody', detailId, 'request');
    if (r && r.ok) toast('已保存：' + r.file, 'ok');
    else if (r && r.canceled) $('status').textContent = '已取消保存';
    else toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
  } else if (id === 'expOne') {
    if (detailId == null) return;
    exportResult(ipcRenderer.invoke('cap:exportAll', [detailId]));
  } else if (id === 'copyUrl' || id === 'copyRespHeaders' || id === 'copyBody') {
    if (!detailData) return;
    let text = '';
    if (id === 'copyUrl') text = detailData.url;
    else if (id === 'copyRespHeaders') text = headersText(detailData.responseHeaders, detailData.responseHeadersRaw);
    else text = detailData.bodyBase64
      ? `[base64 ${detailData.body ? detailData.body.length : 0} 字符，已省略]`
      : String(detailData.body == null ? '' : detailData.body);
    clipboard.writeText(text);
    $('status').textContent = `已复制${id === 'copyUrl' ? ' URL' : id === 'copyRespHeaders' ? '响应头' : '响应体'}（${text.length} 字符）`;
  } else if (id === 'bodyToggle') {
    if (detailId == null) return;
    if (detailFull.has(detailId)) detailFull.delete(detailId); else detailFull.add(detailId);
    renderDetail(detailId);
  } else if (id === 'bodySave') {
    if (detailId == null) return;
    const r = await ipcRenderer.invoke('cap:saveBody', detailId, 'response');
    if (r && r.ok) toast('已保存：' + r.file, 'ok');
    else if (r && r.canceled) $('status').textContent = '已取消保存';
    else toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
  }
});

/* ---- 抓包转代码：复制片段 / 模态预览（详情 HTML 每次重建，走事件委托）---- */
async function copySnippet(id, kind, label) {
  const f = await ipcRenderer.invoke('cap:format', kind, id);
  if (!f || !f.ok) return toast('复制失败：' + ((f && f.error) || '未知错误'), 'err');
  clipboard.writeText(f.text);
  toast(`已复制 ${label} 代码`, 'ok', 2000);
  return undefined;
}

async function openCodeModal() {
  if (detailId == null) return;
  const kindSel = document.createElement('select');
  for (const [v, label] of [['curl', 'cURL'], ['python', 'Python requests'], ['nodeFetch', 'Node fetch'], ['nodeAxios', 'Node axios']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    kindSel.appendChild(o);
  }
  const pre = document.createElement('pre');
  pre.id = 'codePreview';
  const load = async () => {
    const r = await ipcRenderer.invoke('cap:format', kindSel.value, detailId);
    pre.textContent = r && r.ok ? r.text : `生成失败：${(r && r.error) || '未知错误'}`;
  };
  kindSel.addEventListener('change', load);
  await load();
  openModal('复制代码', [labelled('语言', kindSel), pre], [
    { label: '复制', primary: true, onClick: () => { clipboard.writeText(pre.textContent); toast('已复制代码 (' + pre.textContent.length + ' 字符)', 'ok', 2000); } },
    { label: '关闭', onClick: closeModal },
  ]);
  return undefined;
}

/* ---- 备注：详情 HTML 每次重建，同样只能事件委托 ---- */
el.detail.addEventListener('change', async (e) => {
  if (!e.target || e.target.id !== 'markComment' || detailId == null) return;
  const old = detailData ? (detailData.comment || '') : '';
  const r = await ipcRenderer.invoke('cap:mark', detailId, { comment: e.target.value });
  if (!r || !r.ok) {
    e.target.value = old;
    return toast('备注保存失败：' + ((r && r.error) || '未知错误'), 'err');
  }
  if (detailData) detailData.comment = e.target.value;
  toast('备注已保存', 'ok', 2000);
  return undefined;
});

/* ---- 元素拾取：页面里点选元素 → 选择器回填到面板 ---- */
function pickButton(target) {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = '拾取';
  b.title = '在页面上点选元素，取其 CSS 选择器';
  b.onclick = async () => {
    pickTarget = target;
    const r = await ipcRenderer.invoke('cap:pickStart');
    if (!r || !r.ok) {
      pickTarget = '';
      return toast('无法开始拾取：' + ((r && r.error) || '未知错误'), 'err');
    }
    toast('请在页面上点击目标元素（Esc 取消）', 'info', 5000);
    return undefined;
  };
  return b;
}

ipcRenderer.on('cap:picked', (_e, p) => {
  if (!p || p.cancel) {
    pickTarget = '';
    return toast('已取消拾取', 'info', 2000);
  }
  if (pickTarget === 'tools' && $('pageToolSel')) $('pageToolSel').value = p.sel;
  else if (pickTarget === 'extract') {
    const tas = document.querySelectorAll('#modalBody textarea');
    if (tas[0]) tas[0].value = p.sel;
  } else {
    clipboard.writeText(p.sel);
  }
  toast('选择器：' + p.sel, 'ok', 4000);
  pickTarget = '';
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
$('colSet').addEventListener('change', () => { refilter(); cfg('colSet', $('colSet').value); });
$('reqDelay').addEventListener('change', () => cfg('reqDelay', +$('reqDelay').value));
$('cfgAllTabs').onclick = async () => {
  const r = await ipcRenderer.invoke('cap:cfgAllTabs');
  if (!r || !r.ok) return toast(`部分标签应用失败：${((r && r.failed) || []).join('；')}`, 'err');
  toast(`已应用到 ${r.tabs} 个标签`, 'ok');
  return undefined;
};
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
    pickButton('extract'),
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

/* ---- 统计概览 ---- */
async function openStats() {
  const s = await ipcRenderer.invoke('cap:stats');
  if (!s) return toast('统计失败：主进程没有返回数据', 'err');
  const head = document.createElement('div');
  head.className = 'lbl';
  head.textContent = `共 ${s.total} 条 · 合计 ${humanSize(s.totalBytes)}`;
  const byDomain = dataTable(['域名', '条数', '大小'], s.byDomain.map((d) => ({ 域名: d.host, 条数: d.count, 大小: humanSize(d.bytes) })));
  const byType = dataTable(['类型', '条数'], s.byType.map((d) => ({ 类型: d.type, 条数: d.count })));
  const byStatus = dataTable(['状态', '条数'], s.byStatus.map((d) => ({ 状态: d.cls, 条数: d.count })));
  const slowest = dataTable(['方法', '耗时', 'URL'], s.slowest.map((d) => ({ 方法: d.method, 耗时: `${d.ms}ms`, URL: d.url })));
  const largest = dataTable(['方法', '大小', 'URL'], s.largest.map((d) => ({ 方法: d.method, 大小: humanSize(d.size), URL: d.url })));
  openModal('统计概览', [
    head,
    sectionTitle(`域名 top10（${s.byDomain.length}）`), byDomain,
    sectionTitle('类型'), byType,
    sectionTitle('状态'), byStatus,
    sectionTitle('最慢 top10'), slowest,
    sectionTitle('最大 top10'), largest,
  ], [{ label: '关闭', primary: true, onClick: closeModal }]);
  return undefined;
}
$('statsBtn').onclick = openStats;

/* ---- 页面内查找 ---- */
async function doFind(forward) {
  const text = $('findText').value;
  if (!text) { $('findCount').textContent = ''; return; }
  const r = await ipcRenderer.invoke('cap:find', text, { forward });
  $('findCount').textContent = r && r.ok ? `${r.active || 0}/${r.matches}` : ((r && r.error) || '');
}

$('findPage').onclick = () => {
  const bar = $('findbar');
  bar.hidden = !bar.hidden;
  if (bar.hidden) { ipcRenderer.invoke('cap:findStop'); $('findCount').textContent = ''; }
  else $('findText').focus();
};
$('findText').addEventListener('input', () => doFind(true));
$('findText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey); }
});
$('findNext').onclick = () => doFind(true);
$('findPrev').onclick = () => doFind(false);
$('findClose').onclick = () => { $('findbar').hidden = true; ipcRenderer.invoke('cap:findStop'); };

/* ---- 截图 / PDF ---- */
$('pageTools').onclick = () => {
  const sel = document.createElement('input');
  sel.id = 'pageToolSel';
  sel.placeholder = 'CSS 选择器（按选择器截图时用）';
  const out = document.createElement('pre');
  out.id = 'pageToolOut';
  out.hidden = true;
  const show = (r, verb) => {
    out.hidden = false;
    if (r && r.ok) {
      out.textContent = `${verb}完成：${r.file}`;
      toast(`${verb}完成：${r.file}`, 'ok', 7000);
    } else if (r && r.canceled) {
      out.textContent = '已取消保存';
    } else {
      out.textContent = `${verb}失败：${(r && r.error) || '未知错误'}`;
      toast(`${verb}失败：${(r && r.error) || '未知错误'}`, 'err');
    }
  };
  const shot = async (mode) => {
    out.hidden = false;
    out.textContent = '处理中…';
    show(await ipcRenderer.invoke('cap:screenshot', { mode, selector: sel.value.trim() }), '截图');
  };
  const toolBar = document.createElement('div');
  toolBar.className = 'dbar';
  toolBar.appendChild(pickButton('tools'));
  openModal('页面工具', [toolBar, labelled('选择器（留空 = 整页）', sel), out], [
    { label: '可见区域截图', onClick: () => shot('visible') },
    { label: '整页截图', primary: true, onClick: () => shot('full') },
    { label: '按选择器截图', onClick: () => shot('element') },
    { label: '打印为 PDF', onClick: async () => {
      out.hidden = false;
      out.textContent = '处理中…';
      show(await ipcRenderer.invoke('cap:pdf', {}), 'PDF');
    } },
    { label: '关闭', onClick: closeModal },
  ]);
};

/* ---- 会话录制 ---- */
let recTimer = null;

function resetRecorderUi(reason) {
  $('recToggle').classList.remove('on');
  $('recToggle').textContent = '● 开始录制';
  $('recPanel').hidden = true;
  $('recItems').innerHTML = '';
  if (reason === 'limit') toast('录制达到条数上限，已自动停止', 'warn');
}

// 录制中「最近 20 条」的一行文案
function recItemLine(it) {
  const acts = { click: '点击', input: '输入', change: '变更', submit: '提交', keydown: '按键', scroll: '滚动' };
  const head = `#${it.tab == null ? '-' : it.tab}`;
  if (it.k === 'action') return `${head} ${acts[it.a] || it.a} ${it.sel || ''}${it.text ? `「${String(it.text).slice(0, 24)}」` : ''}`;
  if (it.k === 'req') return `${head} → ${it.method} ${it.url || ''}`;
  if (it.k === 'res') return `${head} ← ${it.status} ${it.url || ''}`;
  if (it.k === 'nav') return `${head} 跳转 ${it.url || ''}`;
  if (it.k === 'page') return `${head} ${it.url || ''} — ${it.title || ''}`;
  return `${head} ${it.k}`;
}

async function recStart() {
  const r = await ipcRenderer.invoke('cap:recStart', { shots: $('recShots').checked });
  if (!r || !r.ok) return toast('开始录制失败：' + ((r && r.error) || '未知错误'), 'err');
  $('recToggle').classList.add('on');
  $('recToggle').textContent = '■ 停止录制 0s · 0 条';
  clearInterval(recTimer);
  recTimer = setInterval(async () => {
    const s = await ipcRenderer.invoke('cap:recStatus');
    if (!s || !s.active) return resetRecorderUi('');
    $('recToggle').textContent = `■ 停止录制 ${Math.floor((Date.now() - s.startedAt) / 1000)}s · ${s.entries} 条`;
  }, 1000);
  toast('录制已开始：' + r.file, 'ok');
}

async function recStop() {
  clearInterval(recTimer);
  recTimer = null;
  resetRecorderUi('');
  const r = await ipcRenderer.invoke('cap:recStop');
  if (!r || !r.ok) return toast('停止录制失败：' + ((r && r.error) || '未知错误'), 'err');
  $('status').textContent = `录制完成：${r.mdFile}`;      // 路径常驻状态栏（可点复制）
  toast(`录制完成：${r.entries} 条 → ${r.mdFile}`, 'ok', 8000);
  return undefined;
}

$('recToggle').onclick = () => ($('recToggle').classList.contains('on') ? recStop() : recStart());
$('recOpen').onclick = () => ipcRenderer.invoke('cap:recOpen');
$('recSummary').onclick = () => ipcRenderer.invoke('cap:recInfo').then((r) => {
  if (!r || !r.ok) return undefined;
  return ipcRenderer.invoke('cap:recOpen');
});
$('recShots').addEventListener('change', () => cfg('recShots', $('recShots').checked));
ipcRenderer.on('cap:rec', (_e, d) => {
  if (!d || d.active) return;
  clearInterval(recTimer);
  recTimer = null;
  resetRecorderUi(d.reason);
});
ipcRenderer.on('cap:recItems', (_e, batch) => {
  const box = $('recItems');
  for (const it of batch || []) {
    const div = document.createElement('div');
    div.textContent = recItemLine(it);
    box.appendChild(div);
  }
  while (box.children.length > 20) box.removeChild(box.firstChild);
  $('recPanel').hidden = false;
  box.scrollTop = box.scrollHeight;
});

/* ---- 录制历史：浏览 / 读取摘要 / 重放 / 导出回放脚本 ---- */
function openReplayRecording(file) {
  const speed = document.createElement('select');
  for (const [v, t] of [['1', '1×（原速）'], ['2', '2×'], ['4', '4×'], ['0', '不等间隔（尽快）']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    speed.appendChild(o);
  }
  const stopOnErr = document.createElement('input');
  stopOnErr.type = 'checkbox';
  stopOnErr.checked = true;
  const wrap = document.createElement('label');
  wrap.className = 'lbl';
  wrap.appendChild(stopOnErr);
  wrap.appendChild(document.createTextNode(' 失败即停'));
  const out = document.createElement('pre');
  out.textContent = '尚未开始';
  const progress = (_e, d) => { out.textContent = `进度 ${d.done}/${d.total} · 失败 ${d.failed}${d.last ? ' · ' + d.last : ''}`; };

  openModal('重放录制', [labelled('倍速', speed), wrap, out], [
    { id: 'recReplayStart', label: '开始', primary: true, onClick: async () => {
      out.textContent = '重放中…';
      ipcRenderer.on('cap:replayProgress', progress);
      const r = await ipcRenderer.invoke('cap:recReplay', { file, speed: Number(speed.value), stopOnError: stopOnErr.checked });
      ipcRenderer.removeListener('cap:replayProgress', progress);
      if (!r || !r.ok) {
        out.textContent = '重放失败：' + ((r && r.error) || '未知错误');
        return toast('重放失败：' + ((r && r.error) || '未知错误'), 'err');
      }
      const fails = (r.failed || []).slice(0, 10).map((f) => `#${f.n} ${f.a} ${f.sel || ''} → ${f.reason}`).join('\n');
      out.textContent = `完成 ${r.done}/${r.total}${r.stopped ? '（已中止）' : ''}\n失败 ${(r.failed || []).length} 条\n${fails}`;
      toast(`重放完成：${r.done}/${r.total}`, (r.failed || []).length ? 'warn' : 'ok', 6000);
      return undefined;
    } },
    { id: 'recReplayStop', label: '停止重放', onClick: async () => {
      const r = await ipcRenderer.invoke('cap:recReplayStop');
      out.textContent = r && r.ok ? '已请求停止（当前动作跑完即停）' : `停止失败：${(r && r.error) || '未知错误'}`;
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
}

async function openRecHistory() {
  const list = await ipcRenderer.invoke('cap:recList');
  if (!Array.isArray(list)) return toast('读取录制列表失败', 'err');
  if (!list.length) return toast('录制目录里还没有 .jsonl', 'warn');

  const sel = document.createElement('select');
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r.file;
    o.textContent = `${r.base} · ${r.entries || '?'} 条 · ${humanSize(r.size)} · ${new Date(r.mtime).toLocaleString()}${r.reason ? ` · ${r.reason}` : ''}`;
    sel.appendChild(o);
  }
  const search = document.createElement('input');
  search.placeholder = '过滤摘要行';
  const view = document.createElement('pre');
  view.style.maxHeight = '340px';
  let mdText = '';

  const paint = () => {
    const f = search.value.trim();
    view.textContent = f ? mdText.split('\n').filter((l) => l.includes(f)).join('\n') : mdText;
  };
  const load = async () => {
    const rd = await ipcRenderer.invoke('cap:recRead', { file: sel.value });
    if (!rd || !rd.ok) {
      mdText = `读取失败：${(rd && rd.error) || '未知错误'}`;
      return paint();
    }
    mdText = `${rd.base}：${rd.entries} 条记录 · 可重放动作 ${rd.actions.length} 条\n\n${rd.md || '(没有 .md 摘要)'}`;
    paint();
    return undefined;
  };
  sel.addEventListener('change', load);
  search.addEventListener('input', paint);
  await load();

  openModal('录制历史', [labelled('录制文件（新的在前）', sel), labelled('过滤', search), view], [
    { id: 'recReplay', label: '重放', primary: true, onClick: () => { openReplayRecording(sel.value); return undefined; } },
    { id: 'recScript', label: '导出回放脚本', onClick: async () => {
      const r = await ipcRenderer.invoke('cap:recScript', { file: sel.value });
      if (r && r.ok) toast('已保存：' + r.file, 'ok', 7000);
      else if (r && r.canceled) $('status').textContent = '已取消保存';
      else toast('导出失败：' + ((r && r.error) || '未知错误'), 'err');
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
  return undefined;
}
$('recBrowse').onclick = openRecHistory;

/* ---- WebSocket 视图：暂停 / 过滤 / 清空显示 ---- */
$('wsFilter').addEventListener('change', () => ipcRenderer.invoke('cap:ws').then((r) => rebuildWs((r && r.frames) || [])));
$('wsPause').onchange = () => {
  if ($('wsPause').checked) return;
  ipcRenderer.invoke('cap:ws').then((r) => rebuildWs((r && r.frames) || []));
};
$('wsClear').onclick = () => {
  el.ws.innerHTML = '';
  $('nWs').textContent = '0';
  $('wsNote').textContent = '已清空显示（数据仍在，切标签会重新载入）';
};

/* ---- 响应体存盘 ---- */
$('saveBodies').onclick = () => ipcRenderer.invoke('cap:saveBodies').then((r) => {
  if (!r) return;
  if (r.canceled) return void ($('status').textContent = '已取消');
  if (!r.ok) return toast('存盘失败：' + r.error, 'err');
  toast(`已写入 ${r.written} 个文件 → ${r.dir}（跳过 ${r.skipped} 条无响应体）`, 'ok', 7000);
});

/* ---- 页面内执行 JS（CDP Runtime.evaluate，不受页面 CSP 限制）---- */
const jsHistory = [];      // 仅内存的最近 10 条命令

$('runJs').onclick = () => {
  const ta = textarea('例如 document.title', '');
  ta.id = 'jsInput';
  const hist = document.createElement('select');
  hist.id = 'jsHistory';
  const refreshHist = () => {
    hist.innerHTML = '';
    for (const cmd of jsHistory.slice().reverse()) {
      const o = document.createElement('option');
      o.value = cmd;
      o.textContent = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd;
      hist.appendChild(o);
    }
    hist.hidden = jsHistory.length === 0;
  };
  hist.onchange = () => { ta.value = hist.value; };
  refreshHist();
  const out = document.createElement('pre');
  out.id = 'jsOut';
  out.hidden = true;
  const run = async () => {
    const code = ta.value;
    out.hidden = false;
    out.textContent = '执行中…';
    const r = await ipcRenderer.invoke('cap:eval', code);
    if (r && r.ok) {
      out.textContent = r.value;
      jsHistory.push(code);
      if (jsHistory.length > 10) jsHistory.shift();
      refreshHist();
    } else {
      out.textContent = '错误：' + ((r && r.error) || '未知错误');
    }
  };
  openModal('执行 JS', [labelled('命令（在当前页面的主世界执行）', ta), labelled('历史（仅本次运行）', hist), out], [
    { id: 'jsRun', label: '执行', primary: true, onClick: run },
    { label: '关闭', onClick: closeModal },
  ]);
};

/* ---- 清理运行时数据 ---- */
const WIPE_ITEMS = [
  ['cookies', 'Cookie', '所有站点的登录态与 Cookie 都会被删除'],
  ['storage', 'Storage', 'localStorage / IndexedDB / 缓存存储 / Service Worker'],
  ['cache', '缓存', 'HTTP 缓存（下次访问会重新下载）'],
  ['logs', '日志', '诊断日志文件（含滚动的上一代）'],
  ['session', '会话文件', '上次会话的落盘记录（恢复横幅不再出现）'],
];

$('wipeBtn').onclick = () => {
  const box = document.createElement('div');
  const warn = document.createElement('div');
  warn.className = 'lbl';
  warn.style.marginBottom = '8px';
  warn.textContent = '注意：清理 Cookie / Storage 会让相关站点退出登录；操作立即生效，无法撤销。';
  box.appendChild(warn);
  const boxes = new Map();
  for (const [id, label, hint] of WIPE_ITEMS) {
    const row = document.createElement('label');
    row.className = 'lbl';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.target = id;
    boxes.set(id, cb);
    row.appendChild(cb);
    row.appendChild(document.createTextNode(` ${label} — ${hint}`));
    box.appendChild(row);
  }
  openModal('清理数据', [box], [
    { id: 'wipeRun', label: '确认清理', primary: true, onClick: async () => {
      const targets = [...boxes.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
      if (!targets.length) return toast('没有选择任何清理目标', 'warn');
      const r = await ipcRenderer.invoke('cap:wipe', { targets });
      if (!r) return toast('清理失败：主进程没有返回结果', 'err');
      const tail = (r.failed || []).length ? `；失败 ${r.failed.join('；')}` : '';
      toast(`已清理：${(r.done || []).join('、')}${tail}`, r.ok ? 'ok' : 'warn', 6000);
      return undefined;
    } },
    { label: '取消', onClick: closeModal },
  ]);
};

/* ---- 应用设置：软件渲染 / GPU 状态 ---- */
async function openAppSettings() {
  const gs = await ipcRenderer.invoke('cap:gpuStatus');
  const cfgAll = await ipcRenderer.invoke('cap:cfgAll');
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

  /* 兼容：证书 / Basic 认证 */
  const compatTitle = document.createElement('div');
  compatTitle.className = 'lbl';
  compatTitle.textContent = '兼容';
  compatTitle.style.margin = '10px 0 4px';
  box.appendChild(compatTitle);

  const certRow = document.createElement('label');
  certRow.className = 'lbl';
  const cert = document.createElement('input');
  cert.type = 'checkbox';
  cert.id = 'ignoreCert';
  cert.checked = !!cfgAll.ignoreCertErrors;
  cert.onchange = async () => {
    const r = await ipcRenderer.invoke('cap:cfg', { key: 'ignoreCertErrors', value: cert.checked });
    if (!r || !r.ok) { toast('设置失败：' + ((r && r.error) || '未知错误'), 'err'); cert.checked = !cert.checked; }
  };
  certRow.appendChild(cert);
  certRow.appendChild(document.createTextNode(' 忽略证书错误'));
  box.appendChild(certRow);
  const certWarn = document.createElement('div');
  certWarn.className = 'lbl';
  certWarn.textContent = '仅用于内网自签名站点，会降低连接安全性';
  box.appendChild(certWarn);

  const uIn = document.createElement('input');
  uIn.id = 'authUser';
  uIn.value = cfgAll.authUser || '';
  uIn.placeholder = '用户名';
  uIn.onchange = () => cfg('authUser', uIn.value);
  const pIn = document.createElement('input');
  pIn.id = 'authPass';
  pIn.type = 'password';
  pIn.value = cfgAll.authPass || '';
  pIn.placeholder = '密码';
  pIn.onchange = () => cfg('authPass', pIn.value);
  box.appendChild(labelled('Basic 认证用户名', uIn));
  box.appendChild(labelled('Basic 认证密码（明文保存在 settings.json，仅本地使用）', pIn));

  const cfgBar = document.createElement('div');
  cfgBar.className = 'dbar';
  const mkCfgBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    cfgBar.appendChild(b);
    return b;
  };
  mkCfgBtn('导出设置', () => exportResult(ipcRenderer.invoke('cap:cfgExport', {})));
  mkCfgBtn('导入设置', async () => {
    const r = await ipcRenderer.invoke('cap:cfgImport', {});
    if (!r || !r.ok) {
      if (r && r.canceled) return undefined;
      return toast('导入失败：' + ((r && r.error) || '未知错误'), 'err');
    }
    const extra = `${r.skipped.length ? `，忽略 ${r.skipped.length} 项未知键` : ''}${r.failed.length ? `，失败 ${r.failed.length} 项` : ''}`;
    toast(`已导入 ${r.applied} 项${extra}`, r.failed.length ? 'warn' : 'ok', 6000);
    return undefined;
  });
  box.appendChild(cfgBar);

  const logTitle = document.createElement('div');
  logTitle.className = 'lbl';
  logTitle.textContent = '诊断日志（最近 1000 行）';
  logTitle.style.margin = '10px 0 4px';
  const logFilter = document.createElement('input');
  logFilter.id = 'logFilter';
  logFilter.placeholder = '过滤关键字，例如 ipc 或 fatal';
  logFilter.style.marginBottom = '4px';
  const logPre = document.createElement('pre');
  logPre.id = 'logTail';
  const refreshLog = () => ipcRenderer.invoke('cap:logTail', { lines: 1000, filter: logFilter.value.trim() })
    .then((r) => {
      const count = r && r.ok ? (r.count || 0) : 0;
      logTitle.textContent = `诊断日志（${logFilter.value.trim() ? '过滤命中 ' : '最近 '}${count} 行）`;
      logPre.textContent = (r && r.ok && r.text) || '(暂无日志)';
    });
  logFilter.addEventListener('change', refreshLog);
  refreshLog();
  box.appendChild(logTitle);
  box.appendChild(logFilter);
  box.appendChild(logPre);

  openModal('设置', [box], [
    { label: '立即重启', onClick: () => ipcRenderer.invoke('cap:restart') },
    { id: 'logRefresh', label: '刷新日志', onClick: refreshLog },
    { id: 'logOpen', label: '打开日志所在文件夹', onClick: () => ipcRenderer.invoke('cap:openLog') },
    { label: '关闭', primary: true, onClick: closeModal },
  ]);
}

$('appSettings').onclick = openAppSettings;
$('bannerClose').onclick = () => { $('banner').hidden = true; };

function showBanner(text, actions) {
  $('bannerText').textContent = text;
  const box = $('bannerActions');
  box.innerHTML = '';
  for (const a of actions || []) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    if (a.primary) btn.className = 'primary';
    btn.onclick = () => bannerAction(a.id);
    box.appendChild(btn);
  }
  $('banner').hidden = false;
}

async function bannerAction(id) {
  if (id === 'restart') return ipcRenderer.invoke('cap:restart');
  if (id === 'settings') return openAppSettings();
  if (id === 'restoreSession') {
    const r = await ipcRenderer.invoke('cap:sessionRestore');
    if (!r || !r.ok) return toast('恢复失败：' + ((r && r.error) || '未知错误'), 'err');
    resetListDom();
    el.detail.innerHTML = '';
    selected = null;
    detailId = null;
    detailData = null;
    r.records.forEach(appendRecord);
    (r.wsFrames || []).forEach(appendWs);
    updateCounts();
    $('banner').hidden = true;
    toast(`已恢复 ${r.count} 条记录`, 'ok');
    return undefined;
  }
  if (id === 'discardSession') {
    $('banner').hidden = true;
    await ipcRenderer.invoke('cap:sessionDiscard');
  }
  return undefined;
}

ipcRenderer.on('cap:banner', (_e, b) => showBanner(b.text, b.actions));

async function navigate(input) {
  const r = await ipcRenderer.invoke('cap:navigate', input);
  if (!r.ok) $('status').textContent = r.error;
  else $('url').value = input.trim();
}

// 过滤框输入：先解析 body: 关键字（需要主进程算命中集），再本地重过滤
function syncBodySearch() {
  const m = String(el.filter.value).match(/(?:^|\s)body:(\S+)/);
  const raw = m ? m[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1') : '';
  if (!raw) {
    if (bodyQuery !== '') { bodyQuery = ''; bodyHits = null; updateListNote(); }
    return;
  }
  if (raw === bodyQuery) return;
  bodyQuery = raw;
  clearTimeout(bodySearchTimer);
  bodySearchTimer = setTimeout(async () => {
    const r = await ipcRenderer.invoke('cap:searchBody', raw);
    if (!r || !r.ok) {
      bodyQuery = '';
      return toast('响应体搜索失败：' + ((r && r.error) || '未知错误'), 'err');
    }
    bodyHits = new Set(r.ids);
    updateListNote();
    refilter();
  }, 300);
}

el.filter.addEventListener('input', () => { syncBodySearch(); refilter(); });
el.type.addEventListener('change', refilter);
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => { view = t.dataset.view; syncTabs(); }; });

// 主进程把抓包事件按 100ms 合并成一批；先 drop 再 record 再 update，已 drop 的更新不会复活行
function applyBatch(b) {
  for (const id of (b && b.drops) || []) dropRow(id);
  for (const rec of (b && b.records) || []) appendRecord(rec);
  for (const rec of (b && b.updates) || []) {
    if (rows.has(rec.id)) updateRecord(rec);
  }
  for (const f of (b && b.ws) || []) appendWs(f);
  if (b && (b.drops || []).length) {
    updateCounts();
    updateListNote();
  }
}
ipcRenderer.on('cap:batch', (_e, b) => applyBatch(b));
ipcRenderer.on('cap:status', (_e, s) => { $('status').textContent = s; });
ipcRenderer.on('cap:navigated', (_e, d) => {
  $('url').value = d.url;
  $('back').disabled = !d.canGoBack;
  $('fwd').disabled = !d.canGoForward;
});

$('tabNew').onclick = () => ipcRenderer.invoke('cap:tabNew');
$('listNew').onclick = () => {
  el.list.scrollTop = el.list.scrollHeight;
  listNew = 0;
  updateListNew();
};
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
ipcRenderer.on('cap:tabs', (_e, d) => renderTabs(d && d.tabs, d && d.activeTabId));
ipcRenderer.on('cap:tabChanged', async () => refreshActiveList(await ipcRenderer.invoke('cap:list')));

/* -------------------------------------------------------------- 初始化 */

let toggleState = true;
(async () => {
  const d = await ipcRenderer.invoke('cap:list');
  // 按持久化宽度摆放面板（主进程已按同一数值摆放原生视图；不要再回传，否则会反向覆盖）
  applyPanelWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, d.panelWidth || 520)));
  refreshActiveList(d);

  // 回填爬虫设置控件
  const cfgAll = await ipcRenderer.invoke('cap:cfgAll');
  $('blockMode').value = cfgAll.blockMode;
  $('blockKeywords').value = cfgAll.blockKeywords;
  $('recordOnly').checked = !!cfgAll.recordOnly;
  $('throttle').value = cfgAll.throttle;
  $('headers').value = cfgAll.headers;
  $('proxy').value = cfgAll.proxy;
  $('colSet').value = cfgAll.colSet || 'd';
  refilter();
  $('reqDelay').value = Number.isFinite(Number(cfgAll.reqDelay)) ? Number(cfgAll.reqDelay) : 0;
  $('recShots').checked = !!cfgAll.recShots;
  if (cfgAll.ua) {
    const preset = Object.keys(UA_PRESETS).find((k) => UA_PRESETS[k] === cfgAll.ua);
    if (preset) $('uaSel').value = preset;
    else { $('uaSel').value = 'custom'; $('uaCustom').hidden = false; $('uaCustom').value = cfgAll.ua; }
  }

  // 上次会话可恢复 → 横幅提示
  const si = await ipcRenderer.invoke('cap:sessionInfo');
  if (si && si.exists) {
    const when = si.savedAt ? new Date(si.savedAt).toLocaleString() : '未知时间';
    showBanner(`发现上次会话（${si.count} 条记录，保存于 ${when}）`, [
      { id: 'restoreSession', label: '恢复', primary: true },
      { id: 'discardSession', label: '忽略' },
    ]);
  }
})();
