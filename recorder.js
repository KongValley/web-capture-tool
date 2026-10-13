'use strict';
/*
 * 会话录制：把页面交互（点击/输入/变更/提交/按键/滚动）+ 网络请求与响应 + 导航 + WebSocket 帧
 * 按时间顺序写成 JSONL（每行一个 JSON 对象），停止时生成同名 .md 时间线摘要。
 * 默认落盘目录：<userData>/recordings/
 *
 * 依赖方向：本模块只 require state/logger/settings/format。
 * capture.js 反过来依赖本模块，所以这里禁止 require capture.js / main.js（避免循环）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { state, send } = require('./state');
const logger = require('./logger');
const settings = require('./settings');
const format = require('./format');

const VERSION = 1;
const DIRNAME = 'recordings';
const BINDING = '__wctRecord';                    // 页面 → 主进程的 CDP binding 名
const MAX_ENTRIES = 100000;                       // 单次录制条数上限，到达即自动停止
const MAX_BODY_WRITE = 256 * 1024;                // 单条文本响应体写入上限
const MAX_TOTAL_BODY_WRITE = 32 * 1024 * 1024;    // 单次录制响应体总量上限
const MAX_POST_WRITE = 8 * 1024;                  // 请求体写入上限
const MAX_WS_WRITE = 4 * 1024;                    // 单帧 WebSocket payload 上限
const MAX_SHOTS = 300;                            // 单次录制截图张数上限
const FLUSH_MS = 250;                             // 缓冲刷盘间隔
const FLUSH_BYTES = 64 * 1024;                    // 缓冲达到该体积立即刷盘
const MD_MAX_LINES = 500;                         // 摘要里最多输出的时间线行数
const MD_KEEP = 1000;                             // 为生成摘要保留的精简条目数（含 500 行之后紧随的响应）
const AFTER_WINDOW_MS = 2000;                     // 交互 → 请求的关联时间窗

let overrideDir = null;
let lastFilePath = '';
let lastInfo = { file: '', mdFile: '' };          // 最近一次录制的产物路径（面板「打开摘要」用）
let rec = null;                                   // 当前（或最近一次）录制
const armed = new Map();                          // wc.id -> { identifier, wc }

/* -------------------------------------------------------------- 路径与状态 */

function dirPath() {
  return overrideDir || path.join(app.getPath('userData'), DIRNAME);
}

// 自检改道：换目录并清空（必须在 start 之前调用）
function useDir(p) {
  overrideDir = p;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 没有旧目录 */ }
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { logger.log('rec', `创建录制目录失败：${e.message}`); }
  return p;
}

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

