'use strict';
/*
 * CDP 抓取：把 WebContentsView/BrowserView 的调试器挂上，把 Network.* 事件转成记录。
 */
const { net, session } = require('electron');
const { state, send, setStatus, PARTITION, MAX_RECORDS, MAX_BODY, MAX_TOTAL_BODY, MAX_WS_FRAMES } = require('./state');
const settings = require('./settings');
const format = require('./format');

function summarize(r) {
  return {
    id: r.id, method: r.method, url: r.url, type: r.type, time: r.time,
    status: r.status, statusText: r.statusText, mime: r.mime,
    size: r.encodedDataLength || 0, duration: r.duration,
    failed: r.failed, hasBody: r.body !== null, note: r.note,
    redirects: r.redirects.length,
  };
}

function fullRecord(r) {
  return {
    id: r.id, method: r.method, url: r.url, type: r.type, time: r.time,
    status: r.status, statusText: r.statusText, mime: r.mime,
    remoteIP: r.remoteIP, protocol: r.protocol,
    requestHeaders: r.requestHeaders, requestHeadersRaw: r.requestHeadersRaw, postData: r.postData,
    responseHeaders: r.responseHeaders, responseHeadersRaw: r.responseHeadersRaw,
    redirects: r.redirects, failed: r.failed,
    encodedDataLength: r.encodedDataLength, durationMs: r.duration,
    bodyBase64: r.bodyBase64, bodyError: r.bodyError, body: r.body,
  };
}

function onRequestWillBeSent(ev) {
  const { requestId, request, timestamp, wallTime, type, redirectResponse } = ev;
  if (!state.enabled) return;
  if (settings.values.recordOnly && type !== 'XHR' && type !== 'Fetch') return;
  const prev = state.byId.get(requestId);
  if (prev) {
    // 同一 requestId 复用 = 重定向：记录上一跳，就地更新为最终目标
    prev.redirects.push({ url: prev.url, status: (redirectResponse && redirectResponse.status) || prev.status, location: (redirectResponse && redirectResponse.headers && redirectResponse.headers.Location) || '' });
    prev.url = request.url;
    prev.method = request.method;
    prev.type = type || prev.type;
    prev.requestHeaders = request.headers || {};
    prev.postData = request.postData != null ? request.postData : prev.postData;
    prev.startedAt = timestamp;
    if (wallTime) prev.time = new Date(wallTime * 1000).toISOString();
    prev.status = 0;
    prev.statusText = '';
    prev.body = null;
    prev.bodyBase64 = false;
    prev.bodyError = null;
    send('cap:update', summarize(prev));
    return;
  }
  const extra = state.pendingExtra.get(requestId);
  state.pendingExtra.delete(requestId);
  const rec = {
    id: ++state.seq, cdpId: requestId, method: request.method, url: request.url,
    type: type || '', time: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
    startedAt: timestamp, requestHeaders: request.headers || {},
    requestHeadersRaw: extra ? extra.headers || null : null,
    postData: request.postData != null ? request.postData : null,
    status: 0, statusText: '', responseHeaders: null, responseHeadersRaw: null,
    mime: '', encodedDataLength: 0, duration: null,
    body: null, bodyBase64: false, bodyError: null, failed: null,
    remoteIP: '', protocol: '', redirects: [], note: '',
  };
  state.byId.set(requestId, rec);
  state.records.push(rec);
  if (state.records.length > MAX_RECORDS) {
    const gone = state.records.shift();
    state.byId.delete(gone.cdpId);
    send('cap:drop', gone.id);
  }
  send('cap:record', summarize(rec));
}

function onResponseReceived(ev) {
  const rec = state.byId.get(ev.requestId);
  if (!rec) return;
  rec.status = ev.response.status;
  rec.statusText = ev.response.statusText;
  rec.responseHeaders = ev.response.headers || null;
  rec.mime = ev.response.mimeType || '';
  rec.remoteIP = ev.response.remoteIPAddress || '';
  rec.protocol = ev.response.protocol || '';
  if (!rec.type && ev.type) rec.type = ev.type;
  send('cap:update', summarize(rec));
}

function onResponseExtraInfo(ev) {
  const rec = state.byId.get(ev.requestId);
  if (!rec) return;
  if (ev.headers) rec.responseHeadersRaw = ev.headers;   // 原始头，含 Set-Cookie
  if (ev.statusCode) rec.status = ev.statusCode;
  send('cap:update', summarize(rec));
}

