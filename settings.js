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
};

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

// 同一 session 的 onBeforeRequest 只能注册一个监听器，因此只在启动时注册一次。
function registerBlocker() {
  session.fromPartition(PARTITION).webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    if (values.blockMode === 'assets') return cb({ cancel: ASSET_TYPES.has(details.resourceType) });
    if (values.blockMode === 'keywords') {
      const kws = parseKeywords(values.blockKeywords);
      return cb({ cancel: kws.length > 0 && kws.some((k) => details.url.toLowerCase().includes(k)) });
    }
    cb({});
  });
}

function viewWc() { return state.view && state.view.webContents; }

async function applyInner(key, value) {
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

    case 'throttle': {
      if (!Object.prototype.hasOwnProperty.call(THROTTLE, value)) return { ok: false, error: '未知限速档位' };
      const wc = viewWc();
      if (!wc || !wc.debugger.isAttached()) return { ok: false, error: 'CDP 未就绪' };
      try {
        await wc.debugger.sendCommand('Network.emulateNetworkConditions', Object.assign({ offline: false }, THROTTLE[value]));
      } catch (e) { return { ok: false, error: e.message }; }
      values.throttle = value;
      return { ok: true };
    }

    case 'ua': {
      const wc = viewWc();
      if (!wc) return { ok: false, error: '视图未就绪' };
      const v = String(value == null ? '' : value).trim();
      wc.setUserAgent(v || state.defaultUA);
      values.ua = v;
      return { ok: true, needReload: true };
    }

    case 'headers': {
      const p = parseHeaders(value);
      if (!p.ok) return { ok: false, error: p.error };
      const wc = viewWc();
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
async function restoreRuntime() {
  const failed = [];
  for (const key of ['ua', 'headers', 'throttle', 'proxy']) {
    if (!values[key]) continue;
    try {
      const r = await applyInner(key, values[key]);
      if (!r.ok) failed.push(`${key}: ${r.error}`);
    } catch (e) {
      failed.push(`${key}: ${e.message}`);
    }
  }
  return failed;
}

module.exports = { values, applySetting, applyInner, hydrate, restoreRuntime, registerBlocker, parseKeywords, parseHeaders };