function dt(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function fmtDur(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

function isRecording() { return !!(rec && rec.active); }
function lastFile() { return lastFilePath; }

function status() {
  if (!rec) return { active: false, startedAt: 0, entries: 0, file: '', mdFile: '', counts: {} };
  return {
    active: !!rec.active, startedAt: rec.startedAt, entries: rec.n,
    file: rec.file, mdFile: rec.mdFile, counts: Object.assign({}, rec.counts),
  };
}

/* -------------------------------------------------------------- 写盘 */

let writing = false;      // 是否已有一次 appendFile 在飞（全局只允许一个，保证写入顺序）
let writingFile = '';     // 在飞写入的目标文件（跨文件的同步写不会破坏顺序）

// 缓冲刷盘：交给 fs.promises.appendFile 串行写，主线程不再被同步 IO 阻塞。
// 代价：崩溃最多丢最后 FLUSH_MS 里的事件；stop/flushSync 走 drainSync 同步兜底。
function flush() {
  if (!rec || !rec.pending.length) return true;
  if (writing) return false;                                  // 有写在飞：留在 pending 里，等它回来一起写
  const text = rec.pending.join('\n') + '\n';
  rec.pending.length = 0;
  rec.pendingBytes = 0;
  writing = true;
  writingFile = rec.file;
  fs.promises.appendFile(writingFile, text)
    .catch((e) => logger.log('rec', `写入失败：${e.message}`))
    .finally(() => { writing = false; writingFile = ''; flush(); });   // 写完立刻把剩下的排空（顺序不乱）
  return true;
}

// 同步把残留写完（stop / 退出 / 生成摘要前）；
// 只有「在飞的那次写的就是同一个文件」时才让路，否则同步写不会插队。
// force=true 忽略让路规则——只给「新建录制」用：那时文件是新的，不可能有在飞写。
function drainSync(force = false) {
  if (!rec || !rec.pending.length) return true;
  if (!force && writing && writingFile === rec.file) return false;
  try {
    fs.appendFileSync(rec.file, rec.pending.join('\n') + '\n');
    rec.pending.length = 0;
    rec.pendingBytes = 0;
    return true;
  } catch (e) {
    logger.log('rec', `写入失败：${e.message}`);
    return false;
  }
}

// 面板「停止录制」用：等异步写入排空再返回，调用方拿到的一定是完整文件
async function stopWhenIdle(reason = 'manual') {
  const r = stop(reason);
  const t0 = Date.now();
  while (writing && Date.now() - t0 < 1000) await new Promise((res) => setTimeout(res, 20));
  drainSync();
  return r;
}

// 每条记录的唯一入口：编号 → 计数 → 入缓冲 → 必要时刷盘
function push(entry) {
  if (!rec || !rec.active) return;
  entry.n = ++rec.n;
  if (!entry.t) entry.t = Date.now();
  rec.counts[entry.k] = (rec.counts[entry.k] || 0) + 1;
  const line = JSON.stringify(entry);
  rec.pending.push(line);
  rec.pendingBytes += line.length;
  const reduced = reduceEntry(entry);
  if (reduced) {
    if (rec.md.length < MD_KEEP) rec.md.push(reduced);
    queuePanelItem(reduced);
  }
  if (!rec.stopping && rec.n >= MAX_ENTRIES) {
    flush();
    stop('limit');
    send('cap:rec', { active: false, reason: 'limit' });
    return;
  }
  if (rec.pending.length > 200 || rec.pendingBytes > FLUSH_BYTES) flush();
}

function note(text) {
  push({ k: 'note', text: String(text == null ? '' : text).slice(0, 300) });
}

// 摘要与面板共用的一份精简副本；不需要的 kind 返回 null
function reduceEntry(entry) {
  const k = entry.k;
  if (k === 'body' || k === 'manifest' || k === 'summary') return null;
  const copy = { k, t: entry.t, n: entry.n, tab: entry.tab };
  if (k === 'action') {
    copy.a = entry.a; copy.sel = entry.sel; copy.text = entry.text;
    copy.value = entry.value; copy.key = entry.key; copy.x = entry.x; copy.y = entry.y;
  } else if (k === 'req') {
    copy.id = entry.id; copy.method = entry.method; copy.url = entry.url;
  } else if (k === 'res') {
    copy.id = entry.id; copy.status = entry.status; copy.ms = entry.ms; copy.size = entry.size; copy.url = entry.url;
  } else if (k === 'nav' || k === 'page') {
    copy.url = entry.url; copy.kind = entry.kind; copy.title = entry.title;
  } else if (k === 'ws') {
    copy.a = entry.a; copy.payload = entry.payload;
  } else if (k === 'shot') {
    copy.file = entry.file;
  } else if (k === 'note') {
    copy.text = entry.text;
  }
  return copy;
}

// 录制中把每条记录精简后批量推给面板（200ms 合并，最多 50 条/批）
let panelQueue = [];
let panelTimer = null;

function queuePanelItem(item) {
  if (!rec || !rec.active) return;
  if (!['action', 'req', 'res', 'nav', 'page'].includes(item.k)) return;
  panelQueue.push(item);
  if (panelTimer) return;
  panelTimer = setTimeout(() => {
    panelTimer = null;
    const batch = panelQueue.splice(0, 50);
    if (batch.length) send('cap:recItems', batch);
  }, 200);
}

function clearPanelQueue() {
  if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
  panelQueue.length = 0;
}

/* -------------------------------------------------------------- 启停 */

async function start(opts = {}) {
  if (rec && rec.active) return { ok: false, error: '已在录制中' };
  const dir = dirPath();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  const now = Date.now();
  let base = `rec-${stamp()}`;
  // 同一秒内连续开始两次录制时避免落到同一个文件（否则第二次会追加进上一次的数据）
  for (let i = 2; fs.existsSync(path.join(dir, `${base}.jsonl`)); i++) base = `rec-${stamp()}-${i}`;
  rec = {
    active: true, startedAt: now, base,
    file: path.join(dir, `${base}.jsonl`),
    mdFile: path.join(dir, `${base}.md`),
    n: 0, counts: {}, actCounts: { click: 0, input: 0, change: 0, submit: 0, keydown: 0, scroll: 0 },
    bodyBytes: 0, bodyNoteDone: false,
    shots: opts.shots === undefined ? !!settings.values.recShots : !!opts.shots,
    shotCount: 0, shotNoteDone: false,
    lastAction: null, timer: null, pending: [], pendingBytes: 0, md: [],
    prevEnabled: state.enabled, stopping: false,
  };
  lastFilePath = rec.file;
  lastInfo = { file: rec.file, mdFile: rec.mdFile };

  const view = state.view && !state.view.webContents.isDestroyed() ? state.view : null;
  const bounds = view ? view.getBounds() : { width: 0, height: 0 };
  push({
    k: 'manifest', t: now, v: VERSION,
    startedAt: new Date(now).toISOString(),
    tool: 'web-capture-tool/1.0.0',
    ua: view ? view.webContents.getUserAgent() : (state.defaultUA || ''),
    viewport: { w: bounds.width, h: bounds.height },
    url: view ? view.webContents.getURL() : '',
    title: view ? view.webContents.getTitle() : '',
    shots: rec.shots,
    settings: {
      reqDelay: settings.values.reqDelay, throttle: settings.values.throttle, ua: settings.values.ua,
      proxy: settings.values.proxy, blockMode: settings.values.blockMode, blockKeywords: settings.values.blockKeywords,
      recordOnly: settings.values.recordOnly, ignoreCertErrors: settings.values.ignoreCertErrors,
    },
  });

  // 录制期间强制打开抓取（交互不依赖它，网络事件依赖），stop 时恢复
  if (!state.enabled) {
    state.enabled = true;
    for (const t of state.tabs) t.enabled = true;
    send('cap:status', '抓取中');
  }
  // 给已有标签挂上注入：必须等绑定就绪再返回，否则「开始录制」后立刻的点击会漏掉
  const armOne = (wc) => Promise.race([
    arm(wc),
    new Promise((r) => setTimeout(() => r(false), 2000)),   // 兜底：不让 start 卡在异常标签上
  ]).catch(() => false);
  await Promise.all(state.tabs.map((t) => armOne(t.wc)));
  rec.timer = setInterval(flush, FLUSH_MS);
  // 清单同步落盘：此刻 pending 里只有 manifest，面板/自检会立刻读文件（force 绕过同文件让路）
  drainSync(true);
  return { ok: true, file: rec.file, mdFile: rec.mdFile, startedAt: now };
}

function stop(reason = 'manual') {
  if (!rec || !rec.active) return { ok: false, error: '当前没有录制' };
  const r = rec;
  r.stopping = true;
  r.reason = reason;
  const now = Date.now();
  const durationMs = now - r.startedAt;
  flush();
  drainSync();                                  // 摘要前把已有缓冲落盘（有写在飞时由它自己排空，顺序不乱）
  push({
    k: 'summary', stoppedAt: new Date(now).toISOString(), reason,
    entries: r.n + 1, durationMs, counts: Object.assign({}, r.counts),
  });
  flush();
  drainSync();
  r.active = false;
  r.stopping = false;
  clearPanelQueue();
  if (r.timer) { clearInterval(r.timer); r.timer = null; }
  for (const item of [...armed.values()]) disarm(item.wc).catch(() => {});
  if (!r.prevEnabled) {
    state.enabled = false;
    for (const t of state.tabs) t.enabled = false;
    send('cap:status', '已暂停');
  }
  try {
    fs.writeFileSync(r.mdFile, buildMarkdown(r), 'utf8');
  } catch (e) {
    logger.log('rec', `摘要写入失败：${e.message}`);
  }
  lastFilePath = r.file;
  lastInfo = { file: r.file, mdFile: r.mdFile };
  return { ok: true, file: r.file, mdFile: r.mdFile, entries: r.n, durationMs, counts: Object.assign({}, r.counts), reason };
}

// 退出路径：同步刷盘 + 补一条 summary + 生成 .md（关窗也留下可读摘要）
function flushSync() {
  if (!rec) return { ok: true };
  const r = rec;
  if (r.active) {
    r.stopping = true;
    r.reason = 'quit';
    const now = Date.now();
    flush();
    drainSync();
    push({ k: 'summary', stoppedAt: new Date(now).toISOString(), reason: 'quit', entries: r.n + 1, durationMs: now - r.startedAt, counts: Object.assign({}, r.counts) });
    flush();
    drainSync();
    r.active = false;
    r.stopping = false;
    try {
      fs.writeFileSync(r.mdFile, buildMarkdown(r), 'utf8');
    } catch (e) {
      logger.log('rec', `摘要写入失败：${e.message}`);
    }
  }
  clearPanelQueue();
  if (r.timer) { clearInterval(r.timer); r.timer = null; }
  lastFilePath = r.file;
  lastInfo = { file: r.file, mdFile: r.mdFile };
  return { ok: true };
}

/* -------------------------------------------------------------- 摘要 */

function humanSize(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

function shortUrl(u) {
  const s = String(u || '');
  try {
    const x = new URL(s);
    return x.pathname + (x.search || '') + (x.hash || '');
  } catch (e) { return s; }
}

function buildMarkdown(r) {
  const t0 = r.startedAt;
  const tm = (t) => {
    const s = Math.max(0, (t || t0) - t0);
    const mm = String(Math.floor(s / 60000)).padStart(2, '0');
    const ss = String(Math.floor((s % 60000) / 1000)).padStart(2, '0');
    const ms = String(s % 1000).padStart(3, '0');
    return `[${mm}:${ss}.${ms}]`;
  };
  const verbs = { click: '点击', input: '输入', change: '变更', submit: '提交', keydown: '按键', scroll: '滚动' };
  const reasonText = { manual: '手动', limit: `条数上限（${MAX_ENTRIES}）`, quit: '退出' }[r.reason || 'manual'] || r.reason;
  const resById = new Map();
  for (const e of r.md) if (e.k === 'res') resById.set(e.id, e);

  const out = [];
  out.push(`# 录制摘要 — ${r.base}`);
  out.push('');
  out.push(`- 开始：${dt(t0)} · 时长 ${fmtDur(Date.now() - t0)} · 停止原因：${reasonText}`);
  const ac = r.actCounts;
  const c = (k) => r.counts[k] || 0;
  out.push(`- 统计：点击 ${ac.click} · 输入 ${ac.input} · 变更 ${ac.change} · 提交 ${ac.submit} · 按键 ${ac.keydown} · 滚动 ${ac.scroll}`
    + ` · 请求 ${c('req')} · 响应 ${c('res')} · 响应体 ${c('body')} · 导航 ${c('nav')} · 页面 ${c('page')} · WebSocket ${c('ws')}`);
  out.push(`- 原始数据：${r.base}.jsonl（每行一个 JSON 对象）`);
  out.push('');
  out.push(`## 时间线（前 ${MD_MAX_LINES} 条，共 ${r.n} 条）`);

  let printed = 0;
  for (const e of r.md) {
    if (printed >= MD_MAX_LINES) break;
    let body = '';
    if (e.k === 'action') {
      if (e.a === 'scroll') {
        body = `滚动 y=${e.y == null ? '' : e.y}`;
      } else {
        body = `${verbs[e.a] || e.a} ${e.sel || ''}`.trimEnd();
        if (e.text) body += `「${String(e.text).slice(0, 40)}」`;
        if (e.key) body += ` ${e.key}`;
        if (e.value !== undefined && e.value !== null && e.value !== '') body += ` 值=${String(e.value).slice(0, 40)}`;
        if (e.x != null) body += ` (${e.x},${e.y})`;
      }
    } else if (e.k === 'req') {
      const res = resById.get(e.id);
      body = `└→ ${e.method} ${shortUrl(e.url)}`;
      if (res) body += ` · ${res.status} · ${res.ms == null ? '-' : res.ms + 'ms'} · ${humanSize(res.size)}`;
    } else if (e.k === 'nav') {
      body = `⇢ ${e.kind === 'fail' ? '加载失败' : '跳转'} ${shortUrl(e.url)}`;
    } else if (e.k === 'page') {
      body = `⇢ ${shortUrl(e.url)} — ${e.title || ''}`;
    } else if (e.k === 'ws') {
      body = `⇠ ws ${e.a}${e.payload ? ' ' + String(e.payload).slice(0, 80) : ''}`;
    } else if (e.k === 'shot') {
      body = `截图 ${e.file}`;
    } else if (e.k === 'note') {
      body = `! ${e.text}`;
    } else {
      continue;
    }
    out.push(`${tm(e.t)} #${e.tab == null ? '-' : e.tab} ${body}`);
    printed++;
  }
  if (r.n > printed) out.push(`…（其余 ${r.n - printed} 条见 JSONL）`);
  out.push('');
  return out.join('\n');
}

/* -------------------------------------------------------------- 注入与摘挂 */

// 选择器算法：录制注入与元素拾取共用一份（改这里两边都生效）；esc 是它的依赖，一起带出来
const SELECTOR_SRC = `const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s));
  const selOf = (el) => {
    try {
      if (!el || el.nodeType !== 1 || !el.tagName) return '';
      if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
      const parts = [];
      let node = el;
      for (let d = 0; node && node.nodeType === 1 && d < 5; d++) {
        if (d > 0 && node.id) { parts.unshift('#' + esc(node.id)); break; }
        let part = node.tagName.toLowerCase();
        const cls = Array.prototype.slice.call(node.classList || [], 0, 2).map(esc);
        if (cls.length) part += '.' + cls.join('.');
        const parent = node.parentElement;
        if (parent) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    } catch (e) { return ''; }
  };`;

const RECORD_SCRIPT = `(() => {
  if (window.__wctRecArmed) return;
  window.__wctRecArmed = true;
  const send = (o) => { try { if (window.__wctRecord) window.__wctRecord(JSON.stringify(o)); } catch (e) {} };
  ${SELECTOR_SRC}
  const txt = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
  const valOf = (el) => (el && el.type === 'password' ? '[password]' : txt(el && el.value, 200));
  const tagOf = (el) => (el && el.tagName ? el.tagName.toLowerCase() : '');
  document.addEventListener('click', (e) => {
    const t = e.target;
    let href = '';
    try { const a = t && t.closest ? t.closest('a') : null; if (a) href = a.href; } catch (err) {}
    send({ t: Date.now(), a: 'click', sel: selOf(t), tag: tagOf(t), text: txt(t && t.textContent, 80), href, x: e.clientX, y: e.clientY, url: location.href });
  }, true);
  let lastInputSel = '';
  let lastInputAt = 0;
  document.addEventListener('input', (e) => {
    const sel = selOf(e.target);
    const now = Date.now();
    if (sel === lastInputSel && now - lastInputAt < 300) return;
    lastInputSel = sel;
    lastInputAt = now;
    send({ t: now, a: 'input', sel, tag: tagOf(e.target), type: (e.target && e.target.type) || '', value: valOf(e.target), url: location.href });
  }, true);
  document.addEventListener('change', (e) => {
    send({ t: Date.now(), a: 'change', sel: selOf(e.target), tag: tagOf(e.target), type: (e.target && e.target.type) || '', value: valOf(e.target), checked: !!(e.target && e.target.checked), url: location.href });
  }, true);
  document.addEventListener('submit', (e) => {
    const f = e.target;
    let fields = [];
    try {
      fields = Array.prototype.slice.call(f.elements, 0, 20).map((x) => ({ name: x.name || '', value: x.type === 'password' ? '[password]' : txt(x.value, 120) }));
    } catch (err) {}
    send({ t: Date.now(), a: 'submit', sel: selOf(f), action: f.action || '', method: String(f.method || 'get').toUpperCase(), fields, url: location.href });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    send({ t: Date.now(), a: 'keydown', sel: selOf(document.activeElement), key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, url: location.href });
  }, true);
  let lastScrollAt = 0;
  document.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastScrollAt < 500) return;
    lastScrollAt = now;
    const d = document.scrollingElement || document.documentElement;
    send({ t: now, a: 'scroll', sel: '', x: d.scrollLeft, y: d.scrollTop, url: location.href });
  }, true);
})()`;

async function arm(wc) {
  if (armed.has(wc.id)) return true;
  const dbg = wc.debugger;
  if (!dbg.isAttached()) return false;
  try {
    await dbg.sendCommand('Runtime.enable');
    await dbg.sendCommand('Runtime.addBinding', { name: BINDING });
    const r = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_SCRIPT });
    armed.set(wc.id, { identifier: r && r.identifier, wc });
    await dbg.sendCommand('Runtime.evaluate', { expression: RECORD_SCRIPT, returnByValue: true });   // 当前已加载的文档
    return true;
  } catch (e) {
    logger.log('rec', `注入失败：${e.message}`);
    note(`注入失败（标签 ${wc.id}）：${e.message}`);
    return false;
  }
}

async function disarm(wc) {
  const item = armed.get(wc.id);
  if (!item) return;
  armed.delete(wc.id);
  try {
    if (item.identifier) await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: item.identifier });
  } catch (e) { /* 目标已失效 */ }
  try {
    await wc.debugger.sendCommand('Runtime.removeBinding', { name: BINDING });
  } catch (e) { /* 目标已失效 */ }
}

