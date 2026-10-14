'use strict';
/*
 * CDP 抓取：把 WebContentsView/BrowserView 的调试器挂上，把 Network.* 事件转成记录。
 */
const { net, session } = require('electron');
const { state, send, setStatus, normalizeUrl, PARTITION, MAX_RECORDS, MAX_BODY, MAX_TOTAL_BODY, MAX_WS_FRAMES } = require('./state');
const settings = require('./settings');
const format = require('./format');
const recorder = require('./recorder');
const picker = require('./picker');
const files = require('./files');
const logger = require('./logger');

/* -------------------------------------------------- 记录字段（initiator） */

// CDP initiator 裁剪：只留定位加密代码需要的字段，栈最多 12 帧（会话体积：5000 条 × 每帧约 60B）
function trimInitiator(i) {
  const frames = ((i.stack && i.stack.callFrames) || []).slice(0, 12).map((f) => ({
    fn: f.functionName || '(anonymous)', url: f.url || '', line: f.lineNumber, col: f.columnNumber,
  }));
  return { type: i.type || '', url: i.url || '', lineNumber: i.lineNumber || 0, columnNumber: i.columnNumber || 0, stack: frames };
}

/* ------------------------------------------------------------ 规则落盘 */

// 单次运行最多落盘这么多文件 / 字节（切换规则即重置）
const MAX_AUTO_SAVE_FILES = 2000;
const MAX_AUTO_SAVE_BYTES = 512 * 1024 * 1024;
const autoSave = { n: 0, bytes: 0, blocked: '' };

function resetAutoSave() { autoSave.n = 0; autoSave.bytes = 0; autoSave.blocked = ''; return { ok: true }; }
function autoSaveState() { return { n: autoSave.n, bytes: autoSave.bytes, blocked: autoSave.blocked }; }

// 规则匹配：URL 正则 × 类型 × MIME 关键字
function matchSaveRule(rec, rule) {
  if (!rule || !rule.on || !rule.dir) return false;
  if (rule.urlRe) {
    try { if (!new RegExp(rule.urlRe).test(rec.url)) return false; } catch (e) { return false; }
  }
  if (rule.types === 'xhr' && !['XHR', 'Fetch'].includes(rec.type)) return false;
  if (rule.types === 'doc' && rec.type !== 'Document') return false;
  const mimes = String(rule.mimes || '').split(/[,，\s]+/).filter(Boolean);
  if (mimes.length && !mimes.some((m) => String(rec.mime || '').toLowerCase().includes(m.toLowerCase()))) return false;
  return true;
}

function summarize(r) {
  return {
    id: r.id, method: r.method, url: r.url, type: r.type, time: r.time,
    status: r.status, statusText: r.statusText, mime: r.mime,
    size: r.encodedDataLength || 0, duration: r.duration,
    failed: r.failed, hasBody: r.body !== null, note: r.note,
    redirects: r.redirects.length,
    star: !!r.star,
    restored: !!r.restored,
  };
}

function fullRecord(r) {
  return {
    id: r.id, method: r.method, url: r.url, type: r.type, time: r.time,
    status: r.status, statusText: r.statusText, mime: r.mime,
    remoteIP: r.remoteIP, protocol: r.protocol,
    requestHeaders: r.requestHeaders, requestHeadersRaw: r.requestHeadersRaw, postData: r.postData,
    initiator: r.initiator || null,
    responseHeaders: r.responseHeaders, responseHeadersRaw: r.responseHeadersRaw,
    redirects: r.redirects, failed: r.failed,
    encodedDataLength: r.encodedDataLength, durationMs: r.duration,
    timing: r.timing || null, timingParts: format.timingParts(r.timing, r.duration),
    bodyBase64: r.bodyBase64, bodyError: r.bodyError, body: r.body,
    star: !!r.star, comment: r.comment || '',
    restored: !!r.restored,
  };
}