async function onLoadingFinished(ev) {
  const rec = state.byId.get(ev.requestId);
  if (!rec) return;
  rec.encodedDataLength = ev.encodedDataLength || 0;
  if (typeof rec.startedAt === 'number') rec.duration = Math.round((ev.timestamp - rec.startedAt) * 1000);
  const noBody = rec.type === 'WebSocket' || rec.status === 304 || rec.status === 204 || rec.status === 0;
  if (noBody) {
    if (rec.status === 0) rec.note = '无响应体（可能被取消）';
  } else if (rec.encodedDataLength > MAX_BODY) {
    rec.bodyError = `响应体 ${(rec.encodedDataLength / 1048576).toFixed(1)}MB，超过单条 ${MAX_BODY / 1048576}MB 上限`;
  } else if (state.storedBytes > MAX_TOTAL_BODY) {
    rec.bodyError = '已达到本次抓取总量上限（256MB），不再保存响应体';
  } else {
    try {
      const r = await state.view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: ev.requestId });
      rec.body = r.body;
      rec.bodyBase64 = !!r.base64Encoded;
      state.storedBytes += r.body.length;
    } catch (e) {
      rec.bodyError = e.message;
    }
  }
  send('cap:update', summarize(rec));
}

function onLoadingFailed(ev) {
  const rec = state.byId.get(ev.requestId);
  if (!rec) return;
  rec.failed = { errorText: ev.errorText, blockedReason: ev.blockedReason || '', canceled: !!ev.canceled };
  if (typeof rec.startedAt === 'number') rec.duration = Math.round((ev.timestamp - rec.startedAt) * 1000);
  send('cap:update', summarize(rec));
}

function pushWs(frame) {
  state.wsFrames.push(frame);
  if (state.wsFrames.length > MAX_WS_FRAMES) state.wsFrames.shift();
  send('cap:ws', frame);
}

async function attachCapture(wc) {
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    setStatus(`CDP 挂载失败：${e.message}（DevTools 打开时会冲突）`);
    return false;
  }
  dbg.on('message', (_e, method, params) => {
    switch (method) {
      case 'Network.requestWillBeSent': onRequestWillBeSent(params); break;
      case 'Network.requestWillBeSentExtraInfo':
        if (params.headers) {
          const rec = state.byId.get(params.requestId);
          if (rec) { rec.requestHeadersRaw = params.headers; send('cap:update', summarize(rec)); }
          else state.pendingExtra.set(params.requestId, { headers: params.headers });
        }
        break;
      case 'Network.responseReceived': onResponseReceived(params); break;
      case 'Network.responseReceivedExtraInfo': onResponseExtraInfo(params); break;
      case 'Network.loadingFinished': onLoadingFinished(params); break;
      case 'Network.loadingFailed': onLoadingFailed(params); break;
      case 'Network.webSocketCreated': pushWs({ kind: 'open', requestId: params.requestId, url: params.url, time: Date.now() }); break;
      case 'Network.webSocketFrameSent': pushWs({ kind: 'sent', requestId: params.requestId, opcode: params.response.opcode, payload: params.response.payloadData, time: Date.now() }); break;
      case 'Network.webSocketFrameReceived': pushWs({ kind: 'recv', requestId: params.requestId, opcode: params.response.opcode, payload: params.response.payloadData, time: Date.now() }); break;
      case 'Network.webSocketClosed': pushWs({ kind: 'close', requestId: params.requestId, time: Date.now() }); break;
      case 'Network.webSocketFrameError': pushWs({ kind: 'error', requestId: params.requestId, error: params.errorMessage, time: Date.now() }); break;
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

function replay(id) {
  return new Promise((resolve) => {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return resolve({ ok: false, error: '记录不存在' });
    const headers = {};
    for (const h of format.requestHeaderList(rec)) {
      const lk = h.name.toLowerCase();
      if (lk === 'content-length' || lk === 'host') continue;   // 由 net 层重新计算
      headers[h.name] = h.value;
    }
    const t0 = Date.now();
    let req;
    try {
      req = net.request({
        method: rec.method, url: rec.url, redirect: 'follow',
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
      }));
      res.on('error', (e) => done({ ok: false, error: e.message }));
    });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    if (rec.postData) req.write(rec.postData);
    req.end();
  });
}

module.exports = {
  summarize, fullRecord, attachCapture, replay,
  onRequestWillBeSent, onResponseReceived, onResponseExtraInfo, onLoadingFinished, onLoadingFailed, pushWs,
};