/* -------------------------------------------------------------- 事件入口 */

function onBinding(tab, params) {
  if (!rec || !rec.active) return;
  let payload;
  try { payload = JSON.parse(params.payload); } catch (e) { return; }
  if (!payload || !payload.a) return;
  if (!Object.prototype.hasOwnProperty.call(rec.actCounts, payload.a)) return;
  const entry = Object.assign({ k: 'action', tab: tab.id }, payload);
  push(entry);
  rec.actCounts[payload.a]++;
  if (payload.a !== 'keydown' && payload.a !== 'scroll') rec.lastAction = { n: entry.n, t: entry.t };
  if (payload.a === 'click' && rec.shots) takeShot(tab, entry);
}

function takeShot(tab, entry) {
  const r = rec;
  if (!r || !r.active || !r.shots) return;
  if (r.shotCount >= MAX_SHOTS) {
    if (!r.shotNoteDone) { r.shotNoteDone = true; note(`截图已达上限 ${MAX_SHOTS} 张，后续点击不再截图`); }
    return;
  }
  r.shotCount++;
  const name = `${r.base}-click-${String(r.shotCount).padStart(3, '0')}.png`;
  const file = path.join(dirPath(), name);
  tab.wc.capturePage()
    .then((image) => fs.promises.writeFile(file, image.toPNG()))
    .then(() => { if (rec && rec.active) push({ k: 'shot', tab: tab.id, sel: entry.sel || '', file: name }); })
    .catch((e) => {
      logger.log('rec', `截图失败：${e.message}`);
      if (rec && rec.active) note(`截图失败：${e.message}`);
    });
}

