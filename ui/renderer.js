'use strict';
// 面板渲染进程：无框架，纯 DOM。nodeIntegration=true，因此可直接用 require('electron') 拿 ipcRenderer / clipboard。
const { ipcRenderer, clipboard } = require('electron');

const $ = (id) => document.getElementById(id);
const el = { list: $('list'), ws: $('ws'), wsView: $('wsView'), detail: $('detail'), filter: $('filter'), type: $('typeFilter'), sort: $('sortBy') };
el.listInner = el.list.querySelector('#listInner');

const rows = new Map();     // id -> { rec }：全部记录（内存唯一真相源；导出 / 详情 / 瀑布图都读它）
const live = new Map();     // index -> node：只有滚动窗口内的条目才有 DOM（虚拟滚动）
let colMode = 'd';          // 当前列预设（与 #colSet 同步；只在切换时更新，避免逐行读 DOM）
let order = [];             // 渲染顺序：[{ t:'row', id } | { t:'grp', host, count }]（过滤 + 排序 + 分组的结果）
let orderDirty = false;     // order 落后于 rows（新记录 / 更新到达），等合并重建
let visibleCount = 0;       // 过滤命中的记录数（内存口径，增量维护；updateCounts 直接用它）
let listNew = 0;            // 未读新记录数（用户不在底部时累计）
let selected = null;
const ROW_H = 26;           // 与 .row / .grp 的 CSS 高度一致（box-sizing: border-box）
const OVERSCAN = 8;         // 窗口上下各多渲染几行，滚动时不闪
let detailId = null;
let detailData = null;      // 当前详情面板对应的记录（复制按钮用）
let view = 'list';
let pickTarget = '';      // 元素拾取的回填目标：'tools' | 'extract' | 'field' | ''（空 = 只写剪贴板）
const REC_WARN_BYTES = 1024 ** 3;   // 录制目录超过 1GB 时在「录制历史」里提醒

const BODY_PREVIEW = 200 * 1024;          // 详情里文本响应体的预览上限
const detailFull = new Set();             // 记录「已展开全文」的记录 id
const detailPretty = new Set();           // 记录「响应体已美化 JSON」的记录 id

/* ---------------------------------------------------------- 面板宽度拖拽 */

const PANEL_MIN = 320, PANEL_MAX = 1000;
let dragging = false, dragRaf = 0;
const applyPanelWidth = (w) => {
  $('panel').style.width = w + 'px';
  document.documentElement.style.setProperty('--panel-w', w + 'px');   // 弹窗遮罩按面板宽度收口
};
const readPanelWidth = () => Math.round($('panel').getBoundingClientRect().width);

// mousedown/mousemove/mouseup（合成事件在自检里可用；Pointer Events 的 setPointerCapture 不能）
$('splitter').addEventListener('mousedown', (e) => {
  dragging = true;
  $('splitter').classList.add('on');
  e.preventDefault();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  $('splitter').classList.remove('on');
  ipcRenderer.invoke('cap:panelWidth', readPanelWidth());   // 收尾：主进程按最终宽度摆放视图并落盘
};
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  // 拖到左侧原生视图上时 mouseup 收不到（BrowserView 是独立合成层，事件不进面板窗口）：
  // 用「按键还在吗」兜底，否则 dragging 会一直卡着，鼠标一回到面板就继续改宽度
  if (!e.buttons) { endDrag(); return; }
  const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - e.clientX));
  applyPanelWidth(w);
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => { dragRaf = 0; ipcRenderer.invoke('cap:panelWidth', readPanelWidth()); });
});
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

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
  return matchKey(rec, token.slice(0, i), token.slice(i + 1), token);
}

