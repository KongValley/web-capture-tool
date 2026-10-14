'use strict';
/*
 * 设置持久化：<userData>/settings.json
 * 只依赖 electron 的 app 与 node 内置模块，不依赖任何其它项目模块（避免循环）。
 *
 * 读：readFile 是纯函数（不碰模块状态），坏文件改名保留、未知键丢弃、缺字段回默认。
 * 写：300ms 防抖 + 临时文件原子替换；任何异常只记录，绝不抛出、绝不静默丢文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const VERSION = 1;

const DEFAULTS = {
  version: VERSION,
  settings: {
    blockMode: 'none', blockKeywords: '', recordOnly: false,
    throttle: 'off', ua: '', headers: '', proxy: '',
    colSet: 'd', reqDelay: 0, ignoreCertErrors: false, authUser: '', authPass: '',
    recShots: false,
    sortBy: 'time',                                   // 列表排序 / 分组：time | domain | size | duration | status
    tasks: [],                                        // 提取任务预设（最多 20 条，见 settings.applyInner）
    saveRule: { on: false, urlRe: '', mimes: '', types: 'all', dir: '' },   // 响应体落盘规则
    mock: { on: false, rules: [] },                                         // Mock：URL 规则 → 本地响应
  },
  app: { softwareRendering: false, panelWidth: 520, window: { width: 1440, height: 900, x: null, y: null } },
};

let overrideFile = null;
let file = null;
let data = null;
let saveTimer = null;
let lastError = '';

const defaults = () => JSON.parse(JSON.stringify(DEFAULTS));
const filePath = () => file || overrideFile || path.join(app.getPath('userData'), 'settings.json');

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

function normalizeWindow(w) {
  const d = DEFAULTS.app.window;
  if (!w || typeof w !== 'object') return { width: d.width, height: d.height, x: null, y: null };
  return {
    width: clampInt(w.width, 900, 10000, d.width),
    height: clampInt(w.height, 600, 10000, d.height),
    x: Number.isFinite(Number(w.x)) ? Math.round(Number(w.x)) : null,
    y: Number.isFinite(Number(w.y)) ? Math.round(Number(w.y)) : null,
  };
}

// 只保留 DEFAULTS 里已有的键，未知键一律丢弃
function normalize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;

  const s = raw.settings;
  if (s && typeof s === 'object') {
    for (const k of Object.keys(out.settings)) if (s[k] !== undefined) out.settings[k] = s[k];
    out.settings.recordOnly = !!out.settings.recordOnly;
    out.settings.ignoreCertErrors = !!out.settings.ignoreCertErrors;
    out.settings.recShots = !!out.settings.recShots;
    out.settings.reqDelay = clampInt(out.settings.reqDelay, 0, 10000, 0);
    for (const k of ['blockMode', 'blockKeywords', 'throttle', 'ua', 'headers', 'proxy', 'authUser', 'authPass']) {
      out.settings[k] = String(out.settings[k] == null ? '' : out.settings[k]);
    }
    if (!['none', 'assets', 'keywords'].includes(out.settings.blockMode)) out.settings.blockMode = 'none';
    if (!['off', '3g', 'slow'].includes(out.settings.throttle)) out.settings.throttle = 'off';
    if (!['d', 'dt', 't'].includes(out.settings.colSet)) out.settings.colSet = 'd';
    if (!['time', 'domain', 'size', 'duration', 'status'].includes(out.settings.sortBy)) out.settings.sortBy = 'time';
    if (!Array.isArray(out.settings.tasks)) out.settings.tasks = [];
    if (!out.settings.saveRule || typeof out.settings.saveRule !== 'object') out.settings.saveRule = defaults().settings.saveRule;
    if (!out.settings.mock || typeof out.settings.mock !== 'object' || !Array.isArray(out.settings.mock.rules)) out.settings.mock = defaults().settings.mock;
  }

  const a = raw.app;
  if (a && typeof a === 'object') {
    if (typeof a.softwareRendering === 'boolean') out.app.softwareRendering = a.softwareRendering;
    out.app.panelWidth = clampInt(a.panelWidth, 320, 1000, DEFAULTS.app.panelWidth);
    out.app.window = normalizeWindow(a.window);
  }
  return out;
}

// 纯函数：读任意路径并规范化，不修改模块状态
function readFile(p) {
  const res = { data: defaults(), error: '', badFile: '' };
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') res.error = e.message;   // 文件不存在属于首次运行的正常情况
    return res;
  }
  try {
    res.data = normalize(JSON.parse(text));
  } catch (e) {
    res.error = `配置损坏：${e.message}`;
    const bad = p.replace(/\.json$/i, '') + `.bad-${Date.now()}.json`;
    try {
      fs.renameSync(p, bad);
      res.badFile = bad;
    } catch (e2) {
      res.error += `；改名失败：${e2.message}`;
    }
  }
  return res;
}

// 自检用：改道到临时文件，且保证从默认值开始（必须在 load() 之前调用）
function useFile(p) {
  overrideFile = p;
  file = p;
  data = null;
  try { fs.rmSync(p, { force: true }); } catch (e) { /* 删不掉就按现状读，normalize 会兜住 */ }
  return p;
}

function load() {
  file = overrideFile || path.join(app.getPath('userData'), 'settings.json');
  const r = readFile(file);
  data = r.data;
  lastError = r.error;
  if (r.error) console.error('[store] 读取配置：', r.error);
  return data;
}

function get() {
  if (!data) load();
  return data;
}

// 只拷贝已知键；调用方传的是 settings.values 本体
function setSettings(values) {
  const d = get();
  if (!values || typeof values !== 'object') return d.settings;
  for (const k of Object.keys(d.settings)) if (values[k] !== undefined) d.settings[k] = values[k];
  return d.settings;
}

function setApp(key, value) {
  const d = get();
  if (key === 'softwareRendering') d.app.softwareRendering = !!value;
  else if (key === 'panelWidth') d.app.panelWidth = clampInt(value, 320, 1000, DEFAULTS.app.panelWidth);
  else if (key === 'window') d.app.window = normalizeWindow(value);
  else throw new Error(`未知的 app 配置项：${key}`);
  return d.app;
}

function writeNow() {
  try {
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(get(), null, 2), 'utf8');
    fs.renameSync(tmp, p);
    lastError = '';
    return { ok: true, file: p };
  } catch (e) {
    lastError = e.message;
    console.error('[store] 写入设置失败：', e.message);
    return { ok: false, error: e.message };
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 300);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return writeNow();
}

module.exports = {
  VERSION, DEFAULTS,
  useFile, filePath, readFile, load, get, setSettings, setApp, save, flush, writeNow,
  error: () => lastError,
};
