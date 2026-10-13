'use strict';
/*
 * 网页抓取工具 — 主进程装配层
 *
 * 架构：
 *   BrowserWindow
 *     ├── BrowserView      → 真实浏览器视图，加载目标网页（分区 persist:capture，登录态可持久化）
 *     └── 面板窗口本身      → 本地可信 UI（工具栏 + 请求列表 + 详情），永不加载远程内容
 *
 * 抓取：Chrome DevTools Protocol（wc.debugger）挂在视图上，
 *       Network.* 事件拿全部请求/响应头/响应体/重定向/失败；Runtime.evaluate 取页面数据。
 *       CDP 不受页面 CSP 限制，且不需要在页面里注入脚本。
 *
 * 模块：state.js 共享状态 / capture.js 抓取 / extract.js 页面提取 / 其余见各文件头。
 * 依赖方向单向：所有模块 require('./state')，禁止任何模块 require main.js。
 */
const { app, BrowserWindow, BrowserView, ipcMain, session, screen, shell, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { PARTITION, TOOLBAR_H, state, send, setStatus, normalizeUrl, syncActive, resetActive } = require('./state');
const store = require('./store');
const logger = require('./logger');
const sessionStore = require('./session');
const gpu = require('./gpu');
const capture = require('./capture');
const extract = require('./extract');
const settings = require('./settings');
const automation = require('./automation');
const format = require('./format');
const files = require('./files');
const recorder = require('./recorder');
const picker = require('./picker');

const ICON = path.join(__dirname, 'build', 'icon.ico');
if (process.platform === 'win32') app.setAppUserModelId('com.kongvalley.web-capture-tool');

// 自检改道到临时配置，绝不碰用户真实配置；随后同步读盘（后续默认值都从这里取）
if (state.selftest) {
  store.useFile(path.join(os.tmpdir(), 'wct-selftest-settings', 'settings.json'));
  logger.useFile(path.join(os.tmpdir(), 'wct-selftest-logs', 'app.log'));
  sessionStore.useFile(path.join(os.tmpdir(), 'wct-selftest-session', 'last.json'));
  recorder.useDir(path.join(os.tmpdir(), 'wct-selftest-rec'));
}
const boot = store.load();
state.panelWidth = boot.app.panelWidth;

/* ------------------------------------------------------- 异常兜底与日志 */

// 未捕获异常一律记日志并提示，不退出进程（抓取任务不应因一次异常整体崩掉）
process.on('uncaughtException', (e) => {
  logger.log('fatal', (e && e.stack) || String(e));
  setStatus(`内部错误：${(e && e.message) || e}（详见日志）`);
});
process.on('unhandledRejection', (r) => logger.log('reject', (r && r.stack) || String(r)));
app.on('render-process-gone', (_e, _wc, d) => logger.log('render-gone', `${(d && d.reason) || ''} exitCode=${(d && d.exitCode) || 0}`));

// 软件渲染：必须在 app ready 之前决定（disableHardwareAcceleration 只在此阶段有效）
const forcedSoftware = process.argv.includes('--software-rendering');
state.softwareMode = !!(boot.app.softwareRendering || forcedSoftware);
if (state.softwareMode) app.disableHardwareAcceleration();

/* ------------------------------------------------------------------ 视图 */

function layout() {
  const { win, view, panelWidth } = state;
  if (!win || win.isDestroyed() || !view) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({
    x: 0, y: Math.round(TOOLBAR_H),
    width: Math.round(Math.max(120, width - panelWidth)),
    height: Math.round(Math.max(120, height - TOOLBAR_H)),
  });
}

// 恢复上次的窗口尺寸位置；位置必须与某台显示器有交集，否则忽略（显示器被拔掉的情况）
function windowOptions() {
  const w = store.get().app.window;
  const out = { width: w.width, height: w.height };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const rect = { x: w.x, y: w.y, width: w.width, height: w.height };
    const b = screen.getDisplayMatching(rect).bounds;
    const intersects = rect.x < b.x + b.width && rect.x + rect.width > b.x
      && rect.y < b.y + b.height && rect.y + rect.height > b.y;
    if (intersects) { out.x = w.x; out.y = w.y; }
  }
  return out;
}

let boundsTimer = null;
function rememberBounds() {
  const { win } = state;
  if (!win || win.isDestroyed()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    store.setApp('window', win.getBounds());
    store.save();
  }, 500);
}

/* ------------------------------------------------------------ 无显卡兜底 */

// persist=true 时写入配置（重启后固定走软件渲染）；否则只提示、由用户决定
function offerSoftware(reason, persist = true) {
  if (state.softwareMode) return;
  if (persist) {
    store.setApp('softwareRendering', true);
    store.flush();
    state.softwareMode = true;     // 避免重复提示；重启后由配置生效
  }
  send('cap:banner', {
    text: persist ? `${reason}，已切换为软件渲染（重启后生效）` : `${reason}，建议在「设置」里开启软件渲染`,
    actions: persist ? [{ id: 'restart', label: '立即重启', primary: true }] : [{ id: 'settings', label: '打开设置' }],
  });
}

// GPU 状态在启动阶段是瞬时的（刚 ready 时可能短暂报 disabled_software，随后变 enabled），
// 因此必须隔几秒复核一次，两次都判定为软件渲染才落盘，避免误改配置。
const GPU_RECHECK_MS = 3000;

function checkGpuOnce() {
  if (state.softwareMode) return;
  if (!gpu.statusLooksSoftware(gpu.currentStatus())) return;
  setTimeout(() => {
    if (state.softwareMode) return;
    if (gpu.statusLooksSoftware(gpu.currentStatus())) offerSoftware('检测到本机无可用显卡加速');
  }, GPU_RECHECK_MS);
}