function onRequestWillBeSent(tab, ev) {
  const { requestId, request, timestamp, wallTime, type, redirectResponse, initiator } = ev;
  if (!tab.enabled) return;
  if (settings.values.recordOnly && type !== 'XHR' && type !== 'Fetch') return;
  const prev = tab.byId.get(requestId);
  if (prev) {
    // 同一 requestId 复用 = 重定向：记录上一跳，就地更新为最终目标
    prev.redirects.push({ url: prev.url, status: (redirectResponse && redirectResponse.status) || prev.status, location: (redirectResponse && redirectResponse.headers && redirectResponse.headers.Location) || '' });
    prev.url = request.url;
    prev.method = request.method;
    prev.type = type || prev.type;
    if (initiator) prev.initiator = trimInitiator(initiator);
    prev.requestHeaders = request.headers || {};
    prev.postData = request.postData != null ? request.postData : prev.postData;
    prev.startedAt = timestamp;
    if (wallTime) prev.time = new Date(wallTime * 1000).toISOString();
    prev.status = 0;
    prev.statusText = '';
    prev.body = null;
    prev.bodyBase64 = false;
    prev.bodyError = null;
    queueBatch(tab, 'update', summarize(prev));
    recorder.onRequest(tab, prev, true);
    return;
  }
  const extra = tab.pendingExtra.get(requestId);
  tab.pendingExtra.delete(requestId);
  const rec = {
    id: ++tab.seq, cdpId: requestId, method: request.method, url: request.url,
    type: type || '', time: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
    startedAt: timestamp, requestHeaders: request.headers || {},
    requestHeadersRaw: extra ? extra.headers || null : null,
    postData: request.postData != null ? request.postData : null,
    initiator: initiator ? trimInitiator(initiator) : null,
    status: 0, statusText: '', responseHeaders: null, responseHeadersRaw: null,
    mime: '', encodedDataLength: 0, duration: null,
    body: null, bodyBase64: false, bodyError: null, failed: null,
    remoteIP: '', protocol: '', redirects: [], note: '',
    star: false, comment: '',
  };
  tab.byId.set(requestId, rec);
  tab.records.push(rec);
  if (tab.records.length > MAX_RECORDS) {
    const gone = tab.records.shift();
    tab.byId.delete(gone.cdpId);
    queueBatch(tab, 'drop', gone.id);
  }
  queueBatch(tab, 'record', summarize(rec));
  recorder.onRequest(tab, rec);
}

function onResponseReceived(tab, ev) {
  const rec = tab.byId.get(ev.requestId);
  if (!rec) return;
  rec.status = ev.response.status;
  rec.statusText = ev.response.statusText;
  rec.responseHeaders = ev.response.headers || null;
  rec.mime = ev.response.mimeType || '';
  rec.remoteIP = ev.response.remoteIPAddress || '';
  rec.protocol = ev.response.protocol || '';
  rec.timing = ev.response.timing || null;
  if (!rec.type && ev.type) rec.type = ev.type;
  queueBatch(tab, 'update', summarize(rec));
  recorder.onResponse(tab, rec);
}

function onResponseExtraInfo(tab, ev) {
  const rec = tab.byId.get(ev.requestId);
  if (!rec) return;
  if (ev.headers) rec.responseHeadersRaw = ev.headers;   // 原始头，含 Set-Cookie（详情按需读，不必推给面板）
  // 同一请求会来两条 extraInfo，只有状态真的变了才推：省一半 IPC 与面板绘制
  if (ev.statusCode && rec.status !== ev.statusCode) {
    rec.status = ev.statusCode;
    queueBatch(tab, 'update', summarize(rec));
  }
}

/* -------------------------------------------------------------- Mock 改写 */

// 命中计数（改规则 / 开关即清零，与规则落盘同一语义）与正则缓存
const mockHits = new Map();
let mockOn = false;
let mockRe = new Map();

// 开关 / 规则变化：给所有标签挂上或摘掉 CDP Fetch 域，并清空命中计数
async function syncMock() {
  const m = settings.values.mock;
  mockOn = !!(m && m.on);
  mockRe = new Map();
  mockHits.clear();
  // 关键：Mock 期间必须摘掉 webRequest 拦截器，否则 Electron 会丢掉 fulfil 的状态码与响应头
  if (mockOn) settings.unregisterBlocker();
  else settings.registerBlocker();
  for (const t of state.tabs || []) {
    try {
      if (mockOn) {
        await t.wc.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        await t.wc.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });   // 关缓存：命中缓存的请求不经 Fetch 域
      } else {
        await t.wc.debugger.sendCommand('Fetch.disable');
        await t.wc.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: false });
      }
    } catch (e) { /* 标签已销毁 / 调试器未挂：忽略 */ }
  }
  return { ok: true };
}

