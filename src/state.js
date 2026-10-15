'use strict';
/*
 * 共享状态与常量。所有模块只通过本文件读写共享状态，禁止反向依赖 main.js（避免循环 require）。
 */
const PARTITION = 'persist:capture';   // 持久分区：Cookie / localStorage 跨重启保留
const TOOLBAR_H = 164;                 // 四行工具栏的初始总高（44 + 40 + 40 + 40）；工具栏会按窗口宽度换行，
                                       // 真实高度由面板量出后经 cap:toolbarH 写回 state.toolbarH（见 ui/renderer.js）
const MAX_RECORDS = 5000;
const MAX_BODY = 32 * 1024 * 1024;         // 单条响应体上限
const MAX_TOTAL_BODY = 256 * 1024 * 1024;  // 全部响应体总量上限
const MAX_WS_FRAMES = 2000;

const state = {
  win: null,
  view: null,                  // 活动标签的 BrowserView（镜像字段，既有代码直接用）
  panelWidth: 520,
  toolbarH: TOOLBAR_H,         // 工具栏实际占用高度（面板换行后上报，原生视图的 y 起点）
  enabled: true,
  status: '初始化中',
  records: [],                 // 活动标签的记录（镜像）
  byId: new Map(),             // cdp requestId -> record（镜像）
  wsFrames: [],                // 镜像
  seq: 0,                      // 镜像
  storedBytes: 0,              // 镜像
  // 多标签：每个标签持有自己的抓取状态；上面这些字段是「活动标签的镜像」，
  // 由 syncActive() 维护，其它模块零改动。
  tabs: [],
  activeTab: null,
  defaultUA: '',               // 视图创建后立刻填入，用于 UA 复位
  softwareMode: false,         // 是否运行在软件渲染（无显卡/强制）模式
  gpuCrashes: 0,               // GPU 进程异常退出次数
  auto: { running: false, stop: false },
  snaps: [],                   // 抓包快照（本次运行内存，最多 2 个；不落盘，不与会话恢复抢语义）
  selftest: process.argv.includes('--selftest'),
  bench: process.argv.includes('--bench'),   // 性能基准：同样的临时配置改道，测完打印数字退出
  shots: process.argv.includes('--shots'),   // 手册截图：同样改道临时配置，驱动窗口截屏到 docs/img/
};

// 把活动标签的状态同步到镜像字段；传入 tab 时先把该标签设为活动
function syncActive(tab) {
  if (tab) state.activeTab = tab;
  const t = state.activeTab;
  if (!t) {
    state.records = [];
    state.byId = new Map();
    state.wsFrames = [];
    state.seq = 0;
    state.storedBytes = 0;
    state.view = null;
    return state;
  }
  state.records = t.records;
  state.byId = t.byId;
  state.wsFrames = t.wsFrames;
  state.seq = t.seq;
  state.storedBytes = t.storedBytes;
  state.enabled = t.enabled;
  state.view = t.view;
  return state;
}

function send(channel, payload) {
  const { win } = state;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 清空活动标签的抓包状态（面板「清空」按钮），镜像同步更新
function resetActive() {
  const t = state.activeTab;
  if (!t) return state;
  t.records.length = 0;
  t.byId.clear();
  t.wsFrames.length = 0;
  // seq 不清零：记录编号必须单调不回退，否则新记录会与面板/详情里残留的旧 id 撞号
  t.storedBytes = 0;
  return syncActive();
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

const WINDOW_DEFAULTS = { width: 1440, height: 900, minWidth: 900, minHeight: 600 };  // 首启/缺省窗口参数
// 合并启动窗口参数：保存的尺寸与位置优先（x/y 必须是有限数才采纳，null 交给系统），其余用缺省值
function windowInitOptions(saved) {
  const w = saved && typeof saved === 'object' ? saved : {};
  const out = Object.assign({}, WINDOW_DEFAULTS);
  if (Number.isFinite(w.width)) out.width = Math.round(w.width);
  if (Number.isFinite(w.height)) out.height = Math.round(w.height);
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) { out.x = Math.round(w.x); out.y = Math.round(w.y); }
  return out;
}

module.exports = {
  PARTITION, TOOLBAR_H, MAX_RECORDS, MAX_BODY, MAX_TOTAL_BODY, MAX_WS_FRAMES,
  state, send, setStatus, normalizeUrl, syncActive, resetActive, windowInitOptions, WINDOW_DEFAULTS,
};