function watchGpu() {
  app.on('child-process-gone', (_e, details) => {
    if (!details || details.type !== 'GPU') return;
    logger.log('gpu', `${details.type} ${details.reason}`);
    state.gpuCrashes++;
    if (state.softwareMode) return;
    // 第一次只提示；反复崩溃且 GPU 状态确实不可用时才落盘
    if (state.gpuCrashes >= 2 && gpu.statusLooksSoftware(gpu.currentStatus())) offerSoftware('GPU 进程反复异常退出');
    else offerSoftware('GPU 进程异常退出', false);
  });
}

/* ------------------------------------------------------------------ 标签 */

let tabSeq = 0;
const TAB_UNDO_MS = 10000;   // 关闭标签后的可撤销窗口
let lastClosed = null;       // { at, title, snapshot }

function tabList() {
  return state.tabs.map((t) => ({
    id: t.id, title: t.title, url: t.url, active: t === state.activeTab, count: t.records.length,
  }));
}

function tabsPayload() {
  return { tabs: tabList(), activeTabId: state.activeTab ? state.activeTab.id : null };
}

// 新建标签：建视图 → 激活 → 空导航挂 CDP → 载入目标 URL（目标首次加载不能漏抓）
// opts.background = true 时只建视图与加载，不抢当前标签（会话恢复用）
function newTab(url = 'about:blank', opts = {}) {
  const win = state.win;
  if (!win || win.isDestroyed()) return null;
  const target = String(url || 'about:blank');
  const view = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,   // 后台标签继续跑自动化与抓包
    },
  });
  const tab = {
    id: ++tabSeq, view, wc: view.webContents,
    title: '', url: target,
    records: [], byId: new Map(), pendingExtra: new Map(),
    wsFrames: [], seq: 0, storedBytes: 0, enabled: state.enabled,
  };
  state.tabs.push(tab);
  view.setBackgroundColor('#ffffff');

  const wc = tab.wc;
  // 页面里按下的 Ctrl+R / Ctrl+Shift+R / Ctrl+Shift+I / F11：菜单栏移除后这些命令没了默认入口，
  // 在页面视图这一侧用 before-input-event 补上（派发前拦截，不往页面注入脚本）
  wc.on('before-input-event', (e, input) => {
    if (!input || input.type !== 'keyDown' || wc.isDestroyed()) return;
    const key = String(input.key || '').toLowerCase();
    const ctrl = !!(input.control || input.meta);
    if (ctrl && input.shift && key === 'r') { e.preventDefault(); wc.reloadIgnoringCache(); return; }
    if (ctrl && key === 'r') { e.preventDefault(); wc.reload(); return; }
    if (ctrl && input.shift && key === 'i') { e.preventDefault(); toggleViewDevTools(wc); return; }
    if (input.key === 'F11' && !ctrl && !input.alt) { e.preventDefault(); toggleFullScreen(); }
  });
  if (!state.defaultUA) state.defaultUA = wc.getUserAgent();
  wc.setWindowOpenHandler(({ url: u }) => {            // target=_blank / window.open 留在同一标签
    const n = normalizeUrl(u);
    if (n) wc.loadURL(n).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('did-navigate', (_e, u) => {
    tab.url = u;
    tab.title = wc.getTitle();
    if (tab === state.activeTab) send('cap:navigated', { url: u, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
    send('cap:tabs', tabsPayload());
    recorder.onNav(tab, { url: u, kind: 'did-navigate' });
  });
  wc.on('did-navigate-in-page', (_e, u, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = u;
    if (tab === state.activeTab) send('cap:navigated', { url: u, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
    recorder.onNav(tab, { url: u, kind: 'in-page' });
  });
  wc.on('did-finish-load', () => {
    tab.title = wc.getTitle();
    send('cap:tabs', tabsPayload());
    recorder.onPage(tab, { url: wc.getURL(), title: wc.getTitle() });
    if (recorder.isRecording()) recorder.arm(wc).catch(() => {});   // 兜底：录制开始时尚未挂 CDP 的标签在这里补挂
  });
  wc.on('did-fail-load', (_e, code, desc, u, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      logger.log('load', `${code} ${desc} ${u}`);
      setStatus(`加载失败 ${code} ${desc} ${u}`);
      recorder.onNav(tab, { url: u, kind: 'fail' });
    }
  });

  if (!opts.background) activateTab(tab);
  else send('cap:tabs', tabsPayload());
  // 渲染进程是惰性创建的：先空导航让 CDP 目标就绪，挂上抓取后再真正导航，目标的首次加载才不会漏抓
  wc.loadURL('about:blank')
    .then(async () => {
      const ok = await capture.attachCapture(tab);
      if (!ok) return;
      const failed = await settings.restoreRuntime(wc);   // 该标签沿用当前 UA/请求头/限速（重启后恢复）
      if (failed.length) setStatus(`部分设置恢复失败：${failed.join('；')}`);
      // CDP 挂上之后才可能注入binding，所以录制中的新标签在这里补挂（did-finish-load 还有一次兜底）
      if (recorder.isRecording()) recorder.arm(wc).catch(() => {});
      if (target !== 'about:blank') await wc.loadURL(target);
    })
    .catch((e) => setStatus(`初始化失败：${e.message}`));
  return tab;
}

// 菜单栏移除后，这几个窗口级命令由面板快捷键（renderer onKey）与页面视图的
// before-input-event 两处触发，都走下面这两个函数，行为一致。
function toggleViewDevTools(wc) {
  const target = wc && !wc.isDestroyed() ? wc : null;
  if (!target) return { ok: false, error: '视图未就绪' };
  if (target.isDevToolsOpened()) target.closeDevTools(); else target.openDevTools({ mode: 'detach' });
  return { ok: true };
}

function toggleFullScreen() {
  const { win } = state;
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  win.setFullScreen(!win.isFullScreen());
  return { ok: true, on: win.isFullScreen() };
}

function activateTab(tab) {
  if (!tab) return;
  capture.flushBatch(true);       // 在途批次属于旧标签，直接丢（面板切过去后会全量同步）
  syncActive(tab);
  const { win } = state;
  if (win && !win.isDestroyed()) {
    win.setBrowserView(tab.view);
    layout();
  }
  send('cap:tabChanged', { id: tab.id });
  send('cap:tabs', tabsPayload());
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: '标签不存在' };
  const tab = state.tabs[idx];
  const wasActive = state.activeTab === tab;
  // 撤销快照：零拷贝持有该标签自己的数组（标签对象随后被丢弃，视图另行销毁）
  lastClosed = {
    at: Date.now(),
    title: tab.title || tab.url || '',
    snapshot: {
      title: tab.title, url: tab.url,
      records: tab.records, byId: tab.byId, pendingExtra: tab.pendingExtra,
      wsFrames: tab.wsFrames, seq: tab.seq, storedBytes: tab.storedBytes, enabled: tab.enabled,
    },
  };
  state.tabs.splice(idx, 1);
  // 先把窗口切到相邻标签，再销毁旧视图（避免窗口短暂挂着一个已销毁的 BrowserView）
  if (wasActive) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) activateTab(next);
  }
  try {
    // BrowserView 的 webContents：close() 只是走 window.close() 流程，实测不会销毁（渲染进程会残留），
    // destroy() 在 Electron 22 运行时存在且真正释放；类型定义里没有，所以做存在性兜底。
    if (typeof tab.wc.destroy === 'function') tab.wc.destroy();
    else tab.wc.close();
  } catch (e) { logger.log('tab', `关闭标签失败：${e.message}`); }
  if (!state.tabs.length) newTab();          // 最后一个标签关掉后回到全新标签
  send('cap:tabs', tabsPayload());
  return { ok: true, id, title: lastClosed.title, undoMs: TAB_UNDO_MS };
}

function createWindow() {
  const win = new BrowserWindow(Object.assign(windowOptions(), {
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    show: true,   // 自检也需要真实视口：隐藏窗口的视口高度为 0，滚动/自动加载无法生效
    backgroundColor: '#1b1d21',
    title: '网页抓取工具',
    icon: ICON,
    webPreferences: {
      // 面板只加载本地 index.html，从不加载远程内容，因此可用 nodeIntegration
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,   // 窗口被遮挡时面板仍要按点刷新（节流计时器、轻提示）
    },
  }));
  state.win = win;
  win.loadFile(path.join(__dirname, 'index.html'));
  // 窗口创建时的 setBounds 早于窗口真正显示，Chromium 会把它落在 0 高度的视口上；
  // 面板加载完成 = 窗口已显示，此时重排一次，页面视口才拿到真实高度。
  win.webContents.once('did-finish-load', layout);
  win.on('resize', layout);
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('closed', () => { state.win = null; });

  newTab();
  return win;
}

/* -------------------------------------------------------------- 导出组装 */

// 导出默认名用的当前页地址（取不到就返回空串，文件名退化为无站点前缀）
function currentPageUrl() {
  const v = state.view;
  return v && !v.webContents.isDestroyed() ? v.webContents.getURL() : '';
}

// Postman Collection 的默认标题用当前页标题
function currentPageTitle() {
  const v = state.view;
  return v && !v.webContents.isDestroyed() ? v.webContents.getTitle() : '';
}

// Cookie 的统一字段映射（面板、导出、会话数据模态共用一份）
function mapCookie(c) {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, session: c.session,
    sameSite: c.sameSite, expirationDate: c.expirationDate,
  };
}