// token 已经拆好时直接判定（过滤是热路径：列表里每一行都要过一遍，不能每行重新切字符串）
function matchKey(rec, key, v, token) {
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

// 过滤串的解析缓存：只有输入框内容变了才重新解析
const filterCache = { raw: null, parts: [] };

function parseQuery(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().split(/\s+/).map((part) => {
    const neg = part.startsWith('!');
    const token = neg ? part.slice(1) : part;
    if (!token) return null;
    const i = token.indexOf(':');
    return i > 0 ? { neg, token, key: token.slice(0, i), val: token.slice(i + 1) } : { neg, token, key: '', val: '' };
  }).filter(Boolean);
}

function queryParts() {
  const raw = el.filter.value;
  if (filterCache.raw !== raw) {
    filterCache.raw = raw;
    filterCache.parts = parseQuery(raw);
  }
  return filterCache.parts;
}

function matchParsed(rec, parts) {
  for (const p of parts) {
    const hit = matchKey(rec, p.key, p.val, p.token);
    if (p.neg ? hit : !hit) return false;
  }
  return true;
}

// 空白切分，全部命中才算匹配（AND）；以 ! 开头的 token 取反（纯函数，自检直接调它）
function matchQuery(rec, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  return matchParsed(rec, parseQuery(q));
}

function matches(rec) {
  if (el.type.value && rec.type !== el.type.value) return false;
  return matchParsed(rec, queryParts());
}

// 把一行从内存与窗口里移除（主进程 drop / 整表同步）
function dropRow(id) {
  const r = rows.get(id);
  if (!r) return;
  if (matches(r.rec)) visibleCount--;
  removeLive(id);
  rows.delete(id);
  orderDirty = true;
  scheduleOrder();
  invalidateBottom();
}

// 清空列表与计数（「清空」按钮 / 会话恢复前调用）
function resetListDom() {
  rows.clear();
  live.clear();
  order = [];
  orderDirty = false;
  visibleCount = 0;
  listNew = 0;
  el.listInner._h = 0;
  el.listInner.style.height = '0px';
  el.listInner.innerHTML = '<div class="empty">等待抓取…</div>';
  invalidateBottom();
  el.ws.innerHTML = '';
  $('nWs').textContent = '0';
  detailFull.clear();          // 展开/美化态按 id 记录：id 只在标签内唯一，清空/切标签后必须作废
  detailPretty.clear();
  updateListNew();
  resetBodySearch();
  updateListNote();
  updateCounts();
}

let rowTpl = null;      // 行骨架只解析一次，之后克隆（比重建 innerHTML 快）

function makeRow(rec) {
  if (!rowTpl) {
    rowTpl = document.createElement('div');
    rowTpl.className = 'row';
    rowTpl.innerHTML = '<span class="m"></span><span class="s"></span><span class="u"></span><span class="t"></span><span class="z"></span>';
  }
  const node = rowTpl.cloneNode(true);
  node.dataset.id = rec.id;
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

// 行的上一次绘制值存在 node._p 上：值没变就不碰 DOM
// （抓包更新每个请求 2~4 次，其中绝大多数字段是重复写入，同步写会白白触发样式/布局失效）
function paintRow(node, rec) {
  const mode = colMode;
  if (el.list.dataset.cols !== mode) el.list.dataset.cols = mode;
  const p = node._p || (node._p = {});
  const m = rec.method || '';
  if (p.m !== m) { p.m = m; node.dataset.m = m; node.children[0].textContent = m; }
  const restored = rec.restored ? '1' : '';
  if (p.restored !== restored) { p.restored = restored; node.dataset.restored = restored; }
  const star = rec.star ? '1' : '';
  if (p.star !== star) { p.star = star; node.dataset.star = star; }
  const note = rec.note ? '1' : '';
  if (p.note !== note) { p.note = note; node.dataset.note = note; }
  const s = node.children[1];
  const sText = rec.status || (rec.failed ? '×' : '…');
  if (p.sText !== sText) { p.sText = sText; s.textContent = sText; }
  const sCls = 's ' + statusClass(rec.status);
  if (p.sCls !== sCls) { p.sCls = sCls; s.className = sCls; }
  const url = rec.url || '';
  const title = rec.note ? `${url}\n备注：${rec.note}` : url;
  if (p.url !== url || p.title !== title) { p.url = url; p.title = title; node.children[2].textContent = url; node.title = title; }
  const t = node.children[3];
  const tText = mode === 't' ? String(rec.time || '').slice(11, 19) : (rec.duration != null ? rec.duration + 'ms' : (rec.type || ''));
  if (p.tText !== tText) { p.tText = tText; t.textContent = tText; }
  const tCls = 't' + (rec.failed ? ' s4' : '');
  if (p.tCls !== tCls) { p.tCls = tCls; t.className = tCls; }
  const zText = mode === 'dt' ? `${rec.type || ''} ${humanSize(rec.size)}` : '';
  if (p.zText !== zText) { p.zText = zText; node.children[4].textContent = zText; }
}

function updateListNew() {
  $('listNew').hidden = listNew <= 0;
  $('listNew').textContent = `↓ ${listNew} 条新记录`;
}

function updateListNote() {
  const n = $('listNote');
  if (bodyQuery && !bodyHits) {                    // 命中集还没回来：明确「搜索中」，不再让空列表冒充「没匹配」
    n.hidden = false;
    n.textContent = '响应体搜索中…';
    return;
  }
  if (bodyHits) {                                  // body: 生效期间优先显示命中数
    n.hidden = false;
    n.textContent = `响应体命中 ${bodyHits.size} 条`;
    return;
  }
  n.hidden = true;
  n.textContent = '';
}

/* 列表跟随滚动：「是否在底部」不再每行都去读 scrollHeight。
 * 读 scrollHeight 强制同步布局，3000 行列表下每行一次 = 全表重排（实测这份代码 3000 行 ≈ 30s）；
 * 写 scrollTop 同样要算滚动范围，也会强制布局。所以：
 *   1) 结论缓存，只在真正滚动（滚动事件 / scrollTop 赋值 / 列表重建）时失效；
 *   2) 跟随到底只在一轮任务里写一次 scrollTop（微任务合并，界面下一帧前生效）。 */
let bottomCache = null;
let pendingScroll = false;     // 本任务里已经安排了「滚到底」，只写一次 scrollTop

function invalidateBottom() {
  bottomCache = null;
  pendingScroll = false;        // 用户自己滚动了：取消还没落地的「跟随到底」
}

function listAtBottom() {
  if (bottomCache === null) {
    // 总高度 = 条目数 × 26px（不再读 scrollHeight，避免强制布局）
    bottomCache = (order.length * ROW_H) - el.list.scrollTop - el.list.clientHeight <= ROW_H;
  }
  return bottomCache;
}

// 立刻滚到底（用户点击「↓ N 条新记录」这类显式动作）
function scrollListToBottom() {
  pendingScroll = false;
  el.list.scrollTop = order.length * ROW_H;    // 浏览器自会把超出的值夹到最大滚动位置
  bottomCache = true;
  renderWindow();
}

// 跟随到底：一轮任务里只写一次 scrollTop（写它同样要算滚动范围，会强制布局）
function scheduleScrollToBottom() {
  bottomCache = true;
  if (pendingScroll) return;
  pendingScroll = true;
  Promise.resolve().then(() => {
    if (!pendingScroll) return;
    pendingScroll = false;
    el.list.scrollTop = order.length * ROW_H;
    renderWindow();
  });
}

// 任何 scrollTop 赋值（面板自己、自检脚本、将来的代码）都算一次滚动
const scrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
Object.defineProperty(el.list, 'scrollTop', {
  get() { return scrollTopDesc.get.call(el.list); },
  set(v) { invalidateBottom(); scrollTopDesc.set.call(el.list, v); },
});
el.list.addEventListener('scroll', () => { invalidateBottom(); renderWindow(); }, { passive: true });

function appendRecord(rec) {
  if (rows.has(rec.id)) return;
  rows.set(rec.id, { rec });
  const matched = matches(rec);
  if (matched) visibleCount++;
  if (matched && el.sort.value === 'time' && !orderDirty) order.push({ t: 'row', id: rec.id });
  else { orderDirty = true; scheduleOrder(); }
  const empty = el.listInner.querySelector('.empty');
  if (empty) empty.remove();
  if (listAtBottom()) scheduleScrollToBottom();
  else { listNew++; updateListNew(); }
  renderWindow();
  updateCounts();
  updateListNote();
  if (view === 'wf') scheduleWaterfall();
}

function updateRecord(rec) {
  const r = rows.get(rec.id);
  if (!r) return appendRecord(rec);
  if (matches(r.rec)) visibleCount--;
  r.rec = rec;
  if (matches(rec)) visibleCount++;
  orderDirty = true;
  scheduleOrder();                        // 100ms 合并：排序键 / 分组计数 / 过滤命中都可能变
  renderWindow();
  if (selected === rec.id) scheduleDetailRender(rec.id);
  updateCounts();
  if (view === 'wf') scheduleWaterfall();
}

// 可见数由 appendRecord / updateRecord / dropRow 增量维护，这里只写文本（O(1)，不再每行扫 DOM）
function updateCounts() {
  $('nReq').textContent = visibleCount;
  $('count').textContent = rows.size;
}

/* 列预设 / 过滤两个入口（都同步重建顺序表：过滤命中的记录才进 order，窗口渲染会重画窗口内的行） */
function refilter() {
  applySort();
  if (view === 'wf') scheduleWaterfall();      // 瀑布图跟随筛选
}

function reapplyFilter() {
  applySort();
  if (view === 'wf') scheduleWaterfall();
}

/* ---------------------------------------------------------------- 排序与分组 */

let orderTimer = null;

// 流式追加 / 更新：顺序表重建合并到 100ms 一次（与抓包推送同一量级）；用户动作走同步的 applySort()
function scheduleOrder() {
  if (orderTimer) return;
  orderTimer = setTimeout(() => { orderTimer = null; applySort(); }, 100);
}

// 顺序表 = 过滤命中（matches）的记录，按当前排序 / 分组排列；渲染只按它取窗口
function applySort() {
  if (orderTimer) { clearTimeout(orderTimer); orderTimer = null; }
  const mode = el.sort.value;
  const hostOf = (rec) => { try { return new URL(rec.url).host; } catch (e) { return '(无法解析)'; } };
  const cmp = {
    size: (a, b) => (b.rec.size || 0) - (a.rec.size || 0),
    duration: (a, b) => (b.rec.duration || 0) - (a.rec.duration || 0),
    status: (a, b) => (b.rec.status || 0) - (a.rec.status || 0),
  }[mode];
  const list = [];
  for (const [id, r] of rows) if (matches(r.rec)) list.push({ id, rec: r.rec });
  visibleCount = list.length;
  order = [];
  if (mode === 'domain') {
    const groups = new Map();
    for (const it of list) {                 // 只给过滤命中的记录分组，标题条数才与筛选一致
      const h = hostOf(it.rec);
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(it);
    }
    for (const host of [...groups.keys()].sort()) {
      order.push({ t: 'grp', host, count: groups.get(host).length });
      for (const it of groups.get(host)) order.push({ t: 'row', id: it.id });
    }
  } else if (mode === 'time') {
    for (const it of list) order.push({ t: 'row', id: it.id });   // rows 的插入顺序 = 时间序
  } else {
    list.sort(cmp);
    for (const it of list) order.push({ t: 'row', id: it.id });
  }
  orderDirty = false;
  renderWindow();
  updateCounts();
  updateListNote();
  invalidateBottom();                        // 顺序变了：滚动位置的含义随之改变
}

/* --------------------------------------------------- 窗口渲染（虚拟滚动） */

const clampIdx = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function makeGroup(e) {
  const head = document.createElement('div');
  head.className = 'grp lbl';
  head.textContent = `${e.host} · ${e.count} 条`;
  return head;
}

function removeLive(id) {
  for (const [i, node] of live) {
    if (node._rowId === id) { node.remove(); live.delete(i); return; }
  }
}

// 只渲染滚动窗口覆盖到的条目（上下各多 OVERSCAN 个），行/组头绝对定位（top = 序号 × 26px），
// #listInner 的高度 = 条目数 × 26px —— 因此 DOM 行数恒定在「视口高度 / 26 + 16」上下，与总条数无关
function renderWindow() {
  const n = order.length;
  const height = n * ROW_H;
  if (el.listInner._h !== height) {           // 高度只在条数变化时写：逐行追加也不必每行重写样式
    el.listInner._h = height;
    el.listInner.style.height = height + 'px';
  }
  const first = clampIdx(Math.floor(el.list.scrollTop / ROW_H) - OVERSCAN, 0, n);
  const last = clampIdx(Math.ceil((el.list.scrollTop + el.list.clientHeight) / ROW_H) + OVERSCAN, 0, n);
  for (const [i, node] of [...live]) {
    if (i < first || i >= last || !node.parentNode) { node.remove(); live.delete(i); }
  }
  for (let i = last - 1; i >= first; i--) {     // 反向遍历：处理 i 时 i+1 已经摆好，可用作插入参照
    const e = order[i];
    if (!e) continue;
    const row = e.t === 'row' ? rows.get(e.id) : null;
    if (e.t === 'row' && !row) continue;        // 记录已被 drop、order 还没重建：跳过这一条
    const key = e.t === 'grp' ? `grp:${e.host}` : `row:${e.id}`;
    let node = live.get(i);
    if (node && node._key !== key) { node.remove(); live.delete(i); node = null; }
    if (!node) {
      node = e.t === 'grp' ? makeGroup(e) : makeRow(row.rec);
      node._key = key;
      live.set(i, node);
    }
    const ref = i + 1 < last ? (live.get(i + 1) || null) : null;
    // 位置已经正确时不动 DOM：流式追加下窗口每移动一行只动 1 个节点（全量 appendChild 会把追加拖慢 40 倍）
    if (node.parentNode !== el.listInner || node.nextSibling !== ref) el.listInner.insertBefore(node, ref);
    if (node._i !== i) {                       // top 用「在 order 里的绝对序号」：纯追加时既有行不需要重写 top
      node._i = i;
      node.style.top = (i * ROW_H) + 'px';
    }
    const alt = i % 2 ? '1' : '';
    if (node.dataset.alt !== alt) node.dataset.alt = alt;
    if (e.t === 'row') {
      node._rowId = e.id;
      paintRow(node, row.rec);
      node.classList.toggle('sel', selected === e.id);
    }
  }
}

// 过滤结果的唯一来源：按内存记录算 id（虚拟滚动下 DOM 只是窗口切片，绝不能作为导出依据）
function filteredIds() {
  const out = [];
  for (const [id, r] of rows) if (matches(r.rec)) out.push(id);
  return out;
}

/* ------------------------------------------------------------- 详情渲染 */

// HTML 文本转义：详情面板里所有抓取内容都必须过它（URL/头/请求体/响应体/失败原因都来自页面，天然含尖括号）
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 属性值转义（详情面板里的输入框 value=...）：在 esc 之后再补引号
const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
  let parsed = null;                                  // 只有小体积的文本体才尝试解析（避免大 JSON 卡住面板）
  try {
    if (r.body && r.body.length <= 4 * 1048576 && /^[\[{]/.test(r.body.trim())) parsed = JSON.parse(r.body);
  } catch (e) { parsed = null; }
  const pretty = parsed !== null && detailPretty.has(r.id);
  const src = pretty ? JSON.stringify(parsed, null, 2) : r.body;
  const big = src.length > BODY_PREVIEW;
  const expanded = !!detailFull.has(r.id);
  const shown = big && !expanded ? src.slice(0, BODY_PREVIEW) : src;
  const size = (src.length / 1048576).toFixed(1);
  const note = !big ? '' : expanded
    ? `<div class="lbl">已展开全部 ${size}MB</div>`
    : `<div class="lbl">已截断显示前 200KB（完整 ${size}MB）</div>`;
  const prettyBtn = parsed !== null ? `<button id="bodyPretty">${pretty ? '还原原文' : '美化 JSON'}</button>` : '';
  return `<h3>响应体</h3><pre>${esc(shown)}</pre>${note}` +
    `<div class="dbar">${prettyBtn}<button id="bodySave">另存为文件</button>${big ? `<button id="bodyToggle">${expanded ? '收起' : '查看全文'}</button>` : ''}</div>`;
}

// 发起者：纯文本行（详情展示与「复制发起者」共用同一份）
function initiatorLines(it) {
  return [it.type + (it.url ? ` · ${it.url}${it.lineNumber ? ':' + it.lineNumber : ''}` : '')]
    .concat((it.stack || []).map((f) => `${f.fn} @ ${f.url || '(inline)'}:${f.line}:${f.col}`));
}

function initiatorBlock(d) {
  if (!d.initiator) return '';
  return `<h3>发起者</h3><pre>${initiatorLines(d.initiator).map(esc).join('\n')}</pre>` +
    '<div class="dbar"><button id="copyInit">复制发起者</button></div>';
}

function timingBlock(d) {
  const p = d.timingParts;
  if (!p) return '';
  return `<h3>耗时分解</h3><pre>DNS ${p.dns}ms · 连接 ${p.connect}ms · TLS ${p.tls}ms · 发送 ${p.send}ms · 等待 ${p.wait}ms · 下载 ${p.download}ms</pre>`;
}

function renderDetail(id) {
  window.__detailRenders = (window.__detailRenders || 0) + 1;   // 自检观测点
  const entry = rows.get(id);
  detailId = id;
  el.detail.classList.add('on');
  if (!entry) { el.detail.innerHTML = '<div class="empty">记录已被清理</div>'; return; }
  ipcRenderer.invoke('cap:detail', id).then((d) => {
    if (detailId !== id) return;    // 在途响应已过期（清空 / 切标签 / 又选了别的行）：不能回填成幽灵详情
    if (!d) { el.detail.innerHTML = '<div class="empty">未找到记录 #' + esc(id) + '</div>'; return; }
    detailData = d;
    el.detail.innerHTML =
      `<div class="dbar"><button id="markStar">${d.star ? '★ 已标记（点击取消）' : '★ 标记'}</button><button id="copyCurl">复制 cURL</button><button id="replayReq">重放请求</button><button id="expOne">导出此条</button><button id="saveReq">请求体另存</button><button id="copyUrl">复制 URL</button><button id="copyRespHeaders">复制响应头</button><button id="copyBody">复制响应体</button><button id="codeBtn">复制代码…</button><button id="mockRec">设为 mock</button></div>` +
      `<input id="markComment" placeholder="备注（回车保存）" value="${escAttr(d.comment || '')}">` +
      `<h3>概要</h3><pre><span class="kv">URL     </span>${esc(d.url)}
<span class="kv">方法    </span>${esc(d.method)}  <span class="kv">状态</span> ${esc(d.status)} ${esc(d.statusText)}
<span class="kv">类型    </span>${esc(d.type)}  <span class="kv">MIME</span> ${esc(d.mime)}
<span class="kv">远端    </span>${esc(d.remoteIP)}  ${esc(d.protocol)}  <span class="kv">耗时</span> ${d.durationMs == null ? '-' : d.durationMs + 'ms'}  <span class="kv">大小</span> ${d.encodedDataLength}B
<span class="kv">时间    </span>${esc(d.time)}</pre>` +
      initiatorBlock(d) +
      timingBlock(d) +
      (d.note ? `<h3>备注</h3><pre>${esc(d.note)}</pre>` : '') +
      (d.restored ? '<h3>来源</h3><pre class="muted">上次会话恢复（不是本次抓取）</pre>' : '') +
      (d.failed ? `<h3>失败</h3><pre class="s4">${esc(d.failed.errorText)}${d.failed.blockedReason ? ' · ' + esc(d.failed.blockedReason) : ''}</pre>` : '') +
      (d.redirects.length ? `<h3>重定向链</h3><pre>${d.redirects.map((x) => `${x.status} ${esc(x.url)}\n   → ${esc(x.location)}`).join('\n')}</pre>` : '') +
      headersBlock('请求头（原始，含 Cookie）', d.requestHeaders, d.requestHeadersRaw) +
      (d.postData ? `<h3>请求体</h3><pre>${esc(d.postData)}</pre>` : '') +
      headersBlock('响应头（原始，含 Set-Cookie）', d.responseHeaders, d.responseHeadersRaw) +
      bodyBlock(d);
  });
}

// 收起详情与选中（清空 / 会话恢复 / 切标签共用）：记录 id 只在单个标签内唯一，
// 切标签后旧 id 很可能落在新标签的另一条记录上，继续留着会「复制到错的那条」
function clearDetail() {
  clearTimeout(detailTimer);       // 在途的 200ms 刷新必须一起取消：否则清空/切标签后详情会「复活」，还可能渲染到新标签同 id 的记录
  detailTimer = null;
  detailDirty = false;
  selected = null;
  detailId = null;
  detailData = null;
  el.detail.innerHTML = '';
}

function select(id) {
  clearTimeout(detailTimer);
  detailTimer = null;
  detailDirty = false;
  if (selected != null) {
    const prevIdx = order.findIndex((e) => e.t === 'row' && e.id === selected);
    const prevNode = prevIdx >= 0 ? live.get(prevIdx) : null;
    if (prevNode) prevNode.classList.remove('sel');
  }
  selected = id;
  // 先切回列表再滚动/渲染：列表 display:none 时 clientHeight 为 0，滚动会被夹到 0、窗口也算不出目标行
  view = 'list';
  syncTabs();
  const idx = order.findIndex((e) => e.t === 'row' && e.id === id);
  if (idx >= 0 && !live.has(idx)) {            // 目标不在窗口里：先滚到它附近
    el.list.scrollTop = Math.max(0, idx * ROW_H - Math.round(el.list.clientHeight / 2));
  }
  renderWindow();
  const node = idx >= 0 ? live.get(idx) : null;
  if (node) node.classList.add('sel');
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
  const all = [...rows.values()].map((v) => v.rec);
  const list = all.filter((r) => matches(r) && r.time && r.duration != null);
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
  $('wfInfo').textContent = `${list.length} 条 · 命中 ${list.length}/${all.length} · 跨度 ${Math.round(span)}ms`;
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
  invalidateBottom();                                   // 整表重建：滚动位置的含义变了
  const incoming = d.records || [];
  const keep = new Set(incoming.map((r) => r.id));
  for (const id of [...rows.keys()]) if (!keep.has(id)) dropRow(id);
  for (const rec of incoming) {
    if (rows.has(rec.id)) updateRecord(rec);
    else appendRecord(rec);
  }
  if (!rows.size) el.listInner.innerHTML = '<div class="empty">等待抓取…</div>';
  listNew = 0;
  applySort();                                          // 重建顺序表（过滤 + 排序 + 分组）并按窗口渲染
  scrollListToBottom();                                 // 整表同步后停在最新（与原「DOM 全量重建」语义一致）
  updateListNew();
  updateListNote();
  rebuildWs(d.wsFrames || []);
  renderTabs(d.tabs, d.activeTabId);
  if (d.url && d.url !== 'about:blank') $('url').value = d.url;
  toggleState = d.enabled;
  $('toggle').textContent = d.enabled ? '暂停' : '继续';
  $('status').textContent = d.status;
  clearDetail();       // 整表重刷（切标签 / 会话恢复）一律收起详情：id 只在标签内唯一，旧选中没有意义
  resetBodySearch();   // 命中集同样只在单标签内有效：切标签后按新标签重算
  detailFull.clear();  // 展开/美化态同理作废，否则新标签同 id 记录会误显示「已展开全文」
  detailPretty.clear();
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

const MAX_WS_DISPLAY = 2000;      // 与主进程 MAX_WS_FRAMES 一致：面板 DOM 只保留最近这么多帧

function appendWs(frame) {
  if ($('wsPause').checked) return;                 // 暂停只影响显示，数据仍在主进程
  if (!wsMatch(frame)) return;
  const empty = el.ws.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.textContent = wsText(frame);
  el.ws.appendChild(div);
  while (el.ws.children.length > MAX_WS_DISPLAY) el.ws.removeChild(el.ws.firstChild);
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
  const lsBar = document.createElement('div');
  lsBar.className = 'dbar';
  const lsBtn = document.createElement('button');
  lsBtn.textContent = '导入 Storage';
  lsBtn.title = '批量导入键值对到 localStorage';
  lsBtn.onclick = () => {
    const ta = textarea('JSON 对象 {"k":"v"} 或每行 k=v（导入到 localStorage）', '');
    openModal('导入 Storage', [labelled('内容', ta)], [
      { label: '导入', primary: true, onClick: async () => {
        const raw = String(ta.value || '').trim();
        if (!raw) return toast('没有可导入的内容', 'warn');
        let entries = [];
        try {
          if (raw.startsWith('{')) {
            const obj = JSON.parse(raw);
            entries = Object.entries(obj).map(([k, v]) => [k, String(v == null ? '' : v)]);
          } else {
            entries = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
              const i = l.indexOf('=');
              return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : null;
            }).filter(Boolean);
          }
        } catch (e) { return toast('解析失败：' + e.message, 'err'); }
        if (!entries.length) return toast('没有可导入的键值对', 'warn');
        let okN = 0;
        const bad = [];
        for (const [k, v] of entries) {
          const r = await ipcRenderer.invoke('cap:storageSet', { area: 'local', key: k, value: v });
          if (r && r.ok) okN++;
          else bad.push(k);
        }
        toast(`已导入 ${okN} 项${bad.length ? `，失败 ${bad.length} 项` : ''}`, bad.length ? 'warn' : 'ok');
        openSessionData();
        return undefined;
      } },
      { label: '取消', onClick: () => openSessionData() },
    ]);
  };
  lsBar.appendChild(lsBtn);
  box.appendChild(lsBar);
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
    const btn = $('replaySend');
    out.hidden = false;
    out.textContent = '重放中…';
    $('status').textContent = '重放中…';
    btn.disabled = true;
    try {
      const r = await ipcRenderer.invoke('cap:replay', detailId, {
        method: methodIn.value.trim(), url: urlIn.value.trim(),
        headers: headersTa.value, body: bodyTa.value,
      });
      if (!r || !r.ok) {
        out.textContent = '重放失败：' + ((r && r.error) || '主进程没有返回结果');
        $('status').textContent = '重放失败';
        return;
      }
      out.textContent = `${r.status} ${r.statusText}  ${r.tookMs}ms${r.truncated ? '（响应体已截断到 1MB）' : ''}\n${JSON.stringify(r.headers, null, 2)}\n\n${r.body}`;
      $('status').textContent = `重放完成：${r.status}`;
    } catch (e) {
      out.textContent = '重放失败：' + e.message;
      $('status').textContent = '重放失败';
    } finally {
      btn.disabled = false;
    }
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
  const ids = [];
  for (const e of order) if (e.t === 'row') ids.push(e.id);
  if (!ids.length) return;
  let idx = ids.indexOf(selected);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
  if (next == null) return;
  select(next);                                  // select 负责把目标滚进窗口并高亮
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
  if (!$('modal').hidden) return;   // 模态打开时其余快捷键一律不穿透：方向键不再改到背后列表的选中/视图/详情
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
  clearDetail();
  if (view === 'wf') renderWaterfall();
});
$('toggle').onclick = () => ipcRenderer.invoke('cap:setEnabled', !toggleState).then((v) => {
  toggleState = v; $('toggle').textContent = v ? '暂停' : '继续';
});
$('pageData').onclick = () => openSessionData();
$('expAll').onclick = () => exportResult(ipcRenderer.invoke('cap:exportAll'));
$('expFiltered').onclick = () => {
  const ids = filteredIds();
  if (!ids.length) return toast('当前没有筛选项', 'warn');
  exportResult(ipcRenderer.invoke('cap:exportAll', ids));
};
$('expHtml').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHtml'));
$('expCookie').onclick = () => exportResult(ipcRenderer.invoke('cap:exportCookieJson'));
$('expHar').onclick = () => exportResult(ipcRenderer.invoke('cap:exportHar', {}));
$('expPostman').onclick = () => exportResult(ipcRenderer.invoke('cap:exportPostman', {}));
$('expOpenApi').onclick = () => exportResult(ipcRenderer.invoke('cap:exportOpenApi', {}));
$('copyMd').onclick = async () => {
  const ids = filteredIds();
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
      renderWindow();                        // 窗口内的行重画（星级在行 dataset 上）
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
  } else if (id === 'mockRec') {
    const d = detailData;
    if (!d) return;
    let urlRe;
    try { const u = new URL(d.url); urlRe = '^' + (u.origin + u.pathname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    catch (err) { urlRe = '^' + String(d.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    const all = await ipcRenderer.invoke('cap:cfgAll');
    const mock = (all && all.mock) || { on: true, rules: [] };
    const rules = (mock.rules || []).concat([{
      on: true, urlRe, status: d.status || 200,
      headers: headersText(d.responseHeaders, d.responseHeadersRaw),
      body: d.body == null ? '' : String(d.body), bodyBase64: !!d.bodyBase64,
    }]);
    const r = await ipcRenderer.invoke('cap:mockSet', { on: true, rules });
    if (!r || !r.ok) return toast('设为 mock 失败：' + ((r && r.error) || '未知错误'), 'err');
    toast('已添加 mock 规则：' + urlRe, 'ok', 6000);
    return undefined;
  } else if (id === 'copyInit') {
    if (!detailData || !detailData.initiator) return;
    const lines = initiatorLines(detailData.initiator);
    clipboard.writeText(lines.join('\n'));
    $('status').textContent = `已复制发起者（${lines.length} 行）`;
  } else if (id === 'bodyToggle') {
    if (detailId == null) return;
    if (detailFull.has(detailId)) detailFull.delete(detailId); else detailFull.add(detailId);
    renderDetail(detailId);
  } else if (id === 'bodyPretty') {
    if (detailId == null) return;
    if (detailPretty.has(detailId)) detailPretty.delete(detailId); else detailPretty.add(detailId);
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
    toast('请在页面上点击目标元素（Esc 取消）', 'info', 5000, { label: '取消', onClick: () => ipcRenderer.invoke('cap:pickCancel') });
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
  } else if (pickTarget === 'field') {
    const tas = document.querySelectorAll('#modalBody textarea');   // [0]=行选择器 [1]=字段
    if (tas[1]) {
      const t = tas[1];
      t.value = (t.value.trim() ? t.value.replace(/\n+$/, '') + '\n' : '') + p.sel;   // 追加一行，名称由用户改成「名称=选择器」
    }
  } else {
    clipboard.writeText(p.sel);
  }
  toast('选择器：' + p.sel, 'ok', 5000, {
    label: '复制 XPath',
    onClick: () => {
      clipboard.writeText(p.xpath || '');
      return p.xpath ? toast('已复制 XPath', 'ok', 2000) : toast('该元素没有生成 XPath', 'warn', 2000);
    },
  });
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
$('proxyTest').onclick = async () => {
  const r = await ipcRenderer.invoke('cap:proxyTest', {});
  if (r && r.ok) {
    $('status').textContent = `代理连通：${r.proxy} → ${r.status}（${r.tookMs}ms）`;
    toast(`代理连通：${r.proxy} → ${r.status}（${r.tookMs}ms）`, 'ok', 6000);
    return undefined;
  }
  toast(`代理测试失败：${(r && r.error) || '未知错误'}（解析：${(r && r.proxy) || '-'}）`, 'err', 7000);
  return undefined;
};
$('colSet').addEventListener('change', () => { colMode = $('colSet').value; refilter(); cfg('colSet', $('colSet').value); });
$('sortBy').addEventListener('change', () => { applySort(); cfg('sortBy', $('sortBy').value); });
$('reqDelay').addEventListener('change', () => cfg('reqDelay', +$('reqDelay').value));

/* ---- 响应体落盘规则 ---- */
let saveRulePaint = null;      // 模态打开时的状态行绘制函数（模态关闭后只写状态栏）

function saveRuleText(s) {
  const mb = ((s && s.bytes) || 0) / 1048576;
  if (s && s.blocked) return s.blocked;
  return `已落盘 ${(s && s.n) || 0} 个 · ${mb.toFixed(1)}MB`;
}

async function openSaveRule() {
  const got = await ipcRenderer.invoke('cap:saveRuleGet');
  if (!got || !got.ok) return toast('读取落盘规则失败', 'err');
  const rule = got.rule || {};
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = !!rule.on;
  const onWrap = document.createElement('label');
  onWrap.className = 'lbl';
  onWrap.appendChild(on);
  onWrap.appendChild(document.createTextNode(' 命中规则时把响应体直接写进目录'));
  const urlRe = document.createElement('input');
  urlRe.placeholder = '/api/ 或 \\.json$（留空 = 全部）';
  urlRe.value = rule.urlRe || '';
  const types = document.createElement('select');
  for (const [v, t] of [['all', '全部类型'], ['xhr', '仅 XHR / Fetch'], ['doc', '仅 Document']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    types.appendChild(o);
  }
  types.value = rule.types || 'all';
  const mimes = document.createElement('input');
  mimes.placeholder = 'json,csv,zip（逗号分隔，留空 = 全部）';
  mimes.value = rule.mimes || '';
  const dir = document.createElement('input');
  dir.placeholder = '落盘目录';
  dir.value = rule.dir || '';
  dir.style.flex = '1';
  const dirRow = document.createElement('div');
  dirRow.style.display = 'flex';
  dirRow.style.gap = '6px';
  const pick = document.createElement('button');
  pick.textContent = '选择…';
  pick.onclick = async () => {
    const r = await ipcRenderer.invoke('cap:pickDir');
    if (r && r.ok) dir.value = r.dir;
  };
  dirRow.appendChild(dir);
  dirRow.appendChild(pick);
  const stateLine = document.createElement('div');
  stateLine.className = 'lbl';
  const paint = (s) => { stateLine.textContent = saveRuleText(s); };
  paint(got);
  saveRulePaint = paint;
  openModal('响应体落盘规则（单次运行最多 2000 个 / 512MB）', [
    onWrap,
    labelled('URL 正则（留空 = 全部）', urlRe),
    labelled('类型', types),
    labelled('MIME 关键字', mimes),
    labelled('目录', dirRow),
    stateLine,
  ], [
    { id: 'saveRuleSave', label: '保存', primary: true, onClick: async () => {
      const dirVal = dir.value.trim();
      if (on.checked && !dirVal) return toast('开启落盘前请先选择目录', 'warn');
      const r = await ipcRenderer.invoke('cap:saveRuleSet', {
        on: on.checked, urlRe: urlRe.value, types: types.value, mimes: mimes.value, dir: dirVal,
      });
      if (!r || !r.ok) return toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
      paint(r);
      toast('落盘规则已保存', 'ok');
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
  return undefined;
}
$('saveRule').onclick = openSaveRule;
ipcRenderer.on('cap:saveRule', (_e, s) => {
  if (saveRulePaint && !$('modal').hidden) return saveRulePaint(s);
  $('status').textContent = saveRuleText(s);
  return undefined;
});
/* ---- Mock：按 URL 规则本地返回响应（CDP Fetch 域）---- */
async function openMock() {
  const got = await ipcRenderer.invoke('cap:mockGet');
  if (!got || !got.ok) return toast('读取 Mock 规则失败', 'err');
  const mock = got.mock || { on: false, rules: [] };
  const hits = got.hits || {};
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.id = 'mockOn';
  on.checked = !!mock.on;
  const onWrap = document.createElement('label');
  onWrap.className = 'lbl';
  onWrap.appendChild(on);
  onWrap.appendChild(document.createTextNode(' 开启（命中规则的请求本地应答；未命中一律原样放行）'));
  const stateLine = document.createElement('div');
  stateLine.className = 'lbl';
  const paintHits = (h) => {
    const ks = Object.keys(h || {});
    stateLine.textContent = `命中：${ks.length} 条规则 / 共 ${ks.reduce((n, k) => n + (h[k] || 0), 0)} 次`;
  };
  paintHits(hits);
  const { table, tbody } = makeTable(['启用', 'URL 正则', '状态', '响应头（每行 名称: 值）', '响应体', '命中', '']);
  const rules = (mock.rules || []).map((r) => Object.assign({}, r));
  const paintRowM = (rule) => {
    const tr = document.createElement('tr');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.on !== false;
    cb.addEventListener('change', () => { rule.on = cb.checked; });
    const tdCb = document.createElement('td');
    tdCb.appendChild(cb);
    tr.appendChild(tdCb);
    tr.appendChild(tdInput(rule.urlRe, (inp) => { rule.urlRe = inp.value.trim(); }));
    tr.appendChild(tdInput(rule.status, (inp) => { rule.status = Number(inp.value) || 200; }));
    tr.appendChild(tdInput(rule.headers, (inp) => { rule.headers = inp.value; }));
    tr.appendChild(tdInput(rule.bodyBase64 ? `[base64] ${String(rule.body || '').slice(0, 80)}` : rule.body, (inp) => {
      rule.body = inp.value; rule.bodyBase64 = false;
    }));
    tr.appendChild(tdText(String(hits[rule.id] || 0)));
    tr.appendChild(tdBtn('删除', () => { rule.__deleted = true; tr.remove(); }));
    tbody.appendChild(tr);
  };
  for (const r of rules) paintRowM(r);
  const addBtn = document.createElement('button');
  addBtn.className = 'ghost';
  addBtn.textContent = '新增规则';
  addBtn.onclick = () => {
    const r = { on: true, urlRe: '', status: 200, headers: '', body: '', bodyBase64: false };
    rules.push(r);
    paintRowM(r);
  };
  const hint = document.createElement('div');
  hint.className = 'lbl';
  hint.textContent = '规则按顺序匹配，第一条命中生效；响应体逐字返回，二进制记录请用详情里的「设为 mock」（带 base64 标记）。改规则或开关会重置命中计数。';
  openModal('Mock 改写（CDP Fetch 域：命中规则的请求本地应答）', [
    onWrap, stateLine, table, addBtn, hint,
  ], [
    { id: 'mockSave', label: '保存', primary: true, onClick: async () => {
      const payload = {
        on: on.checked,
        rules: rules.filter((r) => !r.__deleted).map((r) => ({
          id: r.id, on: r.on !== false, urlRe: r.urlRe || '', status: r.status,
          headers: r.headers || '', body: r.body || '', bodyBase64: !!r.bodyBase64,
        })),
      };
      const r = await ipcRenderer.invoke('cap:mockSet', payload);
      if (!r || !r.ok) return toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
      paintHits(r.hits);
      toast(`Mock 已${r.on ? '开启' : '关闭'}（${r.mock.rules.length} 条规则）`, 'ok');
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
  return undefined;
}
$('mockRule').onclick = openMock;

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
const REASON = { done: '完成', 'no-next': '未找到「下一页」', stopped: '已停止', timeout: '超时', 'extract-failed': '提取失败' };

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

/* ---- CSS / XPath 选择器提取 + 翻页合并任务 ---- */
let lastExtract = null;      // 最近一次提取/合并的行（导出用）
let taskPresets = [];        // 任务预设（settings.tasks 的本地副本）

// 预览一张行表（提取 / 合并任务共用）
function paintRowPreview(out, rows, tipText) {
  out.innerHTML = '';
  const cols = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  out.appendChild(dataTable(cols, rows.slice(0, 20)));
  const tip = document.createElement('div');
  tip.className = 'lbl';
  tip.textContent = tipText;
  out.appendChild(tip);
}

$('extract').onclick = () => {
  const selRows = textarea('行选择器，例如 .item（XPath 用 xpath: 前缀）', '');
  const selFields = textarea('每行 名称=选择器[@属性]，例如\n标题=.title\n链接=a@href\n正文=@html\nXPath 用 xpath: 前缀', '');
  const out = document.createElement('div');

  const run = async () => {
    const r = await ipcRenderer.invoke('cap:extract', { rows: selRows.value, fields: selFields.value });
    if (!r || !r.ok) { toast('提取失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    lastExtract = r.rows;
    paintRowPreview(out, r.rows, `共 ${r.count} 行${r.truncated ? '（已截断到 5000）' : ''}${r.count > 20 ? '，预览前 20 行' : ''}`);
    $('status').textContent = `提取 ${r.count} 行`;
  };

  const pageN = document.createElement('input');
  pageN.type = 'number'; pageN.className = 'num'; pageN.min = 1; pageN.max = 100; pageN.value = 3;
  pageN.title = '总页数';
  const pageD = document.createElement('input');
  pageD.type = 'number'; pageD.className = 'num'; pageD.min = 200; pageD.max = 60000; pageD.step = 100;
  pageD.value = 2000; pageD.title = '每页间隔 ms'; pageD.style.width = '72px';
  const taskUrl = document.createElement('input');
  taskUrl.placeholder = '任务起始 URL（留空 = 当前页）';
  taskUrl.style.flex = '1';

  // 翻页 + 提取合并：每页跑一遍当前选择器，最后按行合并（行带 _page 标记）
  const runTask = async () => {
    setAutoBusy(true);
    try {
      const r = await ipcRenderer.invoke('cap:taskRun', {
        url: taskUrl.value.trim(), rows: selRows.value, fields: selFields.value,
        pages: +pageN.value, delay: +pageD.value,
      });
      if (!r || !r.ok) return toast('任务失败：' + ((r && r.error) || '未知错误'), 'err');
      lastExtract = r.rows;
      paintRowPreview(out, r.rows,
        `${REASON[r.reason] || r.reason}：合并 ${r.rows.length} 行 · ${r.pages} 页${r.dup ? ` · 重复 ${r.dup} 行` : ''}${r.rows.length > 20 ? '，预览前 20 行' : ''}`);
      $('status').textContent = `翻页提取 ${r.rows.length} 行 / ${r.pages} 页`;
      return undefined;
    } finally {
      setAutoBusy(false);
    }
  };

  const taskBar = document.createElement('div');
  taskBar.className = 'dbar';
  for (const [lbl, node] of [['页数', pageN], ['间隔', pageD]]) {
    const s = document.createElement('span');
    s.className = 'lbl';
    s.textContent = lbl;
    taskBar.appendChild(s);
    taskBar.appendChild(node);
  }
  taskBar.appendChild(taskUrl);

  // 任务预设：名称 + 保存/删除（落在 settings.tasks，最多 20 条）
  const presetSel = document.createElement('select');
  presetSel.style.flex = '1';
  const presetName = document.createElement('input');
  presetName.placeholder = '预设名称';
  const paintPresets = () => {
    presetSel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = taskPresets.length ? '预设…' : '（暂无预设）';
    presetSel.appendChild(none);
    for (const t of taskPresets) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      presetSel.appendChild(o);
    }
  };
  paintPresets();
  presetSel.onchange = () => {
    const t = taskPresets.find((x) => x.name === presetSel.value);
    if (!t) return;
    selRows.value = t.rows;
    selFields.value = t.fields;
    pageN.value = t.pages;
    pageD.value = t.delay;
    taskUrl.value = t.url || '';
    presetName.value = t.name;
  };
  const savePreset = async () => {
    const name = presetName.value.trim();
    if (!name) return toast('请填写预设名称', 'warn');
    const next = taskPresets.filter((t) => t.name !== name);
    next.push({ name, url: taskUrl.value.trim(), rows: selRows.value, fields: selFields.value, pages: +pageN.value, delay: +pageD.value });
    const r = await ipcRenderer.invoke('cap:cfg', { key: 'tasks', value: next });
    if (!r || !r.ok) return toast('保存预设失败：' + ((r && r.error) || '未知错误'), 'err');
    const back = await ipcRenderer.invoke('cap:cfgAll');
    taskPresets = Array.isArray(back && back.tasks) ? back.tasks : [];
    paintPresets();
    presetSel.value = name;
    return toast('已保存预设：' + name, 'ok');
  };
  const delPreset = async () => {
    const name = presetSel.value;
    if (!name) return toast('请先选择预设', 'warn');
    const r = await ipcRenderer.invoke('cap:cfg', { key: 'tasks', value: taskPresets.filter((t) => t.name !== name) });
    if (!r || !r.ok) return toast('删除预设失败：' + ((r && r.error) || '未知错误'), 'err');
    const back = await ipcRenderer.invoke('cap:cfgAll');
    taskPresets = Array.isArray(back && back.tasks) ? back.tasks : [];
    paintPresets();
    presetSel.value = '';
    return toast('已删除预设：' + name, 'ok');
  };

  const presetBar = document.createElement('div');
  presetBar.className = 'dbar';
  presetBar.appendChild(presetSel);
  presetBar.appendChild(presetName);
  for (const [label, fn] of [['保存预设', savePreset], ['删除预设', delPreset]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    presetBar.appendChild(b);
  }

  const pickBar = document.createElement('div');
  pickBar.className = 'dbar';
  const bRow = pickButton('extract');
  bRow.textContent = '拾取（行选择器）';
  const bField = pickButton('field');
  bField.textContent = '拾取到字段';
  pickBar.appendChild(bRow);
  pickBar.appendChild(bField);

  openModal('CSS / XPath 选择器提取', [
    pickBar,
    labelled('行选择器（每条记录的容器）', selRows),
    labelled('字段（每行 名称=选择器[@属性]，XPath 加 xpath: 前缀）', selFields),
    taskBar,
    presetBar,
    out,
  ], [
    { id: 'extractRun', label: '提取', primary: true, onClick: run },
    { id: 'extractTask', label: '翻页+提取', onClick: runTask },
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
  // 预设列表异步补齐：模态必须同步打开（快捷键 / 自检依赖 openModal 立即生效）
  ipcRenderer.invoke('cap:cfgAll').then((c) => {
    taskPresets = Array.isArray(c && c.tasks) ? c.tasks : [];
    paintPresets();
  });
};

/* ---- 页面清单 / 表格 CSV ---- */
$('harvest').onclick = async () => {
  const hv = await ipcRenderer.invoke('cap:harvest');
  if (!hv || !hv.ok) return toast('提取失败：' + ((hv && hv.error) || '未知错误'), 'err');
  const stat = document.createElement('div');
  const cap = (n, total) => `${n}${hv.totals && hv.totals[total] > n ? `/${hv.totals[total]}（已截断）` : ''}`;
  stat.textContent = `链接 ${cap(hv.links.length, 'links')} · 图片 ${cap(hv.images.length, 'images')} · 表单 ${cap(hv.forms.length, 'forms')} · 表格 ${cap(hv.tables.length, 'tables')}`;
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
  const byType = dataTable(['类型', '条数', '大小'], s.byType.map((d) => ({ 类型: d.type, 条数: d.count, 大小: humanSize(d.bytes) })));
  const byStatus = dataTable(['状态', '条数', '大小'], s.byStatus.map((d) => ({ 状态: d.cls, 条数: d.count, 大小: humanSize(d.bytes) })));
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

/* ---- 抓包快照对比（两次快照的差异：新增 / 消失 / 变化）---- */
async function openSnaps() {
  const first = await ipcRenderer.invoke('cap:snapList');
  const head = document.createElement('div');
  head.className = 'lbl';
  const paintHead = (snaps) => {
    head.textContent = snaps && snaps.length
      ? snaps.map((s, i) => `#${i + 1} ${new Date(s.at).toLocaleTimeString()} · ${s.count} 条 · ${s.url || ''}`).join('\n')
      : '还没有快照（最多留最近 2 个，只在本次运行内存里）';
  };
  paintHead(first && first.snaps);
  const out = document.createElement('div');
  openModal('抓包快照对比', [head, out], [
    { id: 'snapSave', label: '保存当前', primary: true, onClick: async () => {
      const r = await ipcRenderer.invoke('cap:snapSave');
      if (!r || !r.ok) return toast('保存快照失败', 'err');
      toast(`已保存快照（${r.count} 条）`, 'ok');
      const l = await ipcRenderer.invoke('cap:snapList');
      paintHead(l && l.snaps);
      return undefined;
    } },
    { id: 'snapDiff', label: '与上一个对比', onClick: async () => {
      const d = await ipcRenderer.invoke('cap:snapDiff');
      out.innerHTML = '';
      if (!d || !d.ok) { toast('对比失败：' + ((d && d.error) || '未知错误'), 'warn'); return undefined; }
      const sum = document.createElement('div');
      sum.className = 'lbl';
      sum.textContent = `新增 ${d.addedN} · 消失 ${d.removedN} · 变化 ${d.changedN}（${new Date(d.from).toLocaleTimeString()} → ${new Date(d.to).toLocaleTimeString()}）`;
      out.appendChild(sum);
      const common = (x) => ({ 键: x.k, 状态: x.status, 大小: humanSize(x.size), 耗时: x.ms == null ? '-' : `${x.ms}ms`, 条数: x.n > 1 ? `${x.n}` : '' });
      out.appendChild(sectionTitle(`新增（列 ${d.added.length} / 共 ${d.addedN}）`));
      out.appendChild(dataTable(['键', '状态', '大小', '耗时', '条数'], d.added.map(common)));
      out.appendChild(sectionTitle(`消失（列 ${d.removed.length} / 共 ${d.removedN}）`));
      out.appendChild(dataTable(['键', '状态', '大小', '耗时', '条数'], d.removed.map(common)));
      out.appendChild(sectionTitle(`变化（列 ${d.changed.length} / 共 ${d.changedN}）`));
      out.appendChild(dataTable(['键', '原 → 新'], d.changed.map((x) => ({
        键: x.k,
        '原 → 新': `状态 ${x.from.status}→${x.to.status} · 耗时 ${x.from.ms}→${x.to.ms}ms · 大小 ${x.from.size}→${x.to.size}`,
      }))));
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
}
$('snapBtn').onclick = openSnaps;

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
  if (it.k === 'action') return `${head} ${acts[it.a] || it.a} ${it.label || it.sel || ''}${it.text ? `「${String(it.text).slice(0, 24)}」` : ''}`;
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
    if (it.sel) {                                  // 写爬虫主路径：点一下就把该元素的选择器拿走
      div.title = [it.label || it.sel, it.xpath ? `XPath: ${it.xpath}` : '', `点击复制选择器：${it.sel}`].filter(Boolean).join('\n');
      div.style.cursor = 'pointer';
      div.onclick = () => { clipboard.writeText(it.sel); toast('已复制选择器：' + it.sel, 'ok', 3000); };
    }
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
  const withNav = document.createElement('input');
  withNav.type = 'checkbox';                                   // 默认不回放导航：跳转由点击/提交自然发生
  const wrapNav = document.createElement('label');
  wrapNav.className = 'lbl';
  wrapNav.appendChild(withNav);
  wrapNav.appendChild(document.createTextNode(' 重放导航（跳转页面）'));
  const out = document.createElement('pre');
  out.textContent = '尚未开始';
  const progress = (_e, d) => { out.textContent = `进度 ${d.done}/${d.total} · 失败 ${d.failed}${d.last ? ' · ' + d.last : ''}`; };

  openModal('重放录制', [labelled('倍速', speed), wrap, wrapNav, out], [
    { id: 'recReplayStart', label: '开始', primary: true, onClick: async () => {
      out.textContent = '重放中…';
      const btn = $('recReplayStart');
      btn.disabled = true;
      ipcRenderer.on('cap:replayProgress', progress);
      let r = null;
      try {
        r = await ipcRenderer.invoke('cap:recReplay', { file, speed: Number(speed.value), stopOnError: stopOnErr.checked, withNav: withNav.checked });
      } catch (e) {
        r = { ok: false, error: e.message };
      } finally {
        ipcRenderer.removeListener('cap:replayProgress', progress);   // 失败也要摘：残留监听会写到已关闭弹窗的节点上
        btn.disabled = false;
      }
      if (!r || !r.ok) {
        out.textContent = '重放失败：' + ((r && r.error) || '未知错误');
        return toast('重放失败：' + ((r && r.error) || '未知错误'), 'err');
      }
      const fails = (r.failed || []).slice(0, 10).map((f) => `#${f.n} ${f.a} ${f.sel || ''} → ${f.reason}`).join('\n');
      out.textContent = `完成 ${r.done}/${r.total}${r.stopped ? '（已中止）' : ''}`
        + `${r.skipped ? `\n跳过导航 ${r.skipped} 步（未勾选「重放导航」）` : ''}`
        + `\n失败 ${(r.failed || []).length} 条\n${fails}`;
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

  const usage = document.createElement('div');
  usage.className = 'lbl';
  const sum = list.reduce((n, r) => n + (r.bytes || r.size || 0), 0);
  usage.textContent = `目录占用 ${humanSize(sum)}（${list.length} 条）${sum > REC_WARN_BYTES ? ' · 超过 1GB，建议删除旧录制' : ''}`;

  openModal('录制历史', [labelled('录制文件（新的在前）', sel), usage, labelled('过滤', search), view], [
    { id: 'recReplay', label: '重放', primary: true, onClick: () => { openReplayRecording(sel.value); return undefined; } },
    { id: 'recScript', label: '导出回放脚本', onClick: async () => {
      const r = await ipcRenderer.invoke('cap:recScript', { file: sel.value });
      if (r && r.ok) toast('已保存：' + r.file, 'ok', 7000);
      else if (r && r.canceled) $('status').textContent = '已取消保存';
      else toast('导出失败：' + ((r && r.error) || '未知错误'), 'err');
      return undefined;
    } },
    { id: 'recDelete', label: '删除此条', onClick: () => {
      const r = list.find((x) => x.file === sel.value);
      if (!r) return toast('录制不存在', 'err');
      const info = document.createElement('div');
      info.className = 'lbl';
      info.textContent = `将删除 ${r.base}：.jsonl${r.md ? ' + .md' : ''}${r.shots ? ` + ${r.shots} 张点击截图` : ''}（共 ${humanSize(r.bytes || r.size)}），不可恢复。`;
      openModal('删除录制', [info], [
        { id: 'recDeleteConfirm', label: '确认删除', primary: true, onClick: async () => {
          const d = await ipcRenderer.invoke('cap:recDelete', { file: r.file });
          if (!d || !d.ok) return toast('删除失败：' + ((d && d.error) || '未知错误'), 'err');
          toast(`已删除 ${r.base}（${d.removed} 个文件）`, 'ok', 4000);
          openRecHistory();
          return undefined;
        } },
        { label: '取消', onClick: () => openRecHistory() },
      ]);
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
$('wsClear').onclick = async () => {
  const r = await ipcRenderer.invoke('cap:wsClear');
  if (!r || !r.ok) return toast('清空失败：' + ((r && r.error) || '未知错误'), 'err');
  el.ws.innerHTML = '';
  $('nWs').textContent = '0';
  $('wsNote').textContent = '已清空当前标签的帧（主进程同步清空）';
};

/* ---- 响应体存盘 ---- */
$('saveBodies').onclick = () => ipcRenderer.invoke('cap:saveBodies').then((r) => {
  if (!r) return;
  if (r.canceled) return void ($('status').textContent = '已取消');
  if (!r.ok) return toast('存盘失败：' + r.error, 'err');
  toast(`已写入 ${r.written} 个文件 → ${r.dir}（跳过 ${r.skipped} 条无响应体）`, 'ok', 7000);
});

/* ---- 离线包：当前页 + 静态资源镜像成可离线打开的目录 ---- */
function openBundle() {
  const dir = document.createElement('input');
  dir.placeholder = '导出目录（留空 = 弹目录选择框）';
  dir.style.flex = '1';
  const pick = document.createElement('button');
  pick.textContent = '选择…';
  pick.onclick = async () => {
    const r = await ipcRenderer.invoke('cap:pickDir');
    if (r && r.ok) dir.value = r.dir;
  };
  const dirRow = document.createElement('div');
  dirRow.style.display = 'flex';
  dirRow.style.gap = '6px';
  dirRow.appendChild(dir);
  dirRow.appendChild(pick);
  const mkToggle = (text, id) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = true;
    const w = document.createElement('label');
    w.className = 'lbl';
    w.style.display = 'block';
    w.appendChild(cb);
    w.appendChild(document.createTextNode(' ' + text));
    return { cb, w };
  };
  const net = mkToggle('附 network.json（本次抓包的请求头 / 请求体 / 响应头，供复现签名请求）', 'bundleNet');
  const hint = mkToggle('附 hints.json（参数名 / 值在已存 JS 里的定位，找加密入口）', 'bundleHints');
  const out = document.createElement('div');
  out.className = 'lbl';
  out.id = 'bundleOut';
  const openDir = document.createElement('button');
  openDir.id = 'bundleOpenDir';
  openDir.textContent = '打开目录';
  openDir.style.display = 'none';
  let exported = '';
  openDir.onclick = () => ipcRenderer.invoke('cap:openDir', exported);
  openModal('离线包（当前页 + 静态资源，供离线复现）', [
    labelled('导出目录', dirRow),
    net.w,
    hint.w,
    out,
    openDir,
  ], [
    { id: 'bundleRun', label: '导出离线包', primary: true, onClick: async () => {
      const btn = $('bundleRun');
      btn.disabled = true;
      out.textContent = '导出中…';
      try {
        const r = await ipcRenderer.invoke('cap:bundleSave', {
          dir: dir.value.trim(), includeNetwork: net.cb.checked, includeHints: hint.cb.checked,
        });
        if (!r) return toast('离线包导出失败：无响应', 'err');
        if (r.canceled) return void ($('status').textContent = '离线包导出已取消');
        if (!r.ok) return toast('离线包导出失败：' + (r.error || '未知错误'), 'err');
        exported = r.dir;
        openDir.style.display = '';
        dir.value = r.dir;
        out.textContent = `已写入 ${r.files} 个文件 / ${r.bytes} 字节 → ${r.dir}`
          + (r.missing.length ? `；缺失 ${r.missing.length} 项（见 manifest.json）` : '')
          + `｜耗时 ${r.ms}ms；双击入口 ${r.entry} 即可离线打开`;
        $('status').textContent = `离线包已导出 → ${r.dir}（入口 ${r.entry}）`;
        toast(`离线包已导出：${r.files} 个文件`, 'ok', 7000);
      } catch (e) {
        toast('离线包导出失败：' + e.message, 'err');
      } finally {
        btn.disabled = false;
      }
      return undefined;
    } },
    { label: '关闭', onClick: closeModal },
  ]);
  return undefined;
}
$('bundleBtn').onclick = openBundle;

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
  ['recordings', '录制记录', '录制目录里的 .jsonl / .md / 点击截图（保留目录本身）'],
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
      const btn = $('wipeRun');
      btn.disabled = true;                                    // 清理不可撤销：禁用按钮防连点触发两次
      try {
        const r = await ipcRenderer.invoke('cap:wipe', { targets });
        if (!r) return toast('清理失败：主进程没有返回结果', 'err');
        const tail = (r.failed || []).length ? `；失败 ${r.failed.join('；')}` : '';
        toast(`已清理：${(r.done || []).join('、')}${tail}`, r.ok ? 'ok' : 'warn', 6000);
      } catch (e) {
        toast('清理失败：' + e.message, 'err');
      } finally {
        btn.disabled = false;
      }
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
    clearDetail();
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
ipcRenderer.on('cap:perm', (_e, d) => { if (d && d.perm) toast(`已拒绝页面权限请求：${d.perm}`, 'warn', 6000); });
ipcRenderer.on('cap:gpu', (_e, g) => document.body.classList.toggle('soft', !!(g && g.softwareMode)));

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
  bodySearchTimer = setTimeout(runBodySearch, 300);
}

// 命中集合的重算入口：过滤框变化（300ms 防抖）与新记录到达（1s 合并）都走这里
async function runBodySearch() {
  if (!bodyQuery) return;
  const r = await ipcRenderer.invoke('cap:searchBody', bodyQuery);
  if (!r || !r.ok) {
    bodyQuery = '';                                        // 失败即放弃该关键词，与原实现一致
    bodyHits = null;
    updateListNote();
    return toast('响应体搜索失败：' + ((r && r.error) || '未知错误'), 'err');
  }
  bodyHits = new Set(r.ids);
  updateListNote();
  reapplyFilter();
}

// 命中集只在单个标签内有效：切标签 / 清空后作废，并按当前关键词对新标签重算
function resetBodySearch() {
  bodyHits = null;
  if (bodyQuery) runBodySearch();
  updateListNote();
}

let bodyRefreshTimer = null;
function scheduleBodyRefresh() {                            // 新记录到达时 1s 合并重算一次
  if (!bodyQuery || bodyRefreshTimer) return;
  bodyRefreshTimer = setTimeout(() => { bodyRefreshTimer = null; runBodySearch(); }, 1000);
}

el.filter.addEventListener('input', () => { syncBodySearch(); reapplyFilter(); });
el.type.addEventListener('change', reapplyFilter);
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
  if (bodyQuery && (b && (b.records || []).length)) scheduleBodyRefresh();   // body: 命中随新记录刷新
}
ipcRenderer.on('cap:batch', (_e, b) => applyBatch(b));
ipcRenderer.on('cap:status', (_e, s) => { $('status').textContent = s; });
ipcRenderer.on('cap:download', (_e, d) => {
  if (!d) return;
  if (d.state === 'start') {
    $('status').textContent = `下载中：${d.name}`;
    toast(`开始下载：${d.name}`, 'info', 4000);
    return;
  }
  if (d.state === 'done') {
    $('status').textContent = `已下载：${d.name}`;
    toast(`下载完成：${d.file || d.name}`, 'ok', 7000);
    return;
  }
  toast(`下载失败：${d.name}（${d.status}）`, 'err', 7000);
  $('status').textContent = `下载失败：${d.name}`;
});
ipcRenderer.on('cap:navigated', (_e, d) => {
  $('url').value = d.url;
  $('back').disabled = !d.canGoBack;
  $('fwd').disabled = !d.canGoForward;
});

$('tabNew').onclick = () => ipcRenderer.invoke('cap:tabNew');
$('listNew').onclick = () => {
  scrollListToBottom();
  listNew = 0;
  updateListNew();
};
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
ipcRenderer.on('cap:tabs', (_e, d) => renderTabs(d && d.tabs, d && d.activeTabId));
ipcRenderer.on('cap:tabChanged', async () => { clearDetail(); refreshActiveList(await ipcRenderer.invoke('cap:list')); });

/* -------------------------------------------------------------- 初始化 */

let toggleState = true;
// 设置控件回填（启动时与「导入设置」成功后共用一份）：导入后控件要跟磁盘走，不能停在旧值
function fillCfgControls(cfgAll) {
  if (!cfgAll) return;
  $('blockMode').value = cfgAll.blockMode;
  $('blockKeywords').value = cfgAll.blockKeywords;
  $('recordOnly').checked = !!cfgAll.recordOnly;
  $('throttle').value = cfgAll.throttle;
  $('headers').value = cfgAll.headers;
  $('proxy').value = cfgAll.proxy;
  $('colSet').value = cfgAll.colSet || 'd';
  colMode = $('colSet').value;
  $('sortBy').value = cfgAll.sortBy || 'time';
  refilter();
  $('reqDelay').value = Number.isFinite(Number(cfgAll.reqDelay)) ? Number(cfgAll.reqDelay) : 0;
  $('recShots').checked = !!cfgAll.recShots;
  if (cfgAll.ua) {
    const preset = Object.keys(UA_PRESETS).find((k) => UA_PRESETS[k] === cfgAll.ua);
    if (preset) $('uaSel').value = preset;
    else { $('uaSel').value = 'custom'; $('uaCustom').hidden = false; $('uaCustom').value = cfgAll.ua; }
  }
}

/* ---------------------------------------------- 工具栏高度上报（视图跟着下移） */
// 工具栏随窗口/面板宽度换行，只有本进程知道换行后的真实高度：量出来回传，主进程据此摆放原生视图。
let lastToolbarH = 0;
const reportToolbarH = () => {
  const h = Math.ceil($('tabstrip').getBoundingClientRect().bottom);
  if (h < 80 || h === lastToolbarH) return;
  lastToolbarH = h;
  ipcRenderer.invoke('cap:toolbarH', h);
};
const toolbarRo = new ResizeObserver(reportToolbarH);
toolbarRo.observe($('toolbar2'));
toolbarRo.observe($('toolbar3'));
window.addEventListener('resize', reportToolbarH);

(async () => {
  const d = await ipcRenderer.invoke('cap:list');
  // 无显卡 / 软件渲染：关掉全屏模糊与阴影这类合成开销（老机器上最贵的一项）
  ipcRenderer.invoke('cap:gpuStatus').then((g) => {
    if (g && g.softwareMode) document.body.classList.add('soft');
  }).catch(() => {});
  // 按持久化宽度摆放面板（主进程已按同一数值摆放原生视图；不要再回传，否则会反向覆盖）
  applyPanelWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, d.panelWidth || 520)));
  refreshActiveList(d);

  fillCfgControls(await ipcRenderer.invoke('cap:cfgAll'));

  // 上次会话可恢复 → 横幅提示
  const si = await ipcRenderer.invoke('cap:sessionInfo');
  if (si && si.exists) {
    const when = si.savedAt ? new Date(si.savedAt).toLocaleString() : '未知时间';
    showBanner(`发现上次会话（${si.count} 条记录，保存于 ${when}）`, [
      { id: 'restoreSession', label: '恢复', primary: true },
      { id: 'discardSession', label: '忽略' },
    ]);
  }
  reportToolbarH();
})();