function mockState() { return { on: mockOn, hits: Object.fromEntries(mockHits) }; }

// 规则顺序即优先级：第一条「启用且正则命中」的规则生效
function findMockRule(url) {
  for (const r of settings.values.mock.rules) {
    if (!r.on || !r.urlRe) continue;
    let re = mockRe.get(r.urlRe);
    if (!re) {
      try { re = new RegExp(r.urlRe); } catch (e) { continue; }
      mockRe.set(r.urlRe, re);
    }
    if (re.test(url)) return r;
  }
  return null;
}

// 每个被暂停的请求都必须有下文：命中就本地应答，否则原样放行（阻断 / 限速由 webRequest 那层继续管）
function onRequestPaused(tab, p) {
  const dbg = tab.wc.debugger;
  const url = (p.request && p.request.url) || '';
  const rule = mockOn ? findMockRule(url) : null;
  if (!rule) return dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  mockHits.set(rule.id, (mockHits.get(rule.id) || 0) + 1);
  const parsed = format.parseHeaderLines(rule.headers);
  const responseHeaders = parsed.ok
    ? Object.entries(parsed.value).filter(([k]) => k.toLowerCase() !== 'content-length').map(([name, value]) => ({ name, value }))
    : [];
  const body = rule.bodyBase64 ? rule.body : Buffer.from(rule.body, 'utf8').toString('base64');
  return dbg.sendCommand('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: rule.status, responseHeaders, body })
    .catch((e) => {
      logger.log('mock', `本地应答失败（规则 ${rule.id}）：${e.message}`);
      return dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    });
}

/* ---------------------------------------------------------- 面板推送批处理 */

// 面板推送合并成 100ms 一批：繁忙页面每秒上千条事件时，IPC 消息与 DOM 重画都不再随事件数抖动。
// 顺序：records → updates → drops → ws（渲染端按同样顺序应用，已 drop 的更新不会复活行）。
const BATCH_MS = 100;
let batchTimer = null;
let batch = null;              // { records: [], updates: Map, drops: [], ws: [] }

// 后台标签的抓包事件不推给面板（切回标签时由 cap:list 全量同步）
function queueBatch(tab, kind, payload) {
  if (tab !== state.activeTab) return;
  if (!batch) {
    batch = { records: [], updates: new Map(), drops: [], ws: [] };
    batchTimer = setTimeout(flushBatch, BATCH_MS);
  }
  if (kind === 'record') batch.records.push(payload);
  else if (kind === 'update') batch.updates.set(payload.id, payload);   // 同一 id 只留最后一条
  else if (kind === 'drop') batch.drops.push(payload);
  else if (kind === 'ws') batch.ws.push(payload);
}

// 立即冲刷；discard=true 时只丢不送（清空 / 切标签：在途批次与新状态无关）
function flushBatch(discard = false) {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  const b = batch;
  batch = null;
  if (!b || discard) return;
  const payload = { records: b.records, updates: [...b.updates.values()], drops: b.drops, ws: b.ws };
  if (payload.records.length || payload.updates.length || payload.drops.length || payload.ws.length) send('cap:batch', payload);
}

async function onLoadingFinished(tab, ev) {
  const rec = tab.byId.get(ev.requestId);
  if (!rec) return;
  rec.encodedDataLength = ev.encodedDataLength || 0;
  if (typeof rec.startedAt === 'number') rec.duration = Math.round((ev.timestamp - rec.startedAt) * 1000);
  const noBody = rec.type === 'WebSocket' || rec.status === 304 || rec.status === 204 || rec.status === 0;
  if (noBody) {
    if (rec.status === 0) rec.note = '无响应体（可能被取消）';
  } else if (rec.encodedDataLength > MAX_BODY) {
    rec.bodyError = `响应体 ${(rec.encodedDataLength / 1048576).toFixed(1)}MB，超过单条 ${MAX_BODY / 1048576}MB 上限`;
  } else if (tab.storedBytes > MAX_TOTAL_BODY) {
    rec.bodyError = '已达到本次抓取总量上限（256MB），不再保存响应体';
  } else {
    try {
      const r = await tab.wc.debugger.sendCommand('Network.getResponseBody', { requestId: ev.requestId });
      rec.body = r.body;
      rec.bodyBase64 = !!r.base64Encoded;
      tab.storedBytes += r.body.length;
    } catch (e) {
      rec.bodyError = e.message;
    }
  }
  const rule = settings.values.saveRule;
  if (rec.body != null && matchSaveRule(rec, rule)) {
    if (autoSave.n >= MAX_AUTO_SAVE_FILES || autoSave.bytes >= MAX_AUTO_SAVE_BYTES) {
      if (!autoSave.blocked) {
        autoSave.blocked = `已达落盘上限（${MAX_AUTO_SAVE_FILES} 个 / ${MAX_AUTO_SAVE_BYTES / 1048576}MB）`;
        rec.note = autoSave.blocked;
      }
    } else {
      files.saveAutoBody(rec, rule.dir)
        .then((name) => {
          autoSave.n++;
          autoSave.bytes += rec.bodyBase64 ? Math.round(rec.body.length * 3 / 4) : Buffer.byteLength(rec.body);
          rec.note = `已落盘：${name}`;
          send('cap:saveRule', autoSaveState());
        })
        .catch((e) => { logger.log('save', `落盘失败：${e.message}`); })
        .finally(() => queueBatch(tab, 'update', summarize(rec)));
    }
  }
  queueBatch(tab, 'update', summarize(rec));
  recorder.onBody(tab, rec);
}

function onLoadingFailed(tab, ev) {
  const rec = tab.byId.get(ev.requestId);
  if (!rec) return;
  rec.failed = { errorText: ev.errorText, blockedReason: ev.blockedReason || '', canceled: !!ev.canceled };
  if (typeof rec.startedAt === 'number') rec.duration = Math.round((ev.timestamp - rec.startedAt) * 1000);
  queueBatch(tab, 'update', summarize(rec));
  recorder.onFail(tab, rec);
}

function pushWs(tab, frame) {
  tab.wsFrames.push(frame);
  if (tab.wsFrames.length > MAX_WS_FRAMES) tab.wsFrames.shift();
  queueBatch(tab, 'ws', frame);
  recorder.onWs(tab, frame);
}

async function attachCapture(tab) {
  const wc = tab.wc;
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    setStatus(`CDP 挂载失败：${e.message}（DevTools 打开时会冲突）`);
    return false;
  }
  dbg.on('message', (_e, method, params) => {
    switch (method) {
      case 'Network.requestWillBeSent': onRequestWillBeSent(tab, params); break;
      case 'Network.requestWillBeSentExtraInfo':
        if (params.headers) {
          const rec = tab.byId.get(params.requestId);
          if (rec) { rec.requestHeadersRaw = params.headers; queueBatch(tab, 'update', summarize(rec)); }
          else tab.pendingExtra.set(params.requestId, { headers: params.headers });
        }
        break;
      case 'Network.responseReceived': onResponseReceived(tab, params); break;
      case 'Network.responseReceivedExtraInfo': onResponseExtraInfo(tab, params); break;
      case 'Network.loadingFinished': onLoadingFinished(tab, params); break;
      case 'Network.loadingFailed': onLoadingFailed(tab, params); break;
      case 'Fetch.requestPaused': onRequestPaused(tab, params); break;
      case 'Network.webSocketCreated': pushWs(tab, { kind: 'open', requestId: params.requestId, url: params.url, time: Date.now() }); break;
      case 'Network.webSocketFrameSent': pushWs(tab, { kind: 'sent', requestId: params.requestId, opcode: params.response.opcode, payload: params.response.payloadData, time: Date.now() }); break;
      case 'Network.webSocketFrameReceived': pushWs(tab, { kind: 'recv', requestId: params.requestId, opcode: params.response.opcode, payload: params.response.payloadData, time: Date.now() }); break;
      case 'Network.webSocketClosed': pushWs(tab, { kind: 'close', requestId: params.requestId, time: Date.now() }); break;
      case 'Network.webSocketFrameError': pushWs(tab, { kind: 'error', requestId: params.requestId, error: params.errorMessage, time: Date.now() }); break;
      case 'Runtime.bindingCalled':
        if (params.name === recorder.BINDING) recorder.onBinding(tab, params);
        else if (params.name === picker.BINDING) picker.onBinding(params);
        break;
      default: break;
    }
  });
  dbg.on('detach', () => setStatus('CDP 已断开，抓取停止'));
  try {
    await dbg.sendCommand('Network.enable', {
      maxTotalBufferSize: 512 * 1024 * 1024,
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxPostDataSize: 16 * 1024 * 1024,
    });
    await dbg.sendCommand('Page.enable');    // Page.captureScreenshot / getLayoutMetrics 需要
    if (settings.values.mock.on) {           // Mock 开着时新标签也要挂 Fetch 域，否则新标签不生效
      await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await dbg.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
    }
  } catch (e) {
    setStatus(`Network.enable 失败：${e.message}`);
    return false;
  }
  setStatus('抓取中');
  return true;
}

