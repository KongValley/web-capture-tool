'use strict';
/*
 * 共享状态与常量。所有模块只通过本文件读写共享状态，禁止反向依赖 main.js（避免循环 require）。
 */
const PARTITION = 'persist:capture';   // 持久分区：Cookie / localStorage 跨重启保留
const TOOLBAR_H = 124;                 // 三行工具栏总高（44 + 40 + 40），必须与 index.html 的 #body 高度一致
const MAX_RECORDS = 5000;
const MAX_BODY = 32 * 1024 * 1024;         // 单条响应体上限
const MAX_TOTAL_BODY = 256 * 1024 * 1024;  // 全部响应体总量上限
const MAX_WS_FRAMES = 2000;

const state = {
  win: null,
  view: null,
  panelWidth: 520,
  enabled: true,
  status: '初始化中',
  records: [],                 // 时间顺序
  byId: new Map(),             // cdp requestId -> record
  pendingExtra: new Map(),     // requestWillBeSentExtraInfo 可能早于 requestWillBeSent
  wsFrames: [],
  seq: 0,
  storedBytes: 0,
  defaultUA: '',               // 视图创建后立刻填入，用于 UA 复位
  softwareMode: false,         // 是否运行在软件渲染（无显卡/强制）模式
  gpuCrashes: 0,               // GPU 进程异常退出次数
  auto: { running: false, stop: false },
  selftest: process.argv.includes('--selftest'),
};

function send(channel, payload) {
  const { win } = state;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(text) {
  state.status = text;
  send('cap:status', text);
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|file):/i.test(s)) return s;
  return `https://${s}`;
}

module.exports = {
  PARTITION, TOOLBAR_H, MAX_RECORDS, MAX_BODY, MAX_TOTAL_BODY, MAX_WS_FRAMES,
  state, send, setStatus, normalizeUrl,
};