async function buildExport(ids) {
  const pd = await extract.collectPageData();
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const list = set ? state.records.filter((r) => set.has(r.id)) : state.records;
  return {
    exportedAt: new Date().toISOString(),
    url: pd.url,
    title: pd.title,
    cookies: pd.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, session: c.session,
      expirationDate: c.expirationDate, sameSite: c.sameSite,
    })),
    storage: { localStorage: pd.page.localStorage || {}, sessionStorage: pd.page.sessionStorage || {}, documentCookie: pd.page.cookies || '' },
    html: pd.html,
    requestCount: list.length,
    requests: list.map(capture.fullRecord),
    webSocketFrames: state.wsFrames,
  };
}

/* -------------------------------------------------------------- IPC 接口 */

function registerIpc() {
  ipcMain.handle('cap:list', () => ({
    records: state.records.map(capture.summarize),
    wsFrames: state.wsFrames,
    status: state.status, enabled: state.enabled, panelWidth: state.panelWidth,
    url: state.view ? state.view.webContents.getURL() : '',
    title: state.view ? state.view.webContents.getTitle() : '',
    tabs: tabList(), activeTabId: state.activeTab ? state.activeTab.id : null,
  }));
  ipcMain.handle('cap:detail', (_e, id) => {
    const r = state.records.find((x) => x.id === id);
    return r ? capture.fullRecord(r) : null;
  });
  ipcMain.handle('cap:navigate', async (_e, input) => {
    const url = normalizeUrl(input);
    if (!url) return { ok: false, error: '请输入网址' };
    try { await state.view.webContents.loadURL(url); return { ok: true }; }
    catch (e) { logger.log('ipc', `cap:navigate: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:back', () => { const wc = state.view.webContents; if (wc.canGoBack()) wc.goBack(); return true; });
  ipcMain.handle('cap:forward', () => { const wc = state.view.webContents; if (wc.canGoForward()) wc.goForward(); return true; });
  ipcMain.handle('cap:reload', (_e, hard) => {
    const wc = state.view.webContents;
    if (hard) wc.reloadIgnoringCache(); else wc.reload();
    return true;
  });
  // 菜单栏已移除：Ctrl+Shift+I / F11 的入口改从这里走（快捷键在面板 onKey 里绑定）
  ipcMain.handle('cap:devtools', () => toggleViewDevTools(state.view && state.view.webContents));
  ipcMain.handle('cap:fullscreen', () => toggleFullScreen());
  ipcMain.handle('cap:setEnabled', (_e, v) => {
    state.enabled = !!v;
    for (const t of state.tabs) t.enabled = state.enabled;   // 暂停/继续是全局的，所有标签一起生效
    setStatus(state.enabled ? '抓取中' : '已暂停');
    return state.enabled;
  });
  ipcMain.handle('cap:clear', () => {
    capture.flushBatch(true);     // 记录即将清空，在途批次一并丢弃
    resetActive();
    return true;
  });
  ipcMain.handle('cap:panelWidth', (_e, w) => {
    state.panelWidth = Math.max(320, Math.min(1000, w | 0));
    store.setApp('panelWidth', state.panelWidth);
    store.save();
    layout();
    return state.panelWidth;
  });
  ipcMain.handle('cap:pageData', () => extract.collectPageData().then((pd) => ({
    url: pd.url, title: pd.title, htmlLength: pd.html.length, html: pd.html,
    page: pd.page, cookies: pd.cookies.map(mapCookie),
  })));
  ipcMain.handle('cap:exportAll', async (_e, ids, file) => {
    try {
      const data = await buildExport(ids);
      const name = `${files.exportBaseName('capture', currentPageUrl())}.json`;
      if (file) return await files.saveTextFile({ defaultName: name, content: JSON.stringify(data, null, 2), file });
      return await files.saveWithDialog(name, JSON.stringify(data, null, 2));
    } catch (e) { logger.log('ipc', `cap:exportAll: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:exportHtml', async () => {
    try {
      const pd = await extract.collectPageData();
      const html = pd.html.replace('<head>', `<head>\n<!-- 抓取自 ${pd.url} @ ${new Date().toISOString()} -->`);
      return await files.saveWithDialog(`${files.exportBaseName('page', pd.url)}.html`, html);
    } catch (e) { logger.log('ipc', `cap:exportHtml: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:exportCookieJson', async () => {
    try {
      const cookies = await session.fromPartition(PARTITION).cookies.get({});
      return await files.saveWithDialog(`${files.exportBaseName('cookies', currentPageUrl())}.json`, JSON.stringify(cookies, null, 2));
    } catch (e) { logger.log('ipc', `cap:exportCookieJson: ${e.message}`); return { ok: false, error: e.message }; }
  });

  /* --------------------------------------------------- Cookie 与会话数据 */

  ipcMain.handle('cap:cookies', async () => {
    try {
      const cookies = await session.fromPartition(PARTITION).cookies.get({});
      return { ok: true, cookies: cookies.map(mapCookie) };
    } catch (e) { logger.log('ipc', `cap:cookies: ${e.message}`); return { ok: false, error: e.message, cookies: [] }; }
  });
  ipcMain.handle('cap:cookieSet', async (_e, details) => {
    try {
      const d = details || {};
      if (!d.name) return { ok: false, error: '缺少 cookie 名称' };
      if (!d.url) return { ok: false, error: '缺少 cookie 所属 URL' };
      await session.fromPartition(PARTITION).cookies.set(d);
      return { ok: true };
    } catch (e) { logger.log('ipc', `cap:cookieSet: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:cookieRemove', async (_e, payload) => {
    const { url, name } = payload || {};
    if (!url || !name) return { ok: false, error: '缺少 url 或 name' };
    try {
      await session.fromPartition(PARTITION).cookies.remove(url, name);
      return { ok: true };
    } catch (e) { logger.log('ipc', `cap:cookieRemove: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:cookieImport', async (_e, payload) => {
    try {
      const { text, url } = payload || {};
      const raw = String(text == null ? '' : text).trim();
      if (!raw) return { ok: false, error: '没有可导入的内容' };
      const list = [];
      if (raw.startsWith('[') || raw.startsWith('{')) {
        const arr = JSON.parse(raw);
        for (const c of [].concat(arr)) if (c && c.name) list.push(c);
      } else {
        for (const seg of raw.split(/[;\n]/)) {         // Cookie 头形式：a=1; b=2
          const t = seg.trim();
          if (!t) continue;
          const i = t.indexOf('=');
          if (i <= 0) continue;
          list.push({ url, name: t.slice(0, i).trim(), value: t.slice(i + 1).trim() });
        }
      }
      if (!list.length) return { ok: false, error: '没有可导入的内容' };
      const ses = session.fromPartition(PARTITION);
      let added = 0;
      const failed = [];
      for (const c of list) {
        try {
          const details = { url: c.url || url, name: c.name, value: c.value == null ? '' : String(c.value) };
          for (const k of ['domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite']) {
            if (c[k] !== undefined) details[k] = c[k];
          }
          await ses.cookies.set(details);
          added++;
        } catch (e) { failed.push({ name: c.name, error: e.message }); }
      }
      return { ok: true, added, failed };
    } catch (e) { logger.log('ipc', `cap:cookieImport: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:storageSet', async (_e, payload) => {
    const { area, key, value } = payload || {};
    const name = area === 'local' ? 'localStorage' : area === 'session' ? 'sessionStorage' : '';
    if (!name) return { ok: false, error: '未知存储区' };
    if (!key) return { ok: false, error: '缺少键名' };
    try {
      await extract.evalPage(`(() => { ${name}.setItem(${JSON.stringify(String(key))}, ${JSON.stringify(String(value == null ? '' : value))}); return true; })()`);
      return { ok: true };
    } catch (e) { logger.log('ipc', `cap:storageSet: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:storageRemove', async (_e, payload) => {
    const { area, key } = payload || {};
    const name = area === 'local' ? 'localStorage' : area === 'session' ? 'sessionStorage' : '';
    if (!name) return { ok: false, error: '未知存储区' };
    if (!key) return { ok: false, error: '缺少键名' };
    try {
      await extract.evalPage(`(() => { ${name}.removeItem(${JSON.stringify(String(key))}); return true; })()`);
      return { ok: true };
    } catch (e) { logger.log('ipc', `cap:storageRemove: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:exportCookies', async (_e, payload) => {
    try {
      const { format, file } = payload || {};
      const base = files.exportBaseName('cookies', currentPageUrl());
      const cookies = await session.fromPartition(PARTITION).cookies.get({});
      if (format === 'netscape') {
        const lines = ['# Netscape HTTP Cookie File'];
        for (const c of cookies) {
          const domain = c.domain || '';
          lines.push([
            domain,
            domain.startsWith('.') ? 'TRUE' : 'FALSE',
            c.path || '/',
            c.secure ? 'TRUE' : 'FALSE',
            c.session ? '0' : String(Math.round(c.expirationDate || 0)),
            c.name,
            c.value == null ? '' : String(c.value),
          ].join('\t'));
        }
        return await files.saveTextFile({ defaultName: `${base}.txt`, content: lines.join('\n') + '\n', file });
      }
      if (format !== 'json' && format !== undefined && format !== null && format !== '') {
        return { ok: false, error: '未知导出格式' };
      }
      return await files.saveTextFile({ defaultName: `${base}.json`, content: JSON.stringify(cookies.map(mapCookie), null, 2), file });
    } catch (e) { logger.log('ipc', `cap:exportCookies: ${e.message}`); return { ok: false, error: e.message }; }
  });

  /* ---------------------------------------------------------- 爬虫功能 */

  ipcMain.handle('cap:cfg', (_e, payload) => {
    const { key, value } = payload || {};
    return settings.applySetting(key, value);
  });
  ipcMain.handle('cap:cfgAll', () => Object.assign({}, settings.values));
  ipcMain.handle('cap:cfgExport', async (_e, payload) => {
    const { file } = payload || {};
    const content = JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), settings: settings.values,
    }, null, 2);
    return files.saveTextFile({ defaultName: `${files.exportBaseName('settings', '', Date.now())}.json`, content, file });
  });
  ipcMain.handle('cap:cfgImport', async (_e, payload) => {
    let { file } = payload || {};
    if (!file) {
      const picked = await files.pickJsonFile();
      if (!picked.ok) return picked;
      file = picked.file;
    }
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return { ok: false, error: `配置文件无法解析：${e.message}` }; }
    const src = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : null;
    if (!src) return { ok: false, error: '配置文件里没有 settings 段' };
    const applied = [];
    const skipped = [];
    const failed = [];
    for (const [key, value] of Object.entries(src)) {
      if (key === 'softwareRendering') { await settings.applyInner(key, value); continue; }   // app 段设置，单独处理（需重启生效）
      if (!Object.prototype.hasOwnProperty.call(settings.values, key)) { skipped.push(key); continue; }
      const r = await settings.applyInner(key, value);
      if (r.ok) applied.push(key); else failed.push(`${key}: ${r.error}`);
    }
    store.setSettings(settings.values);
    store.flush();
    return { ok: true, applied: applied.length, skipped, failed };
  });
  ipcMain.handle('cap:cfgAllTabs', () => settings.applyToAllTabs());
  ipcMain.handle('cap:mark', (_e, id, patch) => {
    const rec = state.records.find((x) => x.id === id);
    if (!rec) return { ok: false, error: '记录不存在' };
    const p = patch || {};
    if (p.star !== undefined) rec.star = !!p.star;
    if (p.comment !== undefined) rec.comment = String(p.comment).slice(0, 500);
    return { ok: true, record: capture.summarize(rec) };
  });
  ipcMain.handle('cap:stats', () => format.buildStats(state.records));
  ipcMain.handle('cap:searchBody', (_e, query) => {
    const q = String(query == null ? '' : query);
    if (!q) return { ok: false, error: '请输入搜索内容' };
    const ids = [];
    for (const r of state.records) {
      if (r.body == null || r.bodyBase64) continue;      // 只搜已保存的文本响应体
      if (r.body.includes(q)) ids.push(r.id);
    }
    return { ok: true, ids, count: ids.length };
  });
  ipcMain.handle('cap:auto', (_e, opts) => automation.autoRun(opts));
  ipcMain.handle('cap:autoStop', () => automation.autoStop());
  ipcMain.handle('cap:extract', (_e, payload) => {
    const { rows, fields } = payload || {};
    return extract.extractRows(rows, fields);
  });
  ipcMain.handle('cap:harvest', () => extract.harvest());
  ipcMain.handle('cap:format', (_e, kind, data) => {
    try {
      if (kind === 'curl') {
        const rec = state.records.find((x) => x.id === data);
        return rec ? { ok: true, text: format.buildCurl(rec) } : { ok: false, error: '记录不存在' };
      }
      if (kind === 'reqHeaders') {
        const rec = state.records.find((x) => x.id === data);
        if (!rec) return { ok: false, error: '记录不存在' };
        const lines = format.requestHeaderList(rec)
          .filter((h) => !['content-length', 'host'].includes(h.name.toLowerCase()))
          .map((h) => `${h.name}: ${h.value}`);
        return { ok: true, text: lines.join('\n') };
      }
      if (kind === 'python' || kind === 'nodeFetch' || kind === 'nodeAxios') {
        const rec = state.records.find((x) => x.id === data);
        if (!rec) return { ok: false, error: '记录不存在' };
        const text = kind === 'python' ? format.buildPythonRequests(rec)
          : kind === 'nodeFetch' ? format.buildNodeFetch(rec) : format.buildNodeAxios(rec);
        return { ok: true, text };
      }
      if (kind === 'markdown') {
        const ids = Array.isArray(data) && data.length ? new Set(data) : null;
        const list = ids ? state.records.filter((r) => ids.has(r.id)) : state.records;
        return { ok: true, text: format.buildMarkdownTable(list) };
      }
      if (kind === 'rowsCsv') return { ok: true, text: format.rowsToCsv(data) };
      if (kind === 'tablesCsv') return { ok: true, text: format.tablesToCsv(data) };
      return { ok: false, error: '未知格式' };
    } catch (e) { logger.log('ipc', `cap:format: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:saveText', (_e, payload) => files.saveTextFile(payload));
  ipcMain.handle('cap:saveBodies', (_e, dir) => files.saveBodies(dir));
  ipcMain.handle('cap:saveBody', async (_e, id, kind, file) => {
    try {
      const rec = state.records.find((x) => x.id === id);
      if (!rec) return { ok: false, error: '记录不存在' };
      const want = kind === 'request' ? 'request' : 'response';
      if (want === 'request' && !rec.postData) return { ok: false, error: '该请求没有请求体' };
      if (want === 'response' && rec.body == null) return { ok: false, error: '没有响应体' };
      let hostPath = '';
      try { const u = new URL(rec.url); hostPath = u.host + u.pathname; } catch (e) { hostPath = rec.url; }
      const base = files.sanitizeName(`${want === 'request' ? 'request' : 'body'}-${rec.id}-${hostPath}`);
      const ext = want === 'request' ? 'txt' : files.mimeExt(rec.mime);
      const defaultName = `${base}.${ext}`;
      if (want === 'response' && rec.bodyBase64) {
        return await files.saveBinaryFile({ defaultName, buffer: Buffer.from(rec.body, 'base64'), file });
      }
      return await files.saveTextFile({ defaultName, content: String(want === 'request' ? rec.postData : rec.body), file });
    } catch (e) {
      logger.log('ipc', `cap:saveBody: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('cap:logTail', (_e, payload) => {
    const { lines = 1000, filter = '' } = payload || {};
    const text = logger.tail(lines, filter);
    return { ok: true, text, file: logger.filePath(), count: text ? text.split('\n').length : 0 };
  });
  ipcMain.handle('cap:ws', () => ({ ok: true, frames: state.wsFrames }));
  ipcMain.handle('cap:openLog', () => {
    shell.showItemInFolder(logger.filePath());
    return { ok: true };
  });
  ipcMain.handle('cap:exportHar', async (_e, payload) => {
    try {
      const { file, ids } = payload || {};
      const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
      const list = set ? state.records.filter((r) => set.has(r.id)) : state.records;
      const har = format.buildHar(list, state.view ? state.view.webContents.getTitle() : '');
      const name = `${files.exportBaseName('capture', currentPageUrl())}.har`;
      return await files.saveTextFile({ defaultName: name, content: JSON.stringify(har, null, 2), file });
    } catch (e) { logger.log('ipc', `cap:exportHar: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:replay', (_e, id, overrides) => capture.replay(id, overrides));
  ipcMain.handle('cap:exportPostman', async (_e, payload) => {
    try {
      const { file, ids } = payload || {};
      const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
      const list = set ? state.records.filter((r) => set.has(r.id)) : state.records;
      const col = format.buildPostmanCollection(list, currentPageTitle());
      const name = `${files.exportBaseName('postman', currentPageUrl())}.json`;
      return await files.saveTextFile({ defaultName: name, content: JSON.stringify(col, null, 2), file });
    } catch (e) { logger.log('ipc', `cap:exportPostman: ${e.message}`); return { ok: false, error: e.message }; }
  });

  /* ------------------------------------------------------------ 页面工具 */

  ipcMain.handle('cap:screenshot', async (_e, payload) => {
    try {
      const { mode, selector, file } = payload || {};
      const wc = state.view.webContents;
      let buffer;
      if (mode === 'element') {
        const sel = String(selector || '').trim();
        if (!sel) return { ok: false, error: '请填写选择器' };
        const box = await extract.evalPage(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
        })()`);
        if (!box) return { ok: false, error: '未找到匹配元素' };
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height), scale: 1 },
        });
        buffer = Buffer.from(shot.data, 'base64');
      } else if (mode === 'full') {
        const m = await wc.debugger.sendCommand('Page.getLayoutMetrics');
        const size = m.cssContentSize || m.contentSize || { width: 0, height: 0 };
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)), scale: 1 },
        });
        buffer = Buffer.from(shot.data, 'base64');
      } else {
        const image = await wc.capturePage();
        buffer = image.toPNG();
      }
      return await files.saveBinaryFile({ defaultName: `${files.exportBaseName('shot', currentPageUrl())}.png`, buffer, file });
    } catch (e) { logger.log('ipc', `cap:screenshot: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:pdf', async (_e, payload) => {
    try {
      const { file } = payload || {};
      const buffer = await state.view.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: false });
      return await files.saveBinaryFile({ defaultName: `${files.exportBaseName('page', currentPageUrl())}.pdf`, buffer, file });
    } catch (e) { logger.log('ipc', `cap:pdf: ${e.message}`); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:find', (_e, text, opts) => new Promise((resolve) => {
    const q = String(text == null ? '' : text);
    if (!q) return resolve({ ok: false, error: '请输入查找内容' });
    const wc = state.view.webContents;
    const o = opts || {};
    // findInPage 只返回 requestId，结果走 found-in-page 事件
    let last = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.off('found-in-page', onFound);
      resolve({ ok: true, matches: r.matches || 0, active: r.activeMatchOrdinal || 0 });
    };
    const onFound = (_ev, result) => {
      last = result;
      if (result && result.finalUpdate) finish(result);
    };
    const timer = setTimeout(() => finish(last || {}), 3000);
    wc.on('found-in-page', onFound);
    wc.findInPage(q, { forward: !!o.forward, matchCase: !!o.matchCase });
  }));
  ipcMain.handle('cap:findStop', () => {
    state.view.webContents.stopFindInPage('clearSelection');
    return { ok: true };
  });

  /* ------------------------------------------------ 元素拾取 / 执行 JS / 清理 */

  ipcMain.handle('cap:pickStart', () => picker.start());
  ipcMain.handle('cap:pickCancel', () => picker.stop());
  ipcMain.handle('cap:eval', async (_e, expr) => {
    const code = String(expr == null ? '' : expr);
    if (!code.trim()) return { ok: false, error: '请输入要执行的 JS' };
    try {
      const v = await extract.evalPage(code);
      if (v === undefined) return { ok: true, value: '[undefined]' };
      if (typeof v === 'string') return { ok: true, value: v };
      try { return { ok: true, value: JSON.stringify(v, null, 2) }; } catch (e) { return { ok: true, value: String(v) }; }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 清理运行时数据：Cookie / Storage / 缓存 / 日志 / 会话文件，逐项独立失败
  ipcMain.handle('cap:wipe', async (_e, payload) => {
    const targets = Array.isArray(payload && payload.targets) ? payload.targets : [];
    if (!targets.length) return { ok: false, error: '没有选择任何清理目标' };
    const ses = session.fromPartition(PARTITION);
    const done = [];
    const failed = [];
    for (const t of targets) {
      try {
        if (t === 'cookies') {
          await ses.clearStorageData({ storages: ['cookies'] });
          done.push(t);
        } else if (t === 'storage') {
          await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers'] });
          for (const tab of state.tabs) {                       // sessionStorage 只能逐标签在页面里清
            const wc = tab.wc;
            if (!wc || wc.isDestroyed()) continue;
            try {
              if (wc.debugger.isAttached()) await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'sessionStorage.clear()', returnByValue: true });
              else await wc.executeJavaScript('sessionStorage.clear()', true);
            } catch (e) { /* 单标签失败忽略 */ }
          }
          done.push(t);
        } else if (t === 'cache') {
          await ses.clearCache();
          done.push(t);
        } else if (t === 'logs') {
          const r = logger.clear();
          if (!r.ok) throw new Error(r.error);
          done.push(t);
        } else if (t === 'session') {
          const r = sessionStore.discard();
          if (!r.ok) throw new Error(r.error);
          done.push(t);
        } else {
          failed.push(`${t}: 未知目标`);
        }
      } catch (e) {
        failed.push(`${t}: ${e.message}`);
        logger.log('ipc', `cap:wipe ${t}: ${e.message}`);
      }
    }
    return { ok: failed.length === 0, done, failed };
  });

  /* ------------------------------------------------------------ 会话录制 */

  ipcMain.handle('cap:recStart', (_e, opts) => recorder.start(opts || {}));
  ipcMain.handle('cap:recStop', () => recorder.stopWhenIdle('manual'));
  ipcMain.handle('cap:recStatus', () => recorder.status());
  ipcMain.handle('cap:recList', () => recorder.listRecordings());
  ipcMain.handle('cap:recRead', (_e, payload) => recorder.readRecording((payload || {}).file));
  ipcMain.handle('cap:recScript', async (_e, payload) => {
    const { file, outFile } = payload || {};
    const rd = recorder.readRecording(file);
    if (!rd.ok) return rd;
    const first = rd.actions.find((a) => a.url);
    const content = recorder.buildScript(rd.actions, { url: first ? first.url : '' });
    return files.saveTextFile({ defaultName: `replay-${rd.base}.js`, content, file: outFile });
  });
  ipcMain.handle('cap:recReplay', (_e, payload) => recorder.replayRecording((payload || {}).file, payload || {}));
  ipcMain.handle('cap:recReplayStop', () => recorder.stopReplay());
  ipcMain.handle('cap:recInfo', () => Object.assign({ ok: true, dir: recorder.dirPath() }, recorder.lastInfo()));
  ipcMain.handle('cap:recOpen', () => {
    const f = recorder.lastFile();
    if (f && fs.existsSync(f)) shell.showItemInFolder(f);
    else shell.openPath(recorder.dirPath());
    return { ok: true, dir: recorder.dirPath(), file: f };
  });

  /* ---------------------------------------------------------- 会话持久化 */

  ipcMain.handle('cap:sessionInfo', () => sessionStore.info());
  ipcMain.handle('cap:sessionRestore', () => {
    const r = sessionStore.load();
    if (!r.ok) return r;
    state.records.length = 0;
    state.byId.clear();
    state.wsFrames.length = 0;
    state.storedBytes = 0;
    for (const rec of r.records) {
      state.records.push(rec);
      if (rec.cdpId) state.byId.set(rec.cdpId, rec);
    }
    state.seq = state.records.reduce((m, x) => Math.max(m, x.id || 0), 0);
    for (const f of r.wsFrames) state.wsFrames.push(f);
    // 标签布局：记录灌进当前活动标签（列表立刻可用），保存的标签在后台整体重建，不抢当前标签
    const savedTabs = Array.isArray(r.tabs) ? r.tabs : [];
    for (const t of savedTabs) newTab(t.url, { background: true });
    send('cap:tabChanged', { id: state.activeTab ? state.activeTab.id : null });   // 让面板重新拉取（记录已换成本次恢复的内容）
    return {
      ok: true, savedAt: r.savedAt, count: state.records.length,
      records: state.records.map(capture.summarize), wsFrames: state.wsFrames, tabs: savedTabs.length,
    };
  });
  ipcMain.handle('cap:sessionDiscard', () => sessionStore.discard());

  /* -------------------------------------------------------------- 多标签 */

  ipcMain.handle('cap:tabList', () => tabList());
  ipcMain.handle('cap:tabNew', (_e, url) => {
    const tab = newTab(normalizeUrl(url) || 'about:blank');
    return tab ? { ok: true, id: tab.id, tabs: tabList() } : { ok: false, error: '窗口未就绪' };
  });
  ipcMain.handle('cap:tabActivate', (_e, id) => {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return { ok: false, error: '标签不存在' };
    activateTab(tab);
    return { ok: true, tabs: tabList() };
  });
  ipcMain.handle('cap:tabClose', (_e, id) => closeTab(id));
  ipcMain.handle('cap:tabUndo', () => {
    if (!lastClosed) return { ok: false, error: '没有可撤销的关闭' };
    if (Date.now() - lastClosed.at > TAB_UNDO_MS) { lastClosed = null; return { ok: false, error: '撤销已过期' }; }
    const snap = lastClosed.snapshot;
    const tab = newTab(snap.url || 'about:blank');
    if (!tab) return { ok: false, error: '窗口未就绪' };
    Object.assign(tab, {
      title: snap.title, records: snap.records, byId: snap.byId, pendingExtra: snap.pendingExtra,
      wsFrames: snap.wsFrames, seq: snap.seq, storedBytes: snap.storedBytes, enabled: snap.enabled,
    });
    syncActive();
    send('cap:tabChanged', { id: tab.id });
    lastClosed = null;
    return { ok: true, id: tab.id, records: tab.records.length };
  });
  ipcMain.handle('cap:tabReload', (_e, id) => {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return { ok: false, error: '标签不存在' };
    tab.wc.reload();
    return { ok: true };
  });
  ipcMain.handle('cap:tabCloseOthers', (_e, id) => {
    const keep = state.tabs.find((t) => t.id === id);
    if (!keep) return { ok: false, error: '标签不存在' };
    let closed = 0;
    for (const t of [...state.tabs]) {
      if (t === keep) continue;
      closeTab(t.id);
      closed++;
    }
    if (state.activeTab !== keep) activateTab(keep);
    return { ok: true, closed };
  });

  /* ------------------------------------------------------ 应用级（重启/GPU）*/

  ipcMain.handle('cap:restart', () => {
    store.flush();
    // 先让 IPC 回复送达，再重启（立刻 relaunch 会丢回复）
    setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    return { ok: true };
  });
  ipcMain.handle('cap:gpuStatus', () => Object.assign(gpu.describe(), {
    softwareMode: state.softwareMode, crashes: state.gpuCrashes,
  }));
}

/* ---------------------------------------------------------------- 启动 */

app.whenReady().then(() => {
  // 去掉 Electron 默认菜单栏（File/Edit/View/Window/Help）：本项目全部功能都在面板里，
  // 省下窗口顶部一整行；对应快捷键改由面板 onKey + cap:reload/cap:devtools/cap:fullscreen 提供
  // （文本框的 Ctrl+C/V/X/A/Z 是 Chromium 原生编辑命令，与菜单无关，仍然可用）。
  Menu.setApplicationMenu(null);
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  settings.registerBlocker();          // 必须在任何导航之前注册（同一 session 只能注册一个监听器）
  settings.hydrate();                  // 磁盘设置灌进内存，控件与拦截器都读同一份

  // 证书错误：只有显式勾选「忽略证书错误」才放行，其余保持 Chromium 默认拒绝
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    if (settings.values.ignoreCertErrors) {
      event.preventDefault();
      logger.log('cert', `${error} ${url}`);
      return callback(true);
    }
    callback(false);
  });

  // HTTP 认证：设置里填了用户名就用它直接应答；没填则不调 callback（等价取消，避免弹系统框）
  app.on('login', (event, _wc, details, _authInfo, callback) => {
    if (!settings.values.authUser) {
      setStatus('站点要求认证，请在「设置」里填写用户名与密码');
      logger.log('auth', `未配置凭据 ${details.url}`);
      return;
    }
    event.preventDefault();
    callback(settings.values.authUser, settings.values.authPass);
    logger.log('auth', `已用配置的用户名应答 ${details.url}`);
  });

  registerIpc();
  createWindow();
  watchGpu();
  if (!state.selftest) sessionStore.start();    // 自检自己调 save/load，不受 30s 定时器干扰
  // GPU 状态需要一点时间上报，面板首帧之后再判定（首次采样后还会二次复核，见 checkGpuOnce）
  if (state.win) state.win.webContents.once('did-finish-load', () => setTimeout(checkGpuOnce, 3000));
  if (state.selftest) {
    require('./selftest.js').run({
      state, store, gpu, capture, extract, settings, automation, format, files, logger,
      session: sessionStore, recorder, picker, resetActive, PARTITION,
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  sessionStore.stop();
  recorder.flushSync();                            // 录制中的会话补一条 summary（reason:'quit'）
  if (!state.selftest) sessionStore.saveSync();   // 自检退出时不写会话文件，避免污染断言数据
});