/* -------------------------------------------------------------- 请求重放 */

const REPLAY_MAX_BODY = 1024 * 1024;
const REPLAY_TIMEOUT = 30000;

function replay(id, overrides = {}) {
  return new Promise((resolve) => {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return resolve({ ok: false, error: '记录不存在' });
    const o = overrides || {};
    const method = o.method ? String(o.method).trim().toUpperCase() : rec.method;
    const url = normalizeUrl(o.url ? o.url : rec.url);
    if (!url) return resolve({ ok: false, error: 'URL 无效' });
    const headers = {};
    for (const h of format.requestHeaderList(rec)) {
      const lk = h.name.toLowerCase();
      if (lk === 'content-length' || lk === 'host') continue;   // 由 net 层重新计算
      headers[h.name] = h.value;
    }
    if (typeof o.headers === 'string' && o.headers.trim()) {
      const p = format.parseHeaderLines(o.headers);
      if (!p.ok) return resolve({ ok: false, error: p.error });
      for (const [k, v] of Object.entries(p.value)) {
        for (const kk of Object.keys(headers)) if (kk.toLowerCase() === k.toLowerCase()) delete headers[kk];   // 大小写不敏感覆盖
        headers[k] = v;
      }
    }
    const body = o.body !== undefined ? String(o.body == null ? '' : o.body) : (rec.postData || '');
    const t0 = Date.now();
    let req;
    try {
      req = net.request({
        method, url, redirect: 'follow',
        session: session.fromPartition(PARTITION), headers,
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { req.abort(); } catch (e) { /* 已结束 */ }
      done({ ok: false, error: `重放超时（${REPLAY_TIMEOUT / 1000}s）` });
    }, REPLAY_TIMEOUT);

    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c) => {
        size += c.length;
        if (size <= REPLAY_MAX_BODY) chunks.push(c);
        else truncated = true;
      });
      res.on('end', () => done({
        ok: true, status: res.statusCode, statusText: res.statusMessage || '',
        headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
        truncated, tookMs: Date.now() - t0,
        sent: { method, url, headers, body },
      }));
      res.on('error', (e) => done({ ok: false, error: e.message }));
    });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

// 旁路事件（下载完成等）：给活动标签里匹配 url 的记录补一条 note 并推给面板
function markNote(url, note) {
  const tab = state.activeTab;
  if (!tab) return false;
  const rec = [...tab.records].reverse().find((r) => r.url === url && !r.note);
  if (!rec) return false;
  rec.note = String(note).slice(0, 200);
  queueBatch(tab, 'update', summarize(rec));
  return true;
}

module.exports = { summarize, fullRecord, attachCapture, replay, flushBatch, markNote, resetAutoSave, autoSaveState, matchSaveRule, syncMock, mockState };
