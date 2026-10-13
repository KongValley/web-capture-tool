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
const { app, BrowserWindow, BrowserView, ipcMain, session, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');

const { PARTITION, TOOLBAR_H, state, send, setStatus, normalizeUrl } = require('./state');
const store = require('./store');
const gpu = require('./gpu');
const capture = require('./capture');
const extract = require('./extract');
const settings = require('./settings');
const automation = require('./automation');
const format = require('./format');
const files = require('./files');

const ICON = path.join(__dirname, 'build', 'icon.ico');
if (process.platform === 'win32') app.setAppUserModelId('com.kongvalley.web-capture-tool');

// 自检改道到临时配置，绝不碰用户真实配置；随后同步读盘（后续默认值都从这里取）
if (state.selftest) store.useFile(path.join(os.tmpdir(), 'wct-selftest-settings', 'settings.json'));
const boot = store.load();
state.panelWidth = boot.app.panelWidth;

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
    action: persist ? 'restart' : 'settings',
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
    state.gpuCrashes++;
    if (state.softwareMode) return;
    // 第一次只提示；反复崩溃且 GPU 状态确实不可用时才落盘
    if (state.gpuCrashes >= 2 && gpu.statusLooksSoftware(gpu.currentStatus())) offerSoftware('GPU 进程反复异常退出');
    else offerSoftware('GPU 进程异常退出', false);
  });
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
    },
  }));
  state.win = win;
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('resize', layout);
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('closed', () => { state.win = null; });

  const view = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  state.view = view;
  view.setBackgroundColor('#ffffff');
  win.setBrowserView(view);
  layout();

  const wc = view.webContents;
  state.defaultUA = wc.getUserAgent();
  wc.setWindowOpenHandler(({ url }) => {            // target=_blank / window.open 留在同一视图
    const u = normalizeUrl(url);
    if (u) wc.loadURL(u).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('did-navigate', (_e, url) => send('cap:navigated', { url, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() }));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) send('cap:navigated', { url, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() }); });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) setStatus(`加载失败 ${code} ${desc} ${url}`);
  });

  // 渲染进程是惰性创建的：必须先有一次导航，CDP 目标才存在，否则 sendCommand 会一直挂起。
  wc.loadURL('about:blank')
    .then(async () => {
      const ok = await capture.attachCapture(wc);
      if (!ok) return;
      const failed = await settings.restoreRuntime();   // 重启后恢复 UA/请求头/限速/代理
      if (failed.length) setStatus(`部分设置恢复失败：${failed.join('；')}`);
    })
    .catch((e) => setStatus(`初始化失败：${e.message}`));
  return win;
}

/* -------------------------------------------------------------- 导出组装 */

async function buildExport() {
  const pd = await extract.collectPageData();
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
    requestCount: state.records.length,
    requests: state.records.map(capture.fullRecord),
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
  }));
  ipcMain.handle('cap:detail', (_e, id) => {
    const r = state.records.find((x) => x.id === id);
    return r ? capture.fullRecord(r) : null;
  });
  ipcMain.handle('cap:navigate', async (_e, input) => {
    const url = normalizeUrl(input);
    if (!url) return { ok: false, error: '请输入网址' };
    try { await state.view.webContents.loadURL(url); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:back', () => { const wc = state.view.webContents; if (wc.canGoBack()) wc.goBack(); return true; });
  ipcMain.handle('cap:forward', () => { const wc = state.view.webContents; if (wc.canGoForward()) wc.goForward(); return true; });
  ipcMain.handle('cap:reload', () => { state.view.webContents.reload(); return true; });
  ipcMain.handle('cap:setEnabled', (_e, v) => { state.enabled = !!v; setStatus(state.enabled ? '抓取中' : '已暂停'); return state.enabled; });
  ipcMain.handle('cap:clear', () => {
    state.records.length = 0; state.byId.clear(); state.wsFrames.length = 0;
    state.storedBytes = 0; state.seq = 0;
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
    page: pd.page, cookies: pd.cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: c.session, sameSite: c.sameSite, expirationDate: c.expirationDate })),
  })));
  ipcMain.handle('cap:exportAll', async () => {
    try {
      const data = await buildExport();
      return await files.saveWithDialog(`capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(data, null, 2));
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:exportHtml', async () => {
    try {
      const pd = await extract.collectPageData();
      const html = pd.html.replace('<head>', `<head>\n<!-- 抓取自 ${pd.url} @ ${new Date().toISOString()} -->`);
      return await files.saveWithDialog(`page-${new Date().toISOString().replace(/[:.]/g, '-')}.html`, html);
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:exportCookieJson', async () => {
    try {
      const cookies = await session.fromPartition(PARTITION).cookies.get({});
      return await files.saveWithDialog(`cookies-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(cookies, null, 2));
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---------------------------------------------------------- 爬虫功能 */

  ipcMain.handle('cap:cfg', (_e, payload) => {
    const { key, value } = payload || {};
    return settings.applySetting(key, value);
  });
  ipcMain.handle('cap:cfgAll', () => Object.assign({}, settings.values));
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
      if (kind === 'rowsCsv') return { ok: true, text: format.rowsToCsv(data) };
      if (kind === 'tablesCsv') return { ok: true, text: format.tablesToCsv(data) };
      return { ok: false, error: '未知格式' };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:saveText', (_e, payload) => files.saveTextFile(payload));
  ipcMain.handle('cap:saveBodies', (_e, dir) => files.saveBodies(dir));
  ipcMain.handle('cap:exportHar', async (_e, file) => {
    try {
      const har = format.buildHar(state.records, state.view ? state.view.webContents.getTitle() : '');
      const name = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.har`;
      return await files.saveTextFile({ defaultName: name, content: JSON.stringify(har, null, 2), file });
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('cap:replay', (_e, id) => capture.replay(id));

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
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  settings.registerBlocker();          // 必须在任何导航之前注册（同一 session 只能注册一个监听器）
  settings.hydrate();                  // 磁盘设置灌进内存，控件与拦截器都读同一份
  registerIpc();
  createWindow();
  watchGpu();
  // GPU 状态需要一点时间上报，面板首帧之后再判定（首次采样后还会二次复核，见 checkGpuOnce）
  if (state.win) state.win.webContents.once('did-finish-load', () => setTimeout(checkGpuOnce, 3000));
  if (state.selftest) {
    require('./selftest.js').run({ state, store, gpu, capture, extract, settings, automation, format, files, PARTITION, TOOLBAR_H, layout });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