function headersToObject(record) {
  const out = {};
  for (const h of format.mergedHeaders(record.requestHeadersRaw, record.requestHeaders)) out[h.name] = h.value;
  return out;
}

function resHeadersToObject(record) {
  const out = {};
  for (const h of format.mergedHeaders(record.responseHeadersRaw, record.responseHeaders)) out[h.name] = h.value;
  return out;
}

function onRequest(tab, record, redirect = false) {
  if (!rec || !rec.active) return;
  let post = record.postData == null ? null : String(record.postData);
  let truncated = false;
  if (post != null && post.length > MAX_POST_WRITE) { post = post.slice(0, MAX_POST_WRITE); truncated = true; }
  const entry = {
    k: 'req', tab: tab.id, id: record.id, method: record.method, url: record.url,
    type: record.type || '', redirect: !!redirect, headers: headersToObject(record),
    postData: post, postDataTruncated: truncated,
  };
  if (rec.lastAction && Date.now() - rec.lastAction.t <= AFTER_WINDOW_MS) entry.after = rec.lastAction.n;
  push(entry);
}

function onResponse(tab, record) {
  if (!rec || !rec.active) return;
  push({
    k: 'res', tab: tab.id, id: record.id, url: record.url,
    status: record.status, statusText: record.statusText || '', mime: record.mime || '',
    size: record.encodedDataLength || 0, ms: record.duration == null ? null : record.duration,
    headers: resHeadersToObject(record), failed: null,
  });
}

