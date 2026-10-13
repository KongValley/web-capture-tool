'use strict';
/*
 * 会话持久化：<userData>/sessions/last.json
 * 定时/退出时把最近的抓包记录写盘，下次启动由面板一键恢复。
 * 依赖：electron 的 app、node 内置模块、state/capture/logger。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { state } = require('./state');
const capture = require('./capture');
const logger = require('./logger');

const VERSION = 1;
const MAX_RECORDS = 2000;                 // 落盘条数上限
const MAX_BYTES = 64 * 1024 * 1024;       // 落盘响应体总量上限
const MAX_WS = 500;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;  // 超过 7 天的会话不可恢复
const SAVE_INTERVAL_MS = 30000;

let overrideFile = null;
let file = null;
let timer = null;
let lastCount = -1;

function filePath() {
  return file || overrideFile || path.join(app.getPath('userData'), 'sessions', 'last.json');
}

// 自检用：改道到临时路径并删掉旧文件
function useFile(p) {
  overrideFile = p;
  file = p;
  try { fs.rmSync(p, { force: true }); } catch (e) { /* 没有旧文件 */ }
  return p;
}

function snapshot() {
  const records = state.records.slice(-MAX_RECORDS).map(capture.fullRecord);
  let bytes = 0;
  for (let i = records.length - 1; i >= 0; i--) {     // 从最新往旧累计，超出上限的旧记录省略响应体
    const r = records[i];
    if (r.body == null) continue;
    bytes += r.body.length;
    if (bytes > MAX_BYTES) {
      r.body = null;
      r.bodyBase64 = false;
      r.bodyError = '会话恢复时省略（超出体积上限）';
    }
  }
  return {
    version: VERSION,
    savedAt: new Date().toISOString(),
    url: state.view && !state.view.webContents.isDestroyed() ? state.view.webContents.getURL() : '',
    title: state.view && !state.view.webContents.isDestroyed() ? state.view.webContents.getTitle() : '',
    records,
    wsFrames: state.wsFrames.slice(-MAX_WS),
  };
}

async function save() {
  try {
    const data = snapshot();
    const p = filePath();
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, JSON.stringify(data));
    lastCount = data.records.length;
    return { ok: true, file: p, count: data.records.length };
  } catch (e) {
    logger.log('session', `保存失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

// 退出路径用：同步写，进程随时可能消失
function saveSync() {
  try {
    const data = snapshot();
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
    lastCount = data.records.length;
    return { ok: true, file: p, count: data.records.length };
  } catch (e) {
    logger.log('session', `保存失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

// fullRecord 的字段（durationMs）映射回进程内记录（duration），恢复后所有链路都能直接用
function toInternal(f) {
  return {
    id: f.id, cdpId: null, method: f.method, url: f.url, type: f.type || '', time: f.time,
    startedAt: null,
    requestHeaders: f.requestHeaders || {}, requestHeadersRaw: f.requestHeadersRaw || null,
    postData: f.postData != null ? f.postData : null,
    status: f.status || 0, statusText: f.statusText || '',
    responseHeaders: f.responseHeaders || null, responseHeadersRaw: f.responseHeadersRaw || null,
    mime: f.mime || '', encodedDataLength: f.encodedDataLength || 0,
    duration: f.durationMs == null ? null : f.durationMs,
    body: f.body === undefined ? null : f.body, bodyBase64: !!f.bodyBase64,
    bodyError: f.bodyError || null, failed: f.failed || null,
    remoteIP: f.remoteIP || '', protocol: f.protocol || '', redirects: f.redirects || [], note: f.note || '',
  };
}

function load() {
  const p = filePath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, error: '没有可恢复的会话' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    try { fs.rmSync(p, { force: true }); } catch (e2) { /* 删不掉就留着 */ }
    return { ok: false, error: `会话文件损坏，已删除：${e.message}` };
  }
  const savedAt = Date.parse(data && data.savedAt ? data.savedAt : '');
  if (!Number.isFinite(savedAt) || Date.now() - savedAt > MAX_AGE_MS) {
    return { ok: false, error: '上次会话已过期（超过 7 天）' };
  }
  const raw = Array.isArray(data.records) ? data.records : [];
  return {
    ok: true,
    savedAt: data.savedAt,
    url: data.url || '',
    title: data.title || '',
    records: raw.map(toInternal),
    wsFrames: Array.isArray(data.wsFrames) ? data.wsFrames : [],
    count: raw.length,
  };
}

function info() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const records = Array.isArray(data.records) ? data.records : [];
    return { exists: true, savedAt: data.savedAt || '', count: records.length, url: data.url || '' };
  } catch (e) {
    return { exists: false, savedAt: '', count: 0, url: '' };
  }
}

function discard() {
  try { fs.rmSync(filePath(), { force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

// 只在记录条数变化时写盘；自检不启动定时器（自己调 save/load）
function start() {
  stop();
  timer = setInterval(() => {
    if (state.records.length === lastCount) return;
    lastCount = state.records.length;
    save();
  }, SAVE_INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  VERSION, MAX_RECORDS, MAX_BYTES, MAX_WS, MAX_AGE_MS,
  filePath, useFile, snapshot, save, saveSync, load, info, discard, start, stop,
};
