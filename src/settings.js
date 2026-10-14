'use strict';
/*
 * 抓取设置（拦截 / 限速 / UA / 请求头 / 代理）。
 * 所有设置写入的唯一入口是 applySetting(key, value)：在此处统一校验与规范化。
 */
const { session } = require('electron');
const { state, PARTITION } = require('./state');
const store = require('./store');

const values = {
  blockMode: 'none',      // none | assets | keywords
  blockKeywords: '',
  recordOnly: false,
  throttle: 'off',        // off | 3g | slow
  ua: '',                 // 空串 = 用 state.defaultUA
  headers: '',            // 'k=v;k=v'，空串 = 清除
  proxy: '',              // 'scheme://host:port'，空串 = 直连
  colSet: 'd',            // 列表列预设 d | dt | t
  reqDelay: 0,            // 请求最小间隔 ms（0 = 不限速）
  ignoreCertErrors: false,
  authUser: '',           // Basic 认证用户名（空 = 不自动应答）
  authPass: '',           // Basic 认证密码（明文存盘，仅本地使用）
  recShots: false,        // 录制时是否给每次点击存一张视口截图
  sortBy: 'time',         // 列表排序：time | domain | size | duration | status
  tasks: [],              // 提取任务预设（最多 20 条），见 applyInner('tasks')
  saveRule: { on: false, urlRe: '', mimes: '', types: 'all', dir: '' },   // 响应体落盘规则
};

const MAX_REQ_DELAY = 10000;

const ASSET_TYPES = new Set(['image', 'media', 'font']);
const THROTTLE = {
  off: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  '3g': { latency: 300, downloadThroughput: 200 * 1024, uploadThroughput: 100 * 1024 },
  slow: { latency: 800, downloadThroughput: 60 * 1024, uploadThroughput: 30 * 1024 },
};

function parseKeywords(s) {
  return String(s == null ? '' : s)
    .split(/[,，\n]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function parseHeaders(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return { ok: true, value: {} };
  const out = {};
  let bad = 0;
  for (const seg of raw.split(/[;\n]/)) {
    const t = seg.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) { bad++; continue; }
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!k) { bad++; continue; }
    out[k] = v;
  }
  if (!Object.keys(out).length && bad) return { ok: false, error: '请求头格式应为 k=v;k=v' };
  return { ok: true, value: out };
}

let pacerCursor = 0;   // 请求节奏游标（毫秒时间戳）

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

// 当前节奏游标（自检观测/复位用）
function pacerState() { return pacerCursor; }
function resetPacer(now = 0) { pacerCursor = now; return pacerCursor; }

// 纯节奏逻辑（注入时钟便于自检）：返回本次要等多少毫秒，并推进游标
function nextPaceWait(delay, now) {
  const d = clampInt(delay, 0, MAX_REQ_DELAY, 0);
  if (!d) return 0;
  const wait = Math.max(0, pacerCursor - now);
  pacerCursor = Math.max(now, pacerCursor) + d;
  return wait;
}

function decide(details) {
  if (values.blockMode === 'assets') return { cancel: ASSET_TYPES.has(details.resourceType) };
  if (values.blockMode === 'keywords') {
    const kws = parseKeywords(values.blockKeywords);
    return { cancel: kws.length > 0 && kws.some((k) => details.url.toLowerCase().includes(k)) };
  }
  return { cancel: false };
}

// 只有放行的请求才占用节奏槽；被拦截的请求不消耗间隔
function release(details, cb) {
  const d = decide(details);
  if (d.cancel) return cb({ cancel: true });
  const wait = nextPaceWait(values.reqDelay, Date.now());
  if (!wait) return cb({});
  setTimeout(() => cb({}), wait);
}

// 同一 session 的 onBeforeRequest 只能注册一个监听器，因此只在启动时注册一次。
function registerBlocker() {
  session.fromPartition(PARTITION).webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    release(details, cb);
  });
}

function viewWc(target) { return target || (state.view && state.view.webContents); }