function onFail(tab, record) {
  if (!rec || !rec.active) return;
  push({
    k: 'res', tab: tab.id, id: record.id, url: record.url,
    status: record.status || 0, statusText: record.statusText || '', mime: record.mime || '',
    size: record.encodedDataLength || 0, ms: record.duration == null ? null : record.duration,
    headers: resHeadersToObject(record), failed: record.failed || null,
  });
}

function onBody(tab, record) {
  if (!rec || !rec.active) return;
  const entry = { k: 'body', tab: tab.id, id: record.id, url: record.url };
  if (record.body == null) {
    entry.body = null;
    entry.bodyError = record.bodyError || '无响应体';
  } else if (rec.bodyBytes >= MAX_TOTAL_BODY_WRITE) {
    entry.body = null;
    entry.bodyError = '录制体量上限（32MB）';
    if (!rec.bodyNoteDone) { rec.bodyNoteDone = true; note('响应体写入已达总量上限（32MB），后续只记录元数据'); }
  } else {
    let body = String(record.body);
    let truncated = false;
    if (!record.bodyBase64 && body.length > MAX_BODY_WRITE) { body = body.slice(0, MAX_BODY_WRITE); truncated = true; }
    rec.bodyBytes += body.length;
    entry.body = body;
    entry.bodyBase64 = !!record.bodyBase64;
    entry.bodyLen = record.body.length;
    entry.bodyTruncated = truncated;
  }
  push(entry);
}