async function applyInner(key, value, target) {
  switch (key) {
    case 'blockMode':
      if (!['none', 'assets', 'keywords'].includes(value)) return { ok: false, error: '未知拦截模式' };
      values.blockMode = value;
      return { ok: true, needReload: true };

    case 'blockKeywords':
      values.blockKeywords = String(value == null ? '' : value);
      return { ok: true, needReload: true };

    case 'recordOnly':
      values.recordOnly = !!value;
      return { ok: true };

    case 'colSet':
      if (!['d', 'dt', 't'].includes(value)) return { ok: false, error: '未知列预设' };
      values.colSet = value;
      return { ok: true };

    case 'reqDelay': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > MAX_REQ_DELAY) return { ok: false, error: `间隔应在 0–${MAX_REQ_DELAY}ms 之间` };
      values.reqDelay = Math.round(n);
      return { ok: true };
    }

    case 'ignoreCertErrors':
      values.ignoreCertErrors = !!value;
      return { ok: true };

    case 'authUser':
      values.authUser = String(value == null ? '' : value).trim();
      return { ok: true };

    case 'authPass':
      values.authPass = String(value == null ? '' : value);
      return { ok: true };

    case 'recShots':
      values.recShots = !!value;
      return { ok: true };

    case 'sortBy':
      if (!['time', 'domain', 'size', 'duration', 'status'].includes(value)) return { ok: false, error: '未知排序方式' };
      values.sortBy = value;
      return { ok: true };

    case 'tasks': {
      const list = Array.isArray(value) ? value : [];
      const clean = [];
      for (const t of list.slice(0, 20)) {
        if (!t || typeof t !== 'object') continue;
        const name = String(t.name == null ? '' : t.name).trim().slice(0, 40);
        if (!name) continue;
        clean.push({
          name, url: String(t.url == null ? '' : t.url).slice(0, 500),
          rows: String(t.rows == null ? '' : t.rows).slice(0, 200),
          fields: String(t.fields == null ? '' : t.fields).slice(0, 2000),
          pages: clampInt(t.pages, 1, 100, 3), delay: clampInt(t.delay, 200, 60000, 2000),
        });
      }
      values.tasks = clean;
      return { ok: true };
    }

    case 'saveRule': {
      const r = (value && typeof value === 'object') ? value : {};
      const urlRe = String(r.urlRe == null ? '' : r.urlRe).slice(0, 300);
      if (urlRe) {
        try { new RegExp(urlRe); } catch (e) { return { ok: false, error: 'URL 正则无法解析：' + e.message }; }
      }
      const types = ['all', 'xhr', 'doc'].includes(r.types) ? r.types : 'all';
      values.saveRule = {
        on: !!r.on, urlRe,
        mimes: String(r.mimes == null ? '' : r.mimes).slice(0, 200),
        types, dir: String(r.dir == null ? '' : r.dir).slice(0, 500),
      };
      return { ok: true };
    }

    case 'throttle': {
      if (!Object.prototype.hasOwnProperty.call(THROTTLE, value)) return { ok: false, error: '未知限速档位' };
      const wc = viewWc(target);
      if (!wc || !wc.debugger.isAttached()) return { ok: false, error: 'CDP 未就绪' };
      try {
        await wc.debugger.sendCommand('Network.emulateNetworkConditions', Object.assign({ offline: false }, THROTTLE[value]));
      } catch (e) { return { ok: false, error: e.message }; }
      values.throttle = value;
      return { ok: true };
    }

    case 'ua': {
      const wc = viewWc(target);
      if (!wc) return { ok: false, error: '视图未就绪' };
      const v = String(value == null ? '' : value).trim();
      wc.setUserAgent(v || state.defaultUA);
      values.ua = v;
      return { ok: true, needReload: true };
    }

    case 'headers': {
      const p = parseHeaders(value);
      if (!p.ok) return { ok: false, error: p.error };
      const wc = viewWc(target);
      if (!wc || !wc.debugger.isAttached()) return { ok: false, error: 'CDP 未就绪' };
      try {
        await wc.debugger.sendCommand('Network.setExtraHTTPHeaders', { headers: p.value });
      } catch (e) { return { ok: false, error: e.message }; }
      values.headers = String(value == null ? '' : value);
      return { ok: true, needReload: true };
    }

    case 'proxy': {
      const ses = session.fromPartition(PARTITION);
      const v = String(value == null ? '' : value).trim();
      if (v && !/^[a-z0-9]+:\/\/[^\s]+$/i.test(v)) return { ok: false, error: '代理格式应为 scheme://host:port' };
      try {
        if (!v) await ses.setProxy({ mode: 'direct' });
        else await ses.setProxy({ proxyRules: v });
      } catch (e) { return { ok: false, error: e.message }; }
      values.proxy = v;
      return { ok: true, needReload: true };
    }

    case 'softwareRendering': {
      store.setApp('softwareRendering', !!value);
      store.flush();
      return { ok: true, needRestart: true };
    }

    default:
      return { ok: false, error: '未知设置项' };
  }
}

// 唯一写入口：成功的设置改动一律落盘（防抖），保证重启后仍在
async function applySetting(key, value) {
  const r = await applyInner(key, value);
  if (r.ok) {
    store.setSettings(values);
    store.save();
  }
  return r;
}

// 启动时把磁盘里的设置灌进内存（在 createWindow 之前调用）
function hydrate() {
  Object.assign(values, store.get().settings);
  return values;
}

// 重启后重新应用不会自动恢复的项：UA / 请求头 / 限速 / 代理（其余由拦截器等实时读取）
// target 用于把设置应用到指定视图（新建标签时沿用当前设置）
async function restoreRuntime(target) {
  const failed = [];
  for (const key of ['ua', 'headers', 'throttle', 'proxy']) {
    if (!values[key]) continue;
    try {
      const r = await applyInner(key, values[key], target);
      if (!r.ok) failed.push(`${key}: ${r.error}`);
    } catch (e) {
      failed.push(`${key}: ${e.message}`);
    }
  }
  return failed;
}

// 把当前 UA / 请求头 / 限速应用到所有已打开标签（UA 空串 = 复位成默认 UA）
async function applyToAllTabs() {
  const failed = [];
  for (const tab of state.tabs) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) continue;
    try {
      wc.setUserAgent(values.ua || state.defaultUA);
    } catch (e) { failed.push(`ua@${tab.id}: ${e.message}`); }
    for (const key of ['headers', 'throttle']) {
      if (!values[key]) continue;                        // 空请求头 / 不限速对该标签没有意义
      try {
        const r = await applyInner(key, values[key], wc);
        if (!r.ok) failed.push(`${key}@${tab.id}: ${r.error}`);
      } catch (e) { failed.push(`${key}@${tab.id}: ${e.message}`); }
    }
  }
  return { ok: failed.length === 0, tabs: state.tabs.length, failed };
}

module.exports = {
  values, applySetting, applyInner, hydrate, restoreRuntime, registerBlocker, parseKeywords, parseHeaders,
  MAX_REQ_DELAY, nextPaceWait, resetPacer, pacerState, decide, release, applyToAllTabs,
};