function onWs(tab, frame) {
  if (!rec || !rec.active) return;
  let payload = frame.payload == null ? '' : String(frame.payload);
  if (payload.length > MAX_WS_WRITE) payload = payload.slice(0, MAX_WS_WRITE);
  push({
    k: 'ws', tab: tab.id, a: frame.kind, url: frame.url || '',
    opcode: frame.opcode == null ? null : frame.opcode, payload, error: frame.error || '',
  });
}

function onNav(tab, info) {
  if (!rec || !rec.active) return;
  push({ k: 'nav', tab: tab.id, url: (info && info.url) || '', kind: (info && info.kind) || 'did-navigate' });
}

function onPage(tab, info) {
  if (!rec || !rec.active) return;
  push({ k: 'page', tab: tab.id, url: (info && info.url) || '', title: (info && info.title) || '' });
}

/* -------------------------------------------------- 录制历史 / 重放 */

// 从文件尾读最多 4KB（列表只要最后一行 summary，不读整个文件）
function readTailText(file, maxBytes = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* 已关闭 */ } }
  }
}

// 录制目录里的 .jsonl 列表（按 mtime 倒序）；entries/reason 取自最后一行 summary
function listRecordings() {
  const dir = dirPath();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    const lines = readTailText(file).split('\n').filter((l) => l.trim());
    let last = null;
    for (let i = lines.length - 1; i >= 0 && !last; i--) {       // 尾部可能被截断，往前找第一条能解析的
      try { last = JSON.parse(lines[i]); } catch (e) { last = null; }
    }
    const summary = last && last.k === 'summary' ? last : null;
    out.push({
      file, base: name.replace(/\.jsonl$/, ''), size: st.size, mtime: st.mtimeMs,
      entries: summary ? (summary.entries || 0) : 0,
      reason: summary ? (summary.reason || '') : '',
      md: fs.existsSync(file.replace(/\.jsonl$/, '.md')),
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// 读单个录制：md 摘要 + 可重放的动作（只允许录制目录内的文件）
function readRecording(file) {
  const p = path.resolve(String(file == null ? '' : file));
  if (path.dirname(p) !== path.resolve(dirPath())) return { ok: false, error: '只能读取录制目录里的文件' };
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { ok: false, error: `读取失败：${e.message}` }; }
  const lines = text.split('\n').filter((l) => l.trim());
  const actions = [];
  for (const line of lines) {
    if (actions.length >= 5000) break;                            // ponytail: 单次重放动作上限 5000，超出请分段录制
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e && e.k === 'action') {
      actions.push({
        n: e.n, t: e.t, a: e.a, sel: e.sel, text: e.text, value: e.value,
        key: e.key, checked: e.checked, x: e.x, y: e.y, url: e.url,
      });
    }
  }
  let md = '';
  try { md = fs.readFileSync(p.replace(/\.jsonl$/, '.md'), 'utf8'); } catch (e) { md = ''; }
  return { ok: true, file: p, base: path.basename(p).replace(/\.jsonl$/, ''), entries: lines.length, md, actions };
}

// 生成独立的 Playwright 回放脚本（零依赖：只用字符串拼接）
function buildScript(actions, opts = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const q1 = (s) => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
  const first = list.find((a) => a && a.url);
  const start = String(opts.url || (first ? first.url : '') || 'about:blank');
  const out = [];
  out.push('// 由 web-capture-tool 录制生成');
  out.push('// 用法：npm i -D playwright && npx playwright install chromium && node replay.js');
  out.push("const { chromium } = require('playwright');");
  out.push('');
  out.push('(async () => {');
  out.push('  const browser = await chromium.launch({ headless: false });');
  out.push('  const page = await browser.newPage();');
  out.push(`  await page.goto(${q1(start)});`);
  let prev = list.length && list[0].t ? list[0].t : Date.now();
  for (const a of list) {
    if (!a) continue;
    const wait = Math.min(5000, Math.max(0, (a.t || prev) - prev));
    prev = a.t || prev;
    if (wait > 50) out.push(`  await page.waitForTimeout(${Math.round(wait)});   // 与上一条的实际间隔`);
    if (a.a === 'click') {
      if (!a.sel) out.push('  // 跳过一条点击：录制里没有选择器');
      else out.push(`  await page.click(${q1(a.sel)});`);
    } else if (a.a === 'input') {
      if (a.value === '[password]') {
        out.push('  // 密码已在录制中掩码，请手动填写');
        out.push(`  await page.fill(${q1(a.sel)}, '');`);
      } else {
        out.push(`  await page.fill(${q1(a.sel)}, ${q1(a.value)});`);
      }
    } else if (a.a === 'change') {
      const type = String(a.type || '');
      if (!a.sel) out.push('  // 跳过一条值变更：录制里没有选择器');
      else if (type === 'checkbox' || type === 'radio') out.push(`  await page.${a.checked ? 'check' : 'uncheck'}(${q1(a.sel)});`);
      else out.push(`  await page.selectOption(${q1(a.sel)}, ${q1(a.value)});`);
    } else if (a.a === 'submit') {
      out.push(`  await page.evaluate((sel) => { const f = document.querySelector(sel); if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); } }, ${q1(a.sel)});`);
    } else if (a.a === 'keydown') {
      out.push(`  await page.keyboard.press(${q1(a.key)});`);
    } else if (a.a === 'scroll') {
      out.push(`  await page.evaluate(() => window.scrollTo(0, ${Number(a.y) || 0}));`);
    } else {
      out.push(`  // 跳过未支持的动作：${String(a.a || '')}`);
    }
  }
  out.push('  await browser.close();');
  out.push('})();');
  return out.join('\n') + '\n';
}

let replayState = null;

// 单个动作的执行；选择器与值一律用 JSON.stringify 内插，避免引号注入
async function runAction(dbg, a) {
  const evalIn = async (expression) => {
    const r = await dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.text || '页面脚本异常' };
    return { ok: true, value: r.result ? r.result.value : undefined };
  };
  const sel = JSON.stringify(String(a.sel || ''));
  if (a.a === 'click') {
    const r = await evalIn(`(() => { const el = document.querySelector(${sel}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    if (!r.ok) return r;
    if (r.value) return { ok: true };
    if (typeof a.x === 'number' && typeof a.y === 'number') {          // 选择器失配时退化为坐标点击
      try {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: `未找到元素：${a.sel || '(无选择器)'}` };
  }
  if (a.a === 'input' || a.a === 'change') {
    if (!a.sel) return { ok: false, error: '录制里没有选择器' };
    if (a.a === 'input' && a.value === '[password]') return { ok: false, error: '密码字段已掩码，无法重放' };
    const setChecked = Object.prototype.hasOwnProperty.call(a, 'checked') ? `if ('checked' in el) el.checked = ${a.checked ? 'true' : 'false'};` : '';
    const setValue = a.a === 'input' ? `el.value = ${JSON.stringify(String(a.value == null ? '' : a.value))};` : '';
    const r = await evalIn(`(() => { const el = document.querySelector(${sel}); if (!el) return false; el.focus(); ${setChecked} ${setValue} el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!r.ok) return r;
    return r.value ? { ok: true } : { ok: false, error: `未找到元素：${a.sel}` };
  }
  if (a.a === 'submit') {
    if (!a.sel) return { ok: false, error: '录制里没有选择器' };
    const r = await evalIn(`(() => { const f = document.querySelector(${sel}); if (!f) return false; if (f.requestSubmit) f.requestSubmit(); else f.submit(); return true; })()`);
    if (!r.ok) return r;
    return r.value ? { ok: true } : { ok: false, error: `未找到表单：${a.sel}` };
  }
  if (a.a === 'keydown') {
    if (!a.key) return { ok: false, error: '录制里没有按键' };
    const mods = (a.alt ? 1 : 0) | (a.ctrl ? 2 : 0) | (a.meta ? 4 : 0) | (a.shift ? 8 : 0);
    const base = mods ? { modifiers: mods } : {};
    try {
      await dbg.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', key: a.key }, base));
      await dbg.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp', key: a.key }, base));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (a.a === 'scroll') {
    const r = await evalIn(`(() => { window.scrollTo(0, ${Number(a.y) || 0}); return true; })()`);
    return r.ok ? { ok: true } : r;
  }
  return { ok: false, error: `不支持的动作用类型：${a.a}` };
}

// 按录制重放（异步长跑）：speed 0 = 不等间隔，1/2/4 = 倍速；stopOnError 默认 true
async function replayRecording(file, opts = {}) {
  if (replayState) return { ok: false, error: '已有重放任务在进行中' };
  const rd = readRecording(file);
  if (!rd.ok) return rd;
  if (!rd.actions.length) return { ok: false, error: '这个录制里没有可重放的交互动作' };
  const wc = state.view && !state.view.webContents.isDestroyed() ? state.view.webContents : null;
  if (!wc) return { ok: false, error: '视图未就绪' };
  const dbg = wc.debugger;
  if (!dbg.isAttached()) return { ok: false, error: 'CDP 未就绪' };
  const speed = [0, 1, 2, 4].includes(opts.speed) ? opts.speed : 1;
  const stopOnError = opts.stopOnError !== false;
  const actions = rd.actions.slice(0, 2000);                 // ponytail: 单次最多 2000 个动作，长录制请分段
  replayState = { stop: false, done: 0, total: actions.length, failed: [] };
  const t0 = Date.now();
  const origin = actions[0].t || Date.now();
  try {
    for (const a of actions) {
      if (replayState.stop) break;
      if (speed && a.t) {
        const wait = Math.min(60000, Math.max(0, (a.t - origin) / speed - (Date.now() - t0)));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      let r;
      try { r = await runAction(dbg, a); } catch (e) { r = { ok: false, error: e.message }; }   // 导航/关标签会让目标短暂失效
      if (r.ok) replayState.done++;
      else {
        replayState.failed.push({ n: a.n, a: a.a, sel: a.sel, reason: r.error });
        if (stopOnError) { replayState.stop = true; break; }
      }
      send('cap:replayProgress', { done: replayState.done, total: replayState.total, failed: replayState.failed.length, last: a.sel || a.a });
    }
    return { ok: true, done: replayState.done, total: replayState.total, failed: replayState.failed, stopped: replayState.stop };
  } finally {
    replayState = null;
  }
}

function stopReplay() {
  if (!replayState) return { ok: false, error: '当前没有重放任务' };
  replayState.stop = true;
  return { ok: true };
}

module.exports = {
  VERSION, DIRNAME, BINDING, MAX_ENTRIES, MAX_BODY_WRITE, MAX_TOTAL_BODY_WRITE, MAX_POST_WRITE,
  MAX_WS_WRITE, MAX_SHOTS, FLUSH_MS, FLUSH_BYTES, MD_MAX_LINES,
  dirPath, useDir, isRecording, lastFile, lastInfo: () => Object.assign({}, lastInfo), status, start, stop, stopWhenIdle, flushSync,
  arm, disarm, RECORD_SCRIPT, SELECTOR_SRC,
  onBinding, onRequest, onResponse, onBody, onFail, onWs, onNav, onPage, onNote: note,
  listRecordings, readRecording, buildScript, replayRecording, stopReplay,
};
