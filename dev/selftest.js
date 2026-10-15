'use strict';
/*
 * 自检（--selftest）：本地起一个测试服务器，驱动抓取链路并断言结果。
 * 覆盖：XHR/Fetch 响应体、POST 请求体、Set-Cookie、重定向链、WebSocket 帧、
 *      页面 HTML / document.cookie / localStorage 采集、Cookie 存储读取。
 * 不覆盖系统保存对话框（无法自动化）。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ICO 读取（自检用）----
function readIco(file) {
  const buf = fs.readFileSync(file);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    entries.push({
      w: buf.readUInt8(e) || 256, h: buf.readUInt8(e + 1) || 256,
      bits: buf.readUInt16LE(e + 6), size: buf.readUInt32LE(e + 8), off: buf.readUInt32LE(e + 12),
    });
  }
  return { buf, reserved: buf.readUInt16LE(0), type: buf.readUInt16LE(2), count, entries };
}

// BMP 条目里自下而上存 RGBA，取某点返回 {r,g,b,a}
function bmpPixel(ico, entry, x, y) {
  const S = entry.w;
  const row = S - 1 - y;
  const p = entry.off + 40 + (row * S + x) * 4;
  return { b: ico.buf[p], g: ico.buf[p + 1], r: ico.buf[p + 2], a: ico.buf[p + 3] };
}

async function waitFor(fn, timeout = 20000, label = '条件') {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`超时等待：${label}`);
    await sleep(100);
  }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function page(title, port, nextHref, extraScript) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/style.css"></head><body>
<!-- SELFTEST-MARKER -->
<h1>${title}</h1>
<img src="/img.png" id="pic" alt="pic">
<div class="item"><span class="t">A</span><a href="/a">linkA</a></div>
<div class="item"><span class="t">B</span><a href="/b">linkB</a></div>
<div class="item"><span class="t">C</span><a href="/c">linkC</a></div>
<table><thead><tr><th>名称</th><th>数量</th></tr></thead>
<tbody><tr><td>苹果</td><td>3</td></tr><tr><td>香蕉</td><td>5</td></tr></tbody></table>
<input type="password" id="pw" name="pw">
<form action="/submit" method="post"><input name="q"><input name="page"></form>
${nextHref ? `<a class="next" href="${nextHref}">下一页</a>` : ''}
<div id="tall" style="height:900px"></div><div id="extraBox"></div>
<script>
  document.cookie = 'probe_cookie=1; path=/';
  localStorage.setItem('probe', '1');
  sessionStorage.setItem('sprobe', '2');
  fetch('/api/data').then(r => r.json());
  fetch('/api/data', { method: 'POST', body: 'ping=1' });
  fetch('/slow');
  const ws = new WebSocket('ws://127.0.0.1:${port}/ws');
  ws.onmessage = (e) => { window.__wsMsg = e.data; };
  let extraCount = 0;
  window.addEventListener('scroll', () => {
    if (extraCount >= 3) return;
    if (window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 20) return;
    extraCount++;
    const d = document.createElement('div');
    d.className = 'extra';
    d.textContent = 'extra-' + extraCount;
    document.getElementById('extraBox').appendChild(d);
    document.getElementById('tall').style.height = (900 + extraCount * 600) + 'px';
  });
  ${extraScript || ''}
<\/script></body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const hits = {};          // pathname -> 命中次数
    const lastHeaders = {};   // pathname -> 最后一次请求头
    const lastReq = {};       // pathname -> { method, headers }
    const hitsAt = {};        // pathname -> [命中时间戳]
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      hits[u.pathname] = (hits[u.pathname] || 0) + 1;
      lastHeaders[u.pathname] = req.headers;
      lastReq[u.pathname] = { method: req.method, headers: req.headers };
      (hitsAt[u.pathname] = hitsAt[u.pathname] || []).push(Date.now());
      const noStore = { 'Cache-Control': 'no-store' };
      // close() 之后 address() 为 null：退出途中的在途请求（浏览器 keep-alive 复用连接）仍会进来，别在这里再炸一次
      const addr = server.address();
      const port = addr ? addr.port : 0;
      if (u.pathname === '/api/data') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Set-Cookie': 'srv=abc123; Path=/; SameSite=Lax' }, noStore));
          res.end(JSON.stringify({ ok: true, method: req.method, echo: body }));
        });
        return;
      }
      if (u.pathname === '/slow') {
        res.writeHead(302, Object.assign({ Location: '/api/data' }, noStore));
        res.end();
        return;
      }
      if (u.pathname === '/api/needle') {                      // 断言 138：新记录命中 body 搜索
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, noStore));
        res.end(JSON.stringify({ 'needle-refresh': true }));
        return;
      }
      if (u.pathname === '/api/xss') {                         // 断言 166/167：详情面板必须把抓取内容当纯文本
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, noStore));
        res.end('</pre><img src=x onerror="window.__xss=1">');
        return;
      }
      if (u.pathname === '/api/fail') {                        // 断言 170：设置导入后的 Mock 改写
        res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, noStore));
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (u.pathname === '/dl.bin') {                          // 断言 145：带 Content-Disposition 的下载
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="probe.bin"' }, noStore));
        res.end(Buffer.from('probe-download'));
        return;
      }
      if (u.pathname === '/img.png') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'image/png' }, noStore));
        res.end(PNG_1PX);
        return;
      }
      if (u.pathname === '/style.css') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/css' }, noStore));
        res.end('body { margin: 0; background: url(/img.png); }');
        return;
      }
      if (u.pathname === '/manylinks') {                       // 断言 188：页面清单截断可见（2100 条链接）
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noStore));
        const anchors = Array.from({ length: 2100 }, (_, i) => `<a href="/manylinks/${i}">link-${i}</a>`).join('\n');
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>manylinks</title></head><body>${anchors}</body></html>`);
        return;
      }
      if (u.pathname === '/') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noStore));
        res.end(page('selftest', port, '/page/2'));
        return;
      }
      if (u.pathname === '/page/2') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noStore));
        res.end(page('selftest-2', port, '/page/3'));
        return;
      }
      if (u.pathname === '/page/3') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noStore));
        res.end(page('selftest-3', port, null));
        return;
      }
      res.writeHead(404, noStore); res.end('nope');
    });
    server.on('upgrade', (req, socket) => {
      socket.on('error', () => { /* 客户端 RST 忽略 */ });
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      const payload = Buffer.from('hello-ws');
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, lastHeaders, lastReq, hitsAt }));
  });
}

// 重新加载并等页面真正稳定（爬虫设置类断言全靠它，必须确保新一轮请求都发出去了）
function reloadAndWait(wc, ms = 900) {
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; setTimeout(res, ms); } };
    wc.once('did-finish-load', finish);
    wc.reload();
    setTimeout(finish, 8000);
  });
}

async function run({ state, store, gpu, extract, settings, automation, format, files, bundle, capture, logger, session, recorder, picker, resetActive, PARTITION, windowInitOptions, sandboxDirs }) {
  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, pass: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  };
  // 产物目录（含离线包镜像树与下面几个临时配置文件）只在失败时保留，方便排查；提到最前，早期断言也要用
  const outDir = path.join(os.tmpdir(), `wct-selftest-out-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  // 系统剪贴板是全局资源：并发跑两条自检时两边会互相覆盖。用到剪贴板的断言统一走这把文件锁串行化
  // （等 15 秒；锁文件可能是崩溃残留，抢不到就清掉重来一次）
  const withClipboard = async (fn) => {
    const lock = path.join(os.tmpdir(), 'wct-selftest-clipboard.lock');
    let fd = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { fd = fs.openSync(lock, 'wx'); break; } catch (e) { await sleep(100); }
    }
    if (fd === null) {
      try { fs.rmSync(lock, { force: true }); fd = fs.openSync(lock, 'wx'); } catch (e) { fd = null; }
    }
    try {
      return await fn();
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } try { fs.rmSync(lock, { force: true }); } catch (e) { /* 忽略 */ } }
    }
  };

  check('目标架构 ia32（Win7 32 位目标）', process.arch === 'ia32',
    `electron=${process.versions.electron} chromium=${process.versions.chrome} node=${process.versions.node} arch=${process.arch}`);

  // ---------------- 56-58 图标 ----------------
  try {
    const ico = readIco(path.join(__dirname, '..', 'build', 'icon.ico'));
    const structOk = ico.reserved === 0 && ico.type === 1 && ico.count === 7
      && ico.entries.every((e) => e.bits === 32 && e.off + e.size <= ico.buf.length);
    check('图标文件结构', structOk, `${ico.count} 个条目，${ico.buf.length} 字节`);
    const sizes = ico.entries.map((e) => e.w);
    check('图标尺寸齐全', !sizes.some((s, i) => s !== [16, 24, 32, 48, 64, 128, 256][i]), sizes.join('/'));

    const e16 = ico.entries[0];
    const corners = [bmpPixel(ico, e16, 0, 0), bmpPixel(ico, e16, 15, 0), bmpPixel(ico, e16, 0, 15), bmpPixel(ico, e16, 15, 15)];
    let white = 0;
    let blue = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const p = bmpPixel(ico, e16, x, y);
        if (p.r > 240 && p.g > 240 && p.b > 240 && p.a > 200) white++;
        if (p.b > 150 && p.b > p.r + 20) blue++;
      }
    }
    check('图标像素合理', corners.every((c) => c.a === 0) && white > 0 && blue > 0,
      `角透明=${corners.every((c) => c.a === 0)} 白像素=${white} 蓝像素=${blue}`);
  } catch (e) {
    check('图标文件结构', false, e.message);
  }

  // ---------------- 59-62 设置持久化 ----------------
  try {
    const probeProxy = 'http://127.0.0.1:1080';
    await settings.applySetting('proxy', probeProxy);
    store.flush();
    const live = store.filePath();
    const onDisk = JSON.parse(fs.readFileSync(live, 'utf8'));
    check('设置写盘', onDisk.settings.proxy === probeProxy, `${live}`);

    const reread = store.readFile(live);
    check('设置读回', reread.data.settings.proxy === probeProxy && store.get().settings.proxy === probeProxy);
    check('未知键被丢弃', (() => {
      const tmp = path.join(outDir, 'keys', 'settings.json');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: { proxy: 'x', evil: 1 } }), 'utf8');
      const r = store.readFile(tmp);
      return r.data.settings.evil === undefined && r.data.settings.proxy === 'x';
    })());

    const badPath = path.join(outDir, 'bad', 'settings.json');
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, '{ 不是 JSON', 'utf8');
    const bad = store.readFile(badPath);
    check('坏配置自愈', bad.badFile && fs.existsSync(bad.badFile) && !fs.existsSync(badPath)
      && bad.data.settings.blockMode === 'none' && bad.error, `${bad.error} → ${path.basename(bad.badFile)}`);

    await settings.applySetting('proxy', '');
    store.flush();
  } catch (e) {
    check('设置写盘', false, e.message);
  }

  // ---------------- 63-64 无显卡判定 ----------------
  try {
    const looks = (s) => gpu.statusLooksSoftware(s);
    check('无显卡判定（纯函数）',
      looks({ gpu_compositing: 'disabled_software' }) === true
      && looks({ gpu_compositing: 'unavailable_software' }) === true
      && looks({ gpu_compositing: 'enabled' }) === false
      && looks(null) === false
      && looks({}) === false,
      `本机 gpu_compositing=${gpu.describe().gpuCompositing || '(未知)'}`);

    const wantSw = process.argv.includes('--software-rendering');
    check('软件渲染模式一致性', state.softwareMode === wantSw,
      `softwareMode=${state.softwareMode} 启动参数=${wantSw ? '有' : '无'} --software-rendering`);
  } catch (e) {
    check('无显卡判定（纯函数）', false, e.message);
  }

  const { server, hits, lastHeaders, lastReq, hitsAt } = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wc = state.view.webContents;

  // 窗口被其它窗口遮挡时 Chromium 会推迟滚动事件与合成帧（截图空白、计时器节流），自检期间强制置顶
  try { state.win.setAlwaysOnTop(true); state.win.moveTop(); state.win.focus(); } catch (e) { /* 无窗口环境忽略 */ }
  const raiseWin = () => { try { state.win.moveTop(); state.win.focus(); } catch (e) { /* 无窗口环境忽略 */ } };

  // 看门狗：卡死时也要退出并留下最后一条断言，避免整个自检无声挂起
  // 上限放宽到 10 分钟：老机器（单核/机械盘/无显卡）整套跑完是这里的 3~5 倍时间
  const watchdog = setTimeout(() => {
    console.log('FAIL  自检看门狗超时（600s），进程强制退出');
    require('electron').app.exit(2);
  }, 600000);

  // 面板侧的两个执行器 + 产物目录：提到 try 之外，套件末尾那几项（会改全局状态）也要用
  const panel = state.win.webContents;
  const peval = (expr) => panel.executeJavaScript(expr, true);
  const pinvoke = (channel, ...args) => panel.executeJavaScript(
    `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`, true);

  try {
    await waitFor(() => wc.debugger.isAttached() && state.status === '抓取中', 15000, 'CDP 就绪');
    await wc.loadURL(base + '/');
    await waitFor(() => state.records.some((r) => r.url === base + '/api/data' && r.status === 200 && r.body), 20000, 'API 响应体');
    await waitFor(() => state.records.some((r) => r.method === 'POST' && r.postData), 20000, 'POST 请求体');
    await waitFor(() => state.wsFrames.some((f) => f.kind === 'recv' && f.payload === 'hello-ws'), 20000, 'WebSocket 帧');
    await waitFor(() => state.records.some((r) => r.redirects.length > 0), 20000, '重定向链');
    await sleep(500);

    const get = state.records.find((r) => r.url === base + '/api/data' && r.method === 'GET' && r.body);
    check('GET 响应体已捕获', get && JSON.parse(get.body).ok === true);
    check('GET 状态码/MIME', get && get.status === 200 && /json/.test(get.mime), get && `${get.status} ${get.mime}`);
    check('响应头含 Set-Cookie（原始头）',
      get && JSON.stringify(get.responseHeadersRaw || []).includes('srv=abc123'));
    check('GET 请求头已捕获', get && Object.keys(get.requestHeaders || {}).length > 0);
    const post = state.records.find((r) => r.method === 'POST' && r.postData);
    check('POST 请求体已捕获', post && post.postData.includes('ping=1'), post && post.postData);
    const redir = state.records.find((r) => r.redirects.length > 0);
    check('重定向链已记录', redir && /\/slow$/.test(redir.redirects[0].url), redir && `${redir.redirects[0].status} ${redir.redirects[0].url} → ${redir.url}`);
    check('WebSocket 帧已记录', state.wsFrames.some((f) => f.payload === 'hello-ws'));

    const pd = await extract.collectPageData();
    check('页面 HTML 已采集', pd.html.includes('SELFTEST-MARKER'), `${pd.html.length} 字符`);
    check('document.cookie 已采集', /probe_cookie=1/.test(pd.page.cookies || ''));
    check('localStorage 已采集', pd.page.localStorage && pd.page.localStorage.probe === '1');
    check('sessionStorage 已采集', pd.page.sessionStorage && pd.page.sessionStorage.sprobe === '2');
    check('Cookie 存储读取（含 httpOnly 能力）', pd.cookies.some((c) => c.name === 'srv' && c.value === 'abc123'),
      `${pd.cookies.length} 条`);
    check('document.title 已采集', pd.title === 'selftest', pd.title);

    // ---- 面板 UI（renderer.js 端到端：列表渲染 / 详情展开 / WebSocket 计数）----
    const listState = await peval(`(() => {
      const rows = [...document.querySelectorAll('#list .row')];
      const hit = rows.find(r => r.children[2].textContent.includes('/api/data'));
      if (hit) hit.click();
      return { rows: rows.length, found: !!hit, count: document.getElementById('count').textContent };
    })()`);
    check('面板请求列表已渲染', listState.rows > 0 && listState.found, `${listState.rows} 行，计数 ${listState.count}`);
    await waitFor(async () => (await peval(`document.getElementById('detail').textContent`)).includes('"ok":true'), 8000, '面板详情响应体').catch(() => {});
    const detail = await peval(`(() => {
      const d = document.getElementById('detail');
      return { text: d.textContent, on: d.classList.contains('on') };
    })()`);
    check('面板详情：响应体已展示', detail.text.includes('"ok":true'), `可见=${detail.on} 文本=${JSON.stringify(detail.text.slice(0, 200))}`);
    check('面板详情：原始响应头 Set-Cookie 已展示', detail.text.includes('srv=abc123'));
    check('面板详情：请求头已展示', /User-Agent|Accept/i.test(detail.text));
    const wsInfo = await peval(`({ n: document.getElementById('nWs').textContent, kids: document.getElementById('ws').children.length })`);
    check('面板 WebSocket 计数', Number(wsInfo.n) >= 1, `${wsInfo.kids} 帧`);

    // ---------------- 20-27 拦截 / 记录过滤 / 限速 / UA / 请求头 / 代理 ----------------
    const cfg = (key, value) => settings.applySetting(key, value);

    // 20 资源拦截：被拦的请求根本不会到达服务器
    const imgBefore = hits['/img.png'] || 0;
    const apiBefore = hits['/api/data'] || 0;
    check('拦截模式设置成功', (await cfg('blockMode', 'assets')).ok === true);
    await reloadAndWait(wc);
    check('资源拦截生效（图片请求未发出）', (hits['/img.png'] || 0) === imgBefore,
      `/img.png 命中 ${imgBefore} → ${hits['/img.png'] || 0}`);
    check('资源拦截不影响接口请求', (hits['/api/data'] || 0) > apiBefore,
      `/api/data 命中 ${apiBefore} → ${hits['/api/data'] || 0}`);

    // 21 关闭拦截后恢复
    await cfg('blockMode', 'none');
    const img2 = hits['/img.png'] || 0;
    await reloadAndWait(wc);
    check('关闭拦截后图片恢复加载', (hits['/img.png'] || 0) > img2, `/img.png 命中 ${img2} → ${hits['/img.png'] || 0}`);

    // 22 关键字拦截
    await cfg('blockMode', 'keywords');
    await cfg('blockKeywords', 'api/data');
    const api2 = hits['/api/data'] || 0;
    await reloadAndWait(wc);
    check('关键字拦截生效（接口请求未发出）', (hits['/api/data'] || 0) === api2, `/api/data 命中 ${api2} → ${hits['/api/data'] || 0}`);
    await cfg('blockMode', 'none');
    await cfg('blockKeywords', '');

    // 23 仅记 XHR/Fetch
    await cfg('recordOnly', true);
    resetActive();                                                // 等价于面板「清空」
    await reloadAndWait(wc);
    check('仅记 XHR/Fetch', state.records.length > 0 && state.records.every((r) => r.type === 'XHR' || r.type === 'Fetch'),
      `${state.records.length} 条，类型=${[...new Set(state.records.map((r) => r.type))].join('/')}`);
    await cfg('recordOnly', false);

    // 24 限速
    check('限速档位切换成功', (await cfg('throttle', '3g')).ok === true);
    await reloadAndWait(wc, 200);
    await waitFor(() => state.records.some((r) => r.method === 'GET' && r.url.endsWith('/api/data') && r.duration != null), 20000, '限速下的接口记录');
    const slowRec = [...state.records].reverse().find((r) => r.method === 'GET' && r.url.endsWith('/api/data') && r.duration != null);
    check('限速生效（请求耗时增加）', slowRec && slowRec.duration >= 200, slowRec ? `${slowRec.duration}ms` : '无记录');
    await cfg('throttle', 'off');

    // 25 自定义 UA
    const UA = 'Mozilla/5.0 (Windows NT 6.1) TestUA/1.0';
    await cfg('ua', UA);
    await reloadAndWait(wc);
    check('自定义 UA 生效', (lastHeaders['/'] || {})['user-agent'] === UA, String((lastHeaders['/'] || {})['user-agent']));

    // 26 自定义请求头注入（Referer 由浏览器按 referrer policy 控制，不作为注入断言）
    await cfg('headers', 'X-Probe=42; X-Token=abc');
    await reloadAndWait(wc);
    const injected = lastHeaders['/'] || {};
    check('自定义请求头注入（X-Probe）', injected['x-probe'] === '42', String(injected['x-probe']));
    check('自定义请求头注入（X-Token）', injected['x-token'] === 'abc', String(injected['x-token']));
    check('请求头格式校验', (await cfg('headers', 'not-a-header-line')).ok === false);
    await cfg('headers', '');
    await cfg('ua', '');

    // 27 代理配置落地
    const ses = require('electron').session.fromPartition(PARTITION);
    const p1 = await cfg('proxy', 'http://127.0.0.1:1080');
    const resolved = await ses.resolveProxy('http://example.com/');
    check('代理配置落地（resolveProxy）', p1.ok === true && /127\.0\.0\.1:1080/.test(resolved), resolved);
    const p2 = await cfg('proxy', '');
    const resolved2 = await ses.resolveProxy('http://example.com/');
    check('代理清除后恢复直连', p2.ok === true && /^DIRECT/.test(resolved2), resolved2);

    await cfg('blockMode', 'none');
    await reloadAndWait(wc);

    // ---------------- 28-30 数据提取 ----------------
    const ex = await extract.extractRows('.item', '标题=.t\n链接=a@href');
    check('CSS 选择器提取', ex.ok && ex.count === 3, ex.ok ? `${ex.count} 行` : ex.error);
    check('提取字段：文本', ex.ok && ex.rows[0].标题 === 'A', ex.ok ? String(ex.rows[0].标题) : '');
    check('提取字段：属性解析为绝对 URL', ex.ok && String(ex.rows[0].链接).startsWith(base + '/a'), ex.ok ? String(ex.rows[0].链接) : '');
    const exBad = await extract.extractRows('', '标题=.t');
    check('提取入参校验（空选择器）', exBad.ok === false && /行选择器/.test(exBad.error || ''), exBad.error);

    const hv = await extract.harvest();
    check('页面清单：链接/图片/表单/表格', hv.ok && hv.links.length >= 3 && hv.images.length >= 1 && hv.forms.length >= 1 && hv.tables.length >= 1,
      hv.ok ? `links=${hv.links.length} images=${hv.images.length} forms=${hv.forms.length} tables=${hv.tables.length}` : hv.error);
    check('页面清单：表格表头与数据行', hv.ok && hv.tables[0].headers[0] === '名称' && hv.tables[0].rows[0][0] === '苹果',
      hv.ok ? `${JSON.stringify(hv.tables[0].headers)} ${JSON.stringify(hv.tables[0].rows[0])}` : '');
    check('页面清单：表单字段', hv.ok && hv.forms[0].fields.join(',') === 'q,page', hv.ok ? hv.forms[0].fields.join(',') : '');
    check('页面清单：图片解析为绝对地址', hv.ok && String(hv.images[0].src).startsWith(base + '/img.png'), hv.ok ? hv.images[0].src : '');

    // ---------------- 30 表格 CSV ----------------
    const csv = format.tablesToCsv(hv.tables);
    check('表格转 CSV', csv.includes('名称') && csv.includes('苹果'), `${csv.length} 字符`);

    // ---------------- 31 自动滚动 ----------------
    raiseWin();
    let sc = await automation.autoRun({ mode: 'scroll', rounds: 5 });
    let extraCount = await extract.evalPage('document.querySelectorAll(".extra").length');
    // 窗口被遮挡 / 合成被节流时滚动事件可能丢：置顶后重试（最多 3 次，每次给 4 秒有界等待）
    for (let i = 0; i < 3 && !extraCount; i++) {
      raiseWin();
      await sleep(400);
      sc = await automation.autoRun({ mode: 'scroll', rounds: 5 });
      extraCount = await waitFor(() => extract.evalPage('document.querySelectorAll(".extra").length'), 4000, '无限加载追加').catch(() => 0);
    }
    const scrollDiag = await extract.evalPage('JSON.stringify({h: document.documentElement.scrollHeight, ih: window.innerHeight, y: Math.round(window.scrollY)})');
    check('自动滚动触发无限加载', sc.ok && extraCount >= 1,
      sc.ok ? `轮次=${sc.rounds} reason=${sc.reason} .extra=${extraCount} 视口=${scrollDiag} view=${JSON.stringify(state.view.getBounds())} win=${JSON.stringify(state.win.getContentBounds())} visible=${state.win.isVisible()}` : sc.error);

    // ---------------- 32 自动翻页 ----------------
    const pg = await automation.autoRun({ mode: 'page', pages: 3, delay: 300 });
    const endUrl = wc.getURL();
    check('自动翻页到达第 3 页', pg.ok && /\/page\/3$/.test(endUrl), pg.ok ? `pages=${pg.pages} reason=${pg.reason} url=${endUrl}` : pg.error);
    check('自动翻页中间页已抓取', state.records.some((r) => /\/page\/2$/.test(r.url)));

    // ---------------- 33 响应体批量存盘 ----------------
    const tmpDir = path.join(outDir, 'save-bodies');
    const saved = await files.saveBodies(tmpDir);
    const savedFiles = saved.ok ? fs.readdirSync(saved.dir) : [];
    const hitOk = savedFiles.some((f) => fs.readFileSync(path.join(saved.dir, f), 'utf8').includes('"ok":true'));
    check('响应体批量存盘', saved.ok && saved.written >= 1 && hitOk, saved.ok ? `${saved.written} 个文件 → ${saved.dir}` : saved.error);

    // ---------------- 34 HAR ----------------
    const har = format.buildHar(state.records, 'selftest');
    const harOk = har.log.entries.length === state.records.length;
    const harBody = har.log.entries.some((e) => e.response.content.text && e.response.content.text.includes('"ok":true'));
    check('HAR 导出结构', harOk && harBody, `entries=${har.log.entries.length} records=${state.records.length}`);
    check('HAR 含请求体与失败字段', har.log.entries.some((e) => e.request.postData && e.request.postData.text === 'ping=1'));

    // ---------------- 35 cURL ----------------
    const postRec = state.records.find((r) => r.method === 'POST' && r.postData === 'ping=1');
    const curl = postRec ? format.buildCurl(postRec) : '';
    check('cURL 生成', curl.includes('-X POST') && curl.includes("--data-raw 'ping=1'"), curl.slice(0, 120));

    // ---------------- 36 请求重放 ----------------
    const apiHitBefore = hits['/api/data'] || 0;
    const rp = await capture.replay(postRec.id);
    check('请求重放', rp.ok && rp.status === 200 && String(rp.body).includes('"ok":true'),
      rp.ok ? `${rp.status} ${rp.tookMs}ms` : rp.error);
    check('重放到达服务器', (hits['/api/data'] || 0) > apiHitBefore);

    // ---------------- 37-38 面板爬虫控件与模态框 ----------------
    const idsPresent = await peval(`['blockMode','throttle','uaSel','headers','proxy','autoScroll','autoPage','extract','harvest','saveBodies','expHar']
      .filter((id) => !document.getElementById(id))`);
    check('面板爬虫控件齐备', idsPresent.length === 0, idsPresent.length ? `缺失 ${idsPresent.join(',')}` : '全部存在');

    const modalOpen = await peval(`(() => { document.getElementById('extract').click(); return !document.getElementById('modal').hidden; })()`);
    check('提取模态框可打开', modalOpen === true);

    await peval(`(() => {
      const tas = document.querySelectorAll('#modalBody textarea');
      tas[0].value = '.item';
      tas[1].value = '标题=.t\\n链接=a@href';
      document.getElementById('extractRun').click();
      return true;
    })()`);
    await waitFor(async () => (await peval('document.querySelectorAll("#modalBody tbody tr").length')) === 3, 8000, '提取预览表格').catch(() => {});
    const previewRows = await peval('document.querySelectorAll("#modalBody tbody tr").length');
    check('提取模态框预览 3 行', previewRows === 3, `${previewRows} 行`);
    await peval('document.getElementById("modalClose").click()');
    const modalClosed = await peval('document.getElementById("modal").hidden');
    check('模态框可关闭', modalClosed === true);

    // ---------------- 65-66 UI 精修元素与轻提示 ----------------
    const missingEls = await peval(`['toasts','banner','bannerText','bannerActions','bannerClose','appSettings']
      .filter((id) => !document.getElementById(id))`);
    check('面板新元素齐备', missingEls.length === 0, missingEls.length ? `缺失 ${missingEls.join(',')}` : '全部存在');

    await peval(`(() => { window.__alerted = false; window.alert = () => { window.__alerted = true; }; return true; })()`);
    await peval(`(() => {
      document.getElementById('extract').click();
      const tas = document.querySelectorAll('#modalBody textarea');
      tas[0].value = '';
      tas[1].value = '标题=.t';
      document.getElementById('extractRun').click();
      return true;
    })()`);
    await waitFor(async () => (await peval('document.querySelectorAll("#toasts .toast").length')) >= 1, 8000, '错误 toast').catch(() => {});
    const toastState = await peval(`(() => {
      const t = document.querySelector('#toasts .toast');
      return { n: document.querySelectorAll('#toasts .toast').length, alerted: window.__alerted, text: t ? t.textContent : '', cls: t ? t.className : '' };
    })()`);
    check('错误提示走 toast', toastState.n >= 1 && toastState.alerted !== true,
      `toast=${toastState.n} alert=${toastState.alerted} 文本=${JSON.stringify(toastState.text)} class=${toastState.cls}`);
    await peval(`(() => {
      const b = document.getElementById('toasts');
      while (b.firstChild) b.removeChild(b.firstChild);
      document.getElementById('modalClose').click();
      return true;
    })()`);

    // ================================================== 68-97 打磨与新增功能

    // 68 响应体截断查看
    try {
      const html = await peval(`bodyBlock({ id: -1, body: 'x'.repeat(250000), bodyBase64: false })`);
      check('响应体截断查看', html.includes('已截断显示前 200KB') && html.length < 250000, `HTML ${html.length} 字符`);
    } catch (e) { check('响应体截断查看', false, e.message); }

    // 69 响应体另存（文本）
    try {
      const rec = state.records.find((r) => r.url === base + '/api/data' && r.method === 'GET' && r.body);
      const f69 = path.join(outDir, 'body.json');
      const r69 = await pinvoke('cap:saveBody', rec.id, 'response', f69);
      check('响应体另存为文件', r69.ok && fs.existsSync(f69) && fs.readFileSync(f69, 'utf8').includes('"ok":true'), r69.error || f69);
    } catch (e) { check('响应体另存为文件', false, e.message); }

    // 70 面板宽度拖拽
    try {
      const dragTo = (w) => `(() => {
        const x = Math.max(8, window.innerWidth - ${w});
        const sp = document.getElementById('splitter');
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: 200, buttons: 1 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 200, buttons: 1 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: 200, buttons: 0 }));
        return Math.round(document.getElementById('panel').getBoundingClientRect().width);
      })()`;
      const drag = await peval(dragTo(700));
      await sleep(300);
      const mid = await pinvoke('cap:list');
      const restored = await peval(dragTo(520));
      await sleep(300);
      check('面板宽度拖拽', drag >= 690 && drag <= 710 && mid.panelWidth === drag && restored >= 510 && restored <= 530,
        `拖到 ${drag}px，主进程 panelWidth=${mid.panelWidth}，恢复 ${restored}px`);
    } catch (e) { check('面板宽度拖拽', false, e.message); }

    // 71 详情渲染节流
    try {
      await pinvoke('cap:setEnabled', false);      // 暂停抓取，排除 cap:update 噪声
      await peval(`(() => { const row = document.querySelector('#list .row'); if (row) row.click(); return true; })()`);
      await sleep(300);
      const t1 = await peval('window.__detailRenders || 0');
      await peval(`(() => { for (let i = 0; i < 20; i++) scheduleDetailRender(detailId); return true; })()`);
      await sleep(1800);   // 窗口被遮挡时 Chromium 会把计时器对齐到 1s，等足 1.8s 再判定
      const t2 = await peval('window.__detailRenders || 0');
      await pinvoke('cap:setEnabled', true);
      check('详情渲染节流（200ms 合并）', t2 - t1 >= 1 && t2 - t1 <= 2, `渲染次数 ${t1} → ${t2}`);
    } catch (e) { check('详情渲染节流（200ms 合并）', false, e.message); }

    // 166 详情面板把抓取内容当纯文本（不是 HTML）
    try {
      await state.view.webContents.loadURL(base + '/api/xss');
      const rec166 = await waitFor(() => state.records.find((r) => r.url === base + '/api/xss' && r.body), 20000, 'XSS 样本记录');
      await peval(`(() => { el.filter.value = ''; el.filter.dispatchEvent(new Event('input', { bubbles: true })); select(${rec166.id}); return true; })()`);
      await waitFor(() => peval(`document.getElementById('detail').textContent.includes('onerror')`), 8000, '详情渲染 XSS 样本').catch(() => {});
      const xss166 = await peval(`({
        imgs: document.querySelectorAll('#detail img').length,
        text: document.getElementById('detail').textContent.includes('onerror'),
        tag: document.getElementById('detail').querySelector('img') ? 'injected' : 'text-only',
      })`);
      await state.view.webContents.loadURL(base + '/');
      check('详情内容不被解析为 HTML', xss166.imgs === 0 && xss166.text && xss166.tag === 'text-only',
        `注入 img=${xss166.imgs} 原文可见=${xss166.text}`);
    } catch (e) { check('详情内容不被解析为 HTML', false, e.message); }

    // 167 面板拒绝页面发起的导航（详情里注入的 <a>/<meta refresh> 不能把窗口带走）
    try {
      const before167 = state.win.webContents.getURL();
      await peval(`(() => { window.location.href = 'http://127.0.0.1:1/blocked'; return true; })()`).catch(() => {});
      await sleep(600);
      const after167 = state.win.webContents.getURL();
      check('面板拒绝页面发起的导航', after167 === before167 && after167.startsWith('file://'),
        `${before167} → ${after167}`);
    } catch (e) { check('面板拒绝页面发起的导航', false, e.message); }

    // 72 诊断日志
    try {
      logger.log('test', 'hello-selftest');
      const seen = logger.tail(50).includes('hello-selftest');
      fs.appendFileSync(logger.filePath(), 'x'.repeat(logger.MAX_BYTES + 2048));
      logger.log('test', 'after-rotate');
      const rotated = fs.existsSync(logger.filePath() + '.1');
      check('诊断日志写入与滚动', seen && rotated, `尾部可见=${seen} 滚动文件=${rotated}`);
    } catch (e) { check('诊断日志写入与滚动', false, e.message); }

    // 73 快捷键（定位类）
    try {
      const loc = await peval(`(() => {
        const kd = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
        kd('l'); const l = document.activeElement.id;
        kd('f'); const f = document.activeElement.id;
        return { l, f };
      })()`);
      check('快捷键（Ctrl+L / Ctrl+F 定位）', loc.l === 'url' && loc.f === 'filter', `Ctrl+L → ${loc.l}，Ctrl+F → ${loc.f}`);
    } catch (e) { check('快捷键（Ctrl+L / Ctrl+F 定位）', false, e.message); }

    // 74 快捷键（动作类）
    try {
      const before = await peval(`document.getElementById('toggle').textContent`);
      await peval(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
      await sleep(300);
      const toggleAfter = await peval(`document.getElementById('toggle').textContent`);
      await pinvoke('cap:setEnabled', true);
      const escState = await peval(`(() => {
        document.getElementById('extract').click();
        const opened = !document.getElementById('modal').hidden;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return { opened, closed: document.getElementById('modal').hidden };
      })()`);
      const arrow = await peval(`(() => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        const kd = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        kd('ArrowDown');
        const one = document.querySelector('#list .row.sel');
        kd('ArrowDown');
        const two = document.querySelector('#list .row.sel');
        return { rows: document.querySelectorAll('#list .row').length, one: one && one.dataset.id, two: two && two.dataset.id };
      })()`);
      check('快捷键（Ctrl+P / Esc / 方向键）',
        toggleAfter !== before && escState.opened && escState.closed && arrow.rows > 1 && arrow.two && arrow.one !== arrow.two,
        `切换=${before}→${toggleAfter} 模态=${escState.opened}/${escState.closed} 选中=${arrow.one}→${arrow.two}`);
    } catch (e) { check('快捷键（Ctrl+P / Esc / 方向键）', false, e.message); }

    // 75 过滤语法
    try {
      const f = await peval(`(() => {
        const rec = { id: 1, method: 'GET', url: 'http://127.0.0.1/x/api/data?a=1', type: 'XHR', status: 404, mime: 'application/json', size: 204800, duration: 650 };
        return {
          method: matchQuery(rec, 'method:get'),
          status4xx: matchQuery(rec, 'status:4xx'),
          statusGe: matchQuery(rec, 'status:>=400'),
          statusLt: matchQuery(rec, 'status:<500'),
          statusLtNo: matchQuery(rec, 'status:<300'),
          type: matchQuery(rec, 'type:xhr'),
          mime: matchQuery(rec, 'mime:json'),
          domain: matchQuery(rec, 'domain:127.0.0.1'),
          size: matchQuery(rec, 'size:>100k'),
          time: matchQuery(rec, 'time:>500'),
          andAll: matchQuery(rec, 'method:get status:4xx'),
          andMiss: matchQuery(rec, 'method:get status:5xx'),
          negTrue: matchQuery(rec, '!nomatch'),
          negFalse: matchQuery(rec, '!data'),
        };
      })()`);
      const ok = f.method && f.status4xx && f.statusGe && f.statusLt && !f.statusLtNo && f.type && f.mime && f.domain && f.size && f.time
        && f.andAll && !f.andMiss && f.negTrue && !f.negFalse;
      check('过滤语法（字段 / 比较 / 取反）', ok, JSON.stringify(f));
    } catch (e) { check('过滤语法（字段 / 比较 / 取反）', false, e.message); }

    // 76 列预设切换与落盘
    try {
      const colState = await peval(`(() => {
        const sel = document.getElementById('colSet');
        sel.value = 'dt';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const z = document.querySelector('#list .row .z');
        return { cols: document.getElementById('list').dataset.cols, zDisplay: z ? getComputedStyle(z).display : 'none', zText: z ? z.textContent : '' };
      })()`);
      await sleep(500);
      store.flush();
      const colOnDisk = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
      const restored = await peval(`(() => {
        const sel = document.getElementById('colSet');
        sel.value = 'd';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return document.getElementById('list').dataset.cols;
      })()`);
      await sleep(500);
      store.flush();
      check('列预设切换与落盘',
        colState.cols === 'dt' && colState.zDisplay !== 'none' && colState.zText.length > 0 && colOnDisk.settings.colSet === 'dt' && restored === 'd',
        `列=${colState.cols} z=${colState.zDisplay} 落盘=${colOnDisk.settings.colSet} 恢复=${restored}`);
    } catch (e) { check('列预设切换与落盘', false, e.message); }

    // 77 导出筛选结果
    try {
      const oneRec = [...state.records].reverse().find((r) => r.url.startsWith(base));
      const f77 = path.join(outDir, 'one.json');
      const r77 = await pinvoke('cap:exportAll', [oneRec.id], f77);
      const json = JSON.parse(fs.readFileSync(f77, 'utf8'));
      check('导出筛选结果', r77.ok && json.requests.length === 1 && json.requests[0].id === oneRec.id && json.requestCount === 1,
        `requests=${json.requests.length} id=${json.requests[0] && json.requests[0].id}`);
    } catch (e) { check('导出筛选结果', false, e.message); }

    // 78 Cookie 增删改
    try {
      const set1 = await pinvoke('cap:cookieSet', { url: base + '/', name: 'probe_ck', value: 'v1' });
      const list1 = await pinvoke('cap:cookies');
      const removed = await pinvoke('cap:cookieRemove', { url: base + '/', name: 'probe_ck' });
      const list2 = await pinvoke('cap:cookies');
      const had = (list1.cookies || []).some((c) => c.name === 'probe_ck' && c.value === 'v1');
      const gone = !(list2.cookies || []).some((c) => c.name === 'probe_ck');
      check('Cookie 增删改', set1.ok && had && removed.ok && gone, `设置=${set1.ok} 可见=${had} 删除=${gone}`);
    } catch (e) { check('Cookie 增删改', false, e.message); }

    // 79 Cookie 导入
    try {
      const imp = await pinvoke('cap:cookieImport', { text: 'a=1; b=2', url: base + '/' });
      const list = await pinvoke('cap:cookies');
      const names = (list.cookies || []).map((c) => c.name);
      check('Cookie 导入（Cookie 头形式）', imp.ok && imp.added === 2 && names.includes('a') && names.includes('b'),
        `added=${imp.added} 现有=${names.join(',')}`);
      await pinvoke('cap:cookieRemove', { url: base + '/', name: 'a' });
      await pinvoke('cap:cookieRemove', { url: base + '/', name: 'b' });
    } catch (e) { check('Cookie 导入（Cookie 头形式）', false, e.message); }

    // 80 Storage 编辑
    try {
      const setr = await pinvoke('cap:storageSet', { area: 'local', key: 'probe2', value: 'v2' });
      const pd2 = await extract.collectPageData();
      const seen = pd2.page.localStorage && pd2.page.localStorage.probe2 === 'v2';
      const delr = await pinvoke('cap:storageRemove', { area: 'local', key: 'probe2' });
      const pd3 = await extract.collectPageData();
      const gone = !(pd3.page.localStorage || {}).probe2;
      check('Storage 编辑', setr.ok && seen && delr.ok && gone, `写入=${seen} 删除=${gone}`);
    } catch (e) { check('Storage 编辑', false, e.message); }

    // 81 Netscape 导出
    try {
      const f81 = path.join(outDir, 'cookies.txt');
      const r81 = await pinvoke('cap:exportCookies', { format: 'netscape', file: f81 });
      const lines = fs.readFileSync(f81, 'utf8').split('\n');
      const dataLine = lines.find((l) => l && !l.startsWith('#'));
      check('Cookie Netscape 导出',
        r81.ok && lines[0].includes('# Netscape HTTP Cookie File') && dataLine && dataLine.split('\t').length === 7,
        `${lines.length} 行，字段数=${dataLine ? dataLine.split('\t').length : 0}`);
    } catch (e) { check('Cookie Netscape 导出', false, e.message); }

    // 82 重放改写
    try {
      const postRec = state.records.find((r) => r.method === 'POST' && r.postData === 'ping=1');
      const rp = await capture.replay(postRec.id, { method: 'PUT', headers: 'X-Probe: 42' });
      const seen = lastReq['/api/data'] || {};
      check('重放改写（方法 / 请求头）', rp.ok && seen.method === 'PUT' && seen.headers && seen.headers['x-probe'] === '42',
        `status=${rp.status} method=${seen.method} x-probe=${seen.headers && seen.headers['x-probe']}`);
    } catch (e) { check('重放改写（方法 / 请求头）', false, e.message); }

    // 83 请求头行解析
    try {
      const ok = format.parseHeaderLines('A: 1\nB:2');
      const bad = format.parseHeaderLines('oops');
      check('请求头行解析', ok.ok && ok.value.A === '1' && ok.value.B === '2' && bad.ok === false,
        `${JSON.stringify(ok.value)} / ${bad.error}`);
    } catch (e) { check('请求头行解析', false, e.message); }

    // 84 请求体另存
    try {
      const postRec2 = state.records.find((r) => r.method === 'POST' && r.postData === 'ping=1');
      const f84 = path.join(outDir, 'req.txt');
      const r84 = await pinvoke('cap:saveBody', postRec2.id, 'request', f84);
      check('请求体另存为文件', r84.ok && fs.readFileSync(f84, 'utf8') === 'ping=1', r84.error || f84);
    } catch (e) { check('请求体另存为文件', false, e.message); }

    // 85 可见区域截图
    try {
      const f85 = path.join(outDir, 'visible.png');
      let r85 = await pinvoke('cap:screenshot', { mode: 'visible', file: f85 });
      let buf = fs.existsSync(f85) ? fs.readFileSync(f85) : Buffer.alloc(0);
      if (!buf.length) {                                   // 窗口被遮挡时 capturePage 会给出空图，置顶后重试一次
        raiseWin();
        await sleep(500);
        r85 = await pinvoke('cap:screenshot', { mode: 'visible', file: f85 });
        buf = fs.existsSync(f85) ? fs.readFileSync(f85) : Buffer.alloc(0);
      }
      check('可见区域截图', r85.ok && buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        `${buf.length} 字节 ${r85.error || ''}`);
    } catch (e) { check('可见区域截图', false, e.message); }

    // 86 整页截图（高度超过视口）
    try {
      const f86 = path.join(outDir, 'full.png');
      const r86 = await pinvoke('cap:screenshot', { mode: 'full', file: f86 });
      const buf = fs.readFileSync(f86);
      const h = buf.readUInt32BE(20);
      const viewport = state.view.getBounds().height;
      check('整页截图（超出视口）', r86.ok && h >= viewport, `高度=${h} 视口=${viewport} ${r86.error || ''}`);
    } catch (e) { check('整页截图（超出视口）', false, e.message); }

    // 87 打印为 PDF
    try {
      const f87 = path.join(outDir, 'page.pdf');
      const r87 = await pinvoke('cap:pdf', { file: f87 });
      const head = fs.readFileSync(f87).slice(0, 4).toString('latin1');
      check('打印为 PDF', r87.ok && head === '%PDF', `${head} ${r87.error || ''}`);
    } catch (e) { check('打印为 PDF', false, e.message); }

    // 88 页面内查找
    try {
      const r88 = await pinvoke('cap:find', 'linkA', { forward: true });
      const stop = await pinvoke('cap:findStop');
      check('页面内查找', r88.ok && r88.matches >= 1 && stop.ok, `matches=${r88.matches} active=${r88.active}`);
    } catch (e) { check('页面内查找', false, e.message); }

    // 89 会话写盘（口径：与 saveSync 返回的 count 对齐，内存条数在 save 前取样）
    try {
      const memAtSave = state.records.length;
      const saved = session.saveSync();
      const sessionOnDisk = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
      check('会话写盘', saved.ok && fs.existsSync(session.filePath()) && sessionOnDisk.records.length === saved.count && saved.count === Math.min(memAtSave, 2000),
        `${sessionOnDisk.records.length} 条 / 内存 ${memAtSave} 条（save 返回 ${saved.count}）`);
    } catch (e) { check('会话写盘', false, e.message); }

    // 90 会话恢复（跨进程 + 面板横幅路径）
    try {
      const info = await pinvoke('cap:sessionInfo');
      const restored = await pinvoke('cap:sessionRestore');
      // 面板横幅「恢复」：渲染端 → IPC → 列表整表重建
      await peval(`(() => {
        showBanner('自检：发现上次会话', [{ id: 'restoreSession', label: '恢复', primary: true }, { id: 'discardSession', label: '忽略' }]);
        document.querySelector('#bannerActions button').click();
        return true;
      })()`);
      await waitFor(async () => Number(await peval('rows.size')) === restored.count && restored.count > 0,
        8000, '横幅恢复列表').catch(() => {});
      const memRows = await peval('rows.size');
      const domRowsNow = await peval('document.querySelectorAll("#list .row").length');
      // 面板横幅「忽略」：删除会话文件
      await peval(`(() => { document.querySelectorAll('#bannerActions button')[1].click(); return true; })()`);
      await sleep(300);
      const discarded = await pinvoke('cap:sessionInfo');
      check('会话恢复',
        info.exists === true && restored.ok && restored.count === Math.min(info.count, 2000) && restored.records.length === restored.count
          && memRows === restored.count && domRowsNow >= 1 && domRowsNow <= 80 && discarded.exists === false,
        `exists=${info.exists} 写盘 ${info.count} 条 / 恢复 ${restored.count} 条 / 面板内存 ${memRows} 行（DOM ${domRowsNow}） / 忽略后存在=${discarded.exists}`);
    } catch (e) { check('会话恢复', false, e.message); }

    // 91 会话体积裁剪
    try {
      const fake = [];
      for (let i = 0; i < 2500; i++) {
        fake.push({
          id: i + 1, cdpId: null, method: 'GET', url: `${base}/fake/${i}`, type: 'XHR', time: new Date().toISOString(),
          startedAt: null, requestHeaders: {}, requestHeadersRaw: null, postData: null,
          status: 200, statusText: 'OK', responseHeaders: null, responseHeadersRaw: null, mime: 'text/plain',
          encodedDataLength: 40960, duration: 5,
          body: 'y'.repeat(40960), bodyBase64: false, bodyError: null, failed: null,
          remoteIP: '', protocol: '', redirects: [], note: '',
        });
      }
      const real = state.records.slice();
      state.records.length = 0;
      for (const r of fake) state.records.push(r);
      const res = session.saveSync();
      const trimOnDisk = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
      const trimmed = trimOnDisk.records.filter((r) => r.body === null && String(r.bodyError || '').includes('体积上限'));
      state.records.length = 0;
      for (const r of real) state.records.push(r);
      check('会话体积裁剪', res.ok && trimOnDisk.records.length <= 2000 && trimmed.length >= 1,
        `${trimOnDisk.records.length} 条，省略响应体 ${trimmed.length} 条`);
    } catch (e) { check('会话体积裁剪', false, e.message); }

    // 92 请求间隔节奏（纯函数：注入时钟，同刻多次调用应逐次 +delay）
    try {
      settings.resetPacer(1000);
      const w = [settings.nextPaceWait(100, 1000), settings.nextPaceWait(100, 1000), settings.nextPaceWait(100, 1000)];
      const zeroDelay = settings.nextPaceWait(0, 5000);
      settings.resetPacer(0);
      const clockAhead = settings.nextPaceWait(100, 10000);     // 时钟已越过游标 → 不等待
      settings.resetPacer(0);
      check('请求间隔节奏（纯函数）',
        w[0] === 0 && w[1] === 100 && w[2] === 200 && zeroDelay === 0 && clockAhead === 0,
        `等待=${w.join('/')} 零间隔=${zeroDelay} 时钟超前=${clockAhead}`);
    } catch (e) { check('请求间隔节奏（纯函数）', false, e.message); }

    // 93 请求间隔节流（集成）
    try {
      await settings.applySetting('reqDelay', 300);
      const before = (hitsAt['/api/data'] || []).length;
      await reloadAndWait(wc, 200);
      await waitFor(() => (hitsAt['/api/data'] || []).length - before >= 3, 20000, '节流页面三连请求').catch(() => {});
      const times = (hitsAt['/api/data'] || []).slice(before);
      const spread = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
      await settings.applySetting('reqDelay', 0);
      check('请求间隔节流（集成）', times.length >= 3 && spread >= 500, `${times.length} 次命中，跨度 ${spread}ms`);
    } catch (e) { check('请求间隔节流（集成）', false, e.message); }

    // 94 新增设置持久化
    try {
      await settings.applySetting('reqDelay', 500);
      await settings.applySetting('ignoreCertErrors', true);
      await settings.applySetting('authUser', 'u');
      await sleep(400);
      store.flush();
      const cfgOnDisk = JSON.parse(fs.readFileSync(store.filePath(), 'utf8')).settings;
      const okPersist = cfgOnDisk.reqDelay === 500 && cfgOnDisk.ignoreCertErrors === true && cfgOnDisk.authUser === 'u';
      await settings.applySetting('reqDelay', 0);
      await settings.applySetting('ignoreCertErrors', false);
      await settings.applySetting('authUser', '');
      await sleep(400);
      store.flush();
      check('新增设置持久化', okPersist, `reqDelay=${cfgOnDisk.reqDelay} ignoreCert=${cfgOnDisk.ignoreCertErrors} authUser=${cfgOnDisk.authUser}`);
    } catch (e) { check('新增设置持久化', false, e.message); }

    // 95 多标签创建与隔离
    try {
      const before95 = (await pinvoke('cap:tabList')).length;   // 会话恢复可能已经重建了若干标签
      const tabReady = (marker) => waitFor(async () => {
        const tabs = await pinvoke('cap:tabList');
        if (!tabs.some((t) => String(t.url).includes(marker))) return false;
        await pinvoke('cap:tabActivate', tabs.find((t) => String(t.url).includes(marker)).id);
        return String((await pinvoke('cap:list')).url).includes(marker);
      }, 15000, `标签 ${marker} 就绪`);
      await pinvoke('cap:tabNew', `${base}/page/2?tab=2`);
      await tabReady('tab=2');
      await pinvoke('cap:tabNew', `${base}/page/3?tab=3`);
      await tabReady('tab=3');
      const tabs = await pinvoke('cap:tabList');
      const per = [];
      for (const t of tabs) {
        await pinvoke('cap:tabActivate', t.id);
        await sleep(400);
        const l = await pinvoke('cap:list');
        const marker = (String(l.url).match(/\?tab=\d+/) || [''])[0];
        per.push({
          id: t.id, url: l.url, count: l.records.length,
          hasOwn: l.records.some((r) => r.url === l.url),
          foreign: l.records.filter((r) => /\?tab=\d+/.test(r.url) && (!marker || !r.url.includes(marker))).length,
        });
      }
      const bad = per.filter((p) => !p.hasOwn || p.foreign > 0);
      check('多标签创建与隔离', tabs.length === before95 + 2 && bad.length === 0,
        per.map((p) => `#${p.id}${p.url.replace(base, '')} ${p.count}条 foreign=${p.foreign}`).join(' | '));
    } catch (e) { check('多标签创建与隔离', false, e.message); }

    // 96 标签切换与关闭
    try {
      const tabs = await pinvoke('cap:tabList');
      const first = tabs[0];
      const ref = state.tabs.find((t) => t.id === first.id);
      const act = await pinvoke('cap:tabActivate', first.id);
      await sleep(300);
      const l1 = await pinvoke('cap:list');
      const switched = act.ok && l1.activeTabId === first.id;
      const closed = await pinvoke('cap:tabClose', first.id);
      await sleep(300);
      const after = await pinvoke('cap:tabList');
      const destroyed = !!(ref && ref.wc.isDestroyed());
      await pinvoke('cap:navigate', `${base}/`);
      const l2 = await waitFor(async () => {
        const d = await pinvoke('cap:list');
        return d.records.some((r) => r.url === `${base}/`) ? d : null;
      }, 20000, '导航后新记录').catch(() => ({ records: [] }));
      check('标签切换与关闭', switched && closed.ok && after.length === tabs.length - 1 && destroyed && l2.records.some((r) => r.url === `${base}/`),
        `切换=${switched} 剩余=${after.length} 视图已销毁=${destroyed} 新标签记录=${l2.records.length}`);
    } catch (e) { check('标签切换与关闭', false, e.message); }

    // 97 标签栏 UI
    try {
      const tabs = await pinvoke('cap:tabList');
      await sleep(300);
      const ui = await peval(`(() => ({
        strip: !!document.getElementById('tabstrip'),
        list: !!document.getElementById('tabList'),
        btn: !!document.getElementById('tabNew'),
        chips: document.querySelectorAll('#tabstrip .tabchip').length,
      }))()`);
      check('标签栏 UI', ui.strip && ui.list && ui.btn && ui.chips === tabs.length, `chips=${ui.chips} tabs=${tabs.length}`);
    } catch (e) { check('标签栏 UI', false, e.message); }

    /* ================================================== 98-102 会话录制 */

    const readRec = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recDir = recorder.dirPath();
    let recFile = '';

    // 98 录制启动与清单
    try {
      const st = await pinvoke('cap:recStart', { shots: false });
      recFile = st.file || '';
      const man = st.ok && fs.existsSync(recFile) ? readRec(recFile).find((l) => l.k === 'manifest') : null;
      check('录制启动与清单',
        st.ok === true && !!man && man.v === 1 && !!man.viewport && man.viewport.w > 0
          && !!man.settings && man.settings.reqDelay !== undefined,
        `${path.basename(recFile)} ${man ? `viewport=${man.viewport.w}x${man.viewport.h}` : (st.error || '无 manifest')}`);
    } catch (e) { check('录制启动与清单', false, e.message); }

    // 99 交互事件（含密码掩码）
    try {
      await extract.evalPage(`(() => {
        const pw = document.getElementById('pw');
        pw.value = 'secret';
        pw.dispatchEvent(new Event('input', { bubbles: true }));
        pw.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await extract.evalPage(`(() => { const a = document.querySelector('.item a'); if (a) a.click(); return !!a; })()`);
      await sleep(800);
      const lines = readRec(recFile);
      const inputEv = lines.find((l) => l.k === 'action' && l.a === 'input' && String(l.sel || '').includes('#pw'));
      const clickEv = lines.find((l) => l.k === 'action' && l.a === 'click');
      check('录制交互事件（含密码掩码）',
        !!inputEv && inputEv.value === '[password]' && !!clickEv,
        `input=${inputEv ? `${inputEv.sel}/${inputEv.value}` : '无'} click=${clickEv ? clickEv.sel : '无'} 共 ${lines.length} 行`);
    } catch (e) { check('录制交互事件（含密码掩码）', false, e.message); }

    // 100 请求/响应/导航与关联
    try {
      const lines = readRec(recFile);
      const clickEv = lines.find((l) => l.k === 'action' && l.a === 'click');
      const reqEv = lines.find((l) => l.k === 'req' && /\/a$/.test(String(l.url)));
      const resEv = reqEv ? lines.find((l) => l.k === 'res' && l.id === reqEv.id) : null;
      const navEv = lines.find((l) => l.k === 'nav' && /\/a$/.test(String(l.url)));
      check('录制网络与导航（关联触发它的点击）',
        !!reqEv && !!resEv && !!navEv && !!clickEv && reqEv.after === clickEv.n,
        `req=${reqEv ? `${reqEv.method} ${reqEv.url}` : '无'} res=${resEv ? resEv.status : '无'} nav=${!!navEv} after=${reqEv && reqEv.after}/${clickEv && clickEv.n}`);
    } catch (e) { check('录制网络与导航（关联触发它的点击）', false, e.message); }

    // 101 停止、摘要与负例
    try {
      const st = await pinvoke('cap:recStop');
      const lines = readRec(recFile);
      const summary = lines[lines.length - 1];
      const md = st.ok && fs.existsSync(st.mdFile) ? fs.readFileSync(st.mdFile, 'utf8') : '';
      const again = await pinvoke('cap:recStop');
      const st2 = await pinvoke('cap:recStart', { shots: false });
      const dup = await pinvoke('cap:recStart', { shots: false });
      await pinvoke('cap:recStop');
      check('录制停止与摘要',
        st.ok === true && fs.existsSync(st.mdFile) && md.includes('## 时间线') && md.includes('统计：')
          && !!summary && summary.k === 'summary' && summary.reason === 'manual' && st.entries === summary.entries
          && again.ok === false && again.error === '当前没有录制'
          && st2.ok === true && dup.ok === false && dup.error === '已在录制中',
        `${path.basename(recFile)} ${st.entries} 条 · md=${md.length} 字符 · 负例=${again.error}/${dup.error}`);
    } catch (e) { check('录制停止与摘要', false, e.message); }

    // 102 点击截图开关
    try {
      await settings.applySetting('recShots', true);
      await sleep(400);
      store.flush();
      const onDisk = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
      const st = await pinvoke('cap:recStart', {});         // 不传 shots → 走设置值
      await sleep(200);
      await extract.evalPage(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 })); return true; })()`);
      // 截图落盘 → 回填 shot 行是异步链，慢盘上 1.5s 固定等待会永久假 FAIL：改成有界等待两个产物都在
      const shotEv = st.ok ? await waitFor(() => {
        const got = fs.readdirSync(recDir).some((f) => /-click-\d{3}\.png$/.test(f));
        const ev = readRec(st.file).find((l) => l.k === 'shot');
        return got && ev ? ev : null;
      }, 10000, '点击截图落盘并记账').catch(() => null) : null;
      const shots = fs.readdirSync(recDir).filter((f) => /-click-\d{3}\.png$/.test(f));
      await pinvoke('cap:recStop');
      await settings.applySetting('recShots', false);
      await sleep(300);
      store.flush();
      check('录制点击截图开关',
        onDisk.settings.recShots === true && st.ok === true && shots.some((f) => f.endsWith('-click-001.png')) && !!shotEv,
        `落盘=${onDisk.settings.recShots} 截图=${shots.length} [${shots.slice(0, 2).join(', ')}] shot 记录=${!!shotEv}`);
    } catch (e) { check('录制点击截图开关', false, e.message); }

    /* ============================================ 103-117 第二轮打磨 */

    const electronClipboard = require('electron').clipboard;

    // 103 导出文件名带站点（纯函数）
    try {
      const at = Date.UTC(2026, 9, 13, 10, 0, 0);
      const n1 = files.exportBaseName('capture', 'https://example.com/a/b', at);
      const n2 = files.exportBaseName('page', 'about:blank', at);
      const n3 = files.exportBaseName('shot', 'http://127.0.0.1:8080/x', at);
      const n4 = files.exportBaseName('capture', 'not a url', at);
      check('导出文件名带站点前缀',
        n1 === 'example.com-capture-2026-10-13T10-00-00-000Z' && n2 === 'page-2026-10-13T10-00-00-000Z'
          && n3 === '127.0.0.1-shot-2026-10-13T10-00-00-000Z' && n4 === 'capture-2026-10-13T10-00-00-000Z',
        `${n1} | ${n2} | ${n3} | ${n4}`);
    } catch (e) { check('导出文件名带站点前缀', false, e.message); }

    // 104 设置导出/导入
    try {
      const f104 = path.join(outDir, 'cfg-export.json');
      await settings.applySetting('reqDelay', 700);
      const ex = await pinvoke('cap:cfgExport', { file: f104 });
      const exported = JSON.parse(fs.readFileSync(f104, 'utf8'));
      await settings.applySetting('reqDelay', 0);
      const im = await pinvoke('cap:cfgImport', { file: f104 });
      const memAfter = settings.values.reqDelay;
      store.flush();
      const afterImport = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
      const bad = await pinvoke('cap:cfgImport', { file: path.join(outDir, 'not-exist.json') });
      await settings.applySetting('reqDelay', 0);
      store.flush();
      check('设置导出/导入',
        ex.ok && exported.settings.reqDelay === 700 && im.ok && im.applied >= 1
          && memAfter === 700 && afterImport.settings.reqDelay === 700 && bad.ok === false,
        `导出 reqDelay=${exported.settings.reqDelay} 导入 applied=${im.applied} 内存=${memAfter} 磁盘=${afterImport.settings.reqDelay} 坏文件=${bad.ok}`);
    } catch (e) { check('设置导出/导入', false, e.message); }

    // 104b 导入的 Mock 规则立刻生效（不同步 Fetch 域的话规则要到重启才起作用）
    try {
      const cfgMock = await pinvoke('cap:cfgAll');
      const fMock = path.join(outDir, 'cfg-mock.json');
      fs.writeFileSync(fMock, JSON.stringify({
        version: 1,
        settings: Object.assign({}, cfgMock, {
          mock: {
            on: true,
            rules: [{ on: true, urlRe: `^http://127\\.0\\.0\\.1:\\d+/api/fail`, status: 204,
              headers: 'X-Mock-Import: 1', body: '', bodyBase64: false }],
          },
        }),
      }), 'utf8');
      const imMock = await pinvoke('cap:cfgImport', { file: fMock });
      const msMock = await pinvoke('cap:mockGet');
      await sleep(300);
      const gotMock = await extract.evalPage(`fetch('/api/fail').then((r) => r.status).catch((e) => 'err:' + e.message)`);
      const uiMock = await peval(`({ nReq: document.getElementById('nReq').textContent })`);
      const offMock = await pinvoke('cap:mockSet', { on: false, rules: [] });
      check('导入的 Mock 规则立即生效', imMock.ok && msMock.ok && msMock.mock.on === true && gotMock === 204 && offMock.ok,
        `导入=${imMock.ok} 开关=${msMock.mock && msMock.mock.on} /api/fail 实际状态码=${gotMock}（规则 204）`);
    } catch (e) { check('导入的 Mock 规则立即生效', false, e.message); }

    // 105 快捷键补齐（F5 / Alt+←→ / Ctrl+S）
    try {
      const spy = await peval(`(() => {
        window.__spy = { reload: 0, back: 0, fwd: 0, exp: 0 };
        document.getElementById('reload').click = () => { window.__spy.reload++; };
        document.getElementById('back').click = () => { window.__spy.back++; };
        document.getElementById('fwd').click = () => { window.__spy.fwd++; };
        document.getElementById('expFiltered').click = () => { window.__spy.exp++; };
        const kd = (key, extra) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, extra || {})));
        kd('F5');
        kd('ArrowLeft', { altKey: true });
        kd('ArrowRight', { altKey: true });
        kd('s', { ctrlKey: true });
        return window.__spy;
      })()`);
      await peval(`(() => {
        for (const id of ['reload', 'back', 'fwd', 'expFiltered']) delete document.getElementById(id).click;
        return true;
      })()`);
      check('快捷键补齐（F5 / Alt+←→ / Ctrl+S）',
        spy.reload === 1 && spy.back === 1 && spy.fwd === 1 && spy.exp === 1, JSON.stringify(spy));
    } catch (e) { check('快捷键补齐（F5 / Alt+←→ / Ctrl+S）', false, e.message); }

    // 106 详情复制按钮与状态栏复制
    try {
      await peval(`(() => { const row = document.querySelector('#list .row'); if (row) row.click(); return !!row; })()`);
      await sleep(400);
      const hasBtns = await peval(`['copyUrl', 'copyRespHeaders', 'copyBody'].every((id) => !!document.getElementById(id))`);
      const pair105 = await withClipboard(async () => {
        await peval(`(() => { const b = document.getElementById('copyUrl'); if (b) b.click(); return true; })()`);
        await sleep(300);
        const url = electronClipboard.readText();
        const statusText = await peval(`document.getElementById('status').textContent`);
        await peval(`(() => { const s = document.getElementById('status'); s.textContent = 'probe-status'; s.click(); return true; })()`);
        await sleep(300);
        return { url, statusText, status: electronClipboard.readText() };
      });
      const clipUrl = pair105.url;
      const statusText = pair105.statusText;
      const clipStatus = pair105.status;
      check('详情复制按钮与状态栏复制',
        hasBtns && clipUrl.startsWith('http') && statusText.includes('已复制') && clipStatus === 'probe-status',
        `按钮=${hasBtns} 剪贴板=${clipUrl.slice(0, 40)} 状态=${statusText}`);
    } catch (e) { check('详情复制按钮与状态栏复制', false, e.message); }

    // 107 列表跟随与未读提示
    try {
      const follow = await peval(`(() => {
        const list = document.getElementById('list');
        listNew = 0; updateListNew();           // 只量这 60+3 条自己的未读数，不带上游遗留
        scrollListToBottom();                   // 从底部开始，才测得到「跟随」
        for (let i = 0; i < 60; i++) appendRecord({ id: 991000 + i, method: 'GET', url: 'http://pad/' + i, type: 'XHR', status: 200, size: 1, duration: 1, time: new Date().toISOString() });
        if (list.scrollHeight <= list.clientHeight) return { scrollable: false };
        list.scrollTop = 0;
        for (let i = 0; i < 3; i++) appendRecord({ id: 990001 + i, method: 'GET', url: 'http://x/new' + i, type: 'XHR', status: 200, size: 1, duration: 1, time: new Date().toISOString() });
        const btn = document.getElementById('listNew');
        return { scrollable: true, top: list.scrollTop, btn: btn.hidden ? '' : btn.textContent };
      })()`);
      const clickedNew = await peval(`(() => {
        document.getElementById('listNew').click();
        return { top: document.getElementById('list').scrollTop, hidden: document.getElementById('listNew').hidden };
      })()`);
      const cleaned = await peval(`(() => {
        let removed = 0;
        for (let i = 0; i < 60; i++) if (rows.has(991000 + i)) { dropRow(991000 + i); removed++; }
        for (let i = 0; i < 3; i++) if (rows.has(990001 + i)) { dropRow(990001 + i); removed++; }
        applySort(); updateListNew();
        return removed;
      })()`);
      check('列表跟随与未读提示',
        follow.scrollable === true && follow.top === 0 && follow.btn.includes('3 条新记录')
          && clickedNew.top > 0 && clickedNew.hidden === true && cleaned === 63,
        `可滚动=${follow.scrollable} 未读按钮=${JSON.stringify(follow.btn)} 点击后 top=${clickedNew.top} 清理=${cleaned}`);
    } catch (e) { check('列表跟随与未读提示', false, e.message); }

    // 108 列表虚拟滚动（去掉了 3000 行渲染上限：DOM 只保留窗口内的行）
    try {
      const cap108 = await peval(`(() => {
        for (let i = 0; i < 3006; i++) appendRecord({ id: 992000 + i, method: 'GET', url: 'http://cap/' + i, type: 'XHR', status: 200, size: 1, duration: 1, time: new Date().toISOString() });
        applySort();
        const note = document.getElementById('listNote');
        const inner = document.getElementById('listInner');
        return {
          dom: document.querySelectorAll('#list .row').length,
          size: rows.size,
          inner: Math.round(Number((inner.style.height || '0px').replace('px', ''))),
          note: note.hidden ? '' : note.textContent,
        };
      })()`);
      await peval(`ipcRenderer.invoke('cap:list').then((d) => { refreshActiveList(d); return true; })`);
      check('列表虚拟滚动',
        cap108.dom > 0 && cap108.dom <= 80 && cap108.size >= 3006 && cap108.inner === cap108.size * 26 && cap108.note === '',
        `DOM=${cap108.dom} 内存=${cap108.size} 内层高=${cap108.inner}px 提示=${JSON.stringify(cap108.note)}`);
    } catch (e) { check('列表虚拟滚动', false, e.message); }

    // 109 关闭标签可撤销
    try {
      const before109 = (await pinvoke('cap:tabList')).length;
      const nt = await pinvoke('cap:tabNew', `${base}/page/2`);
      await waitFor(() => pinvoke('cap:list').then((d) => String(d.url).includes('/page/2')), 15000, '新标签已导航').catch(() => {});
      // 抓包还在往新标签里追加，条数必须取「关闭那一刻」的：closeTab 返回的快照才是撤销要对齐的基准
      const cl = await pinvoke('cap:tabClose', nt.id);
      const un = await pinvoke('cap:tabUndo');
      const un2 = await pinvoke('cap:tabUndo');
      const after109 = await pinvoke('cap:tabList');
      check('关闭标签可撤销',
        cl.ok && cl.undoMs === 10000 && un.ok && un.records > 0 && un.records === cl.records
          && after109.length === before109 + 1 && un2.ok === false,
        `关闭=${cl.ok} 撤销记录=${un.records}（快照 ${cl.records}）标签 ${before109}→${after109.length}（新建+关闭+撤销）二次撤销=${un2.error}`);
    } catch (e) { check('关闭标签可撤销', false, e.message); }

    // 110 右键菜单（标签 / 记录行）
    try {
      const wm110 = await withClipboard(async () => {
        const menus = await peval(`(() => {
          const chip = document.querySelector('#tabList .tabchip');
          chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 60 }));
          const tabItems = [...document.querySelectorAll('#ctxMenu .ctx-item')].map((b) => b.textContent);
          hideContextMenu();
          const row = document.querySelector('#list .row');
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 120 }));
          const rowItems = [...document.querySelectorAll('#ctxMenu .ctx-item')].map((b) => b.textContent);
          const url = rows.get(Number(row.dataset.id)).rec.url;
          const copyBtn = [...document.querySelectorAll('#ctxMenu .ctx-item')].find((b) => b.textContent === '复制 URL');
          if (copyBtn) copyBtn.click();
          return { tabItems, rowItems, url };
        })()`);
        await sleep(300);
        return { menus, clip: electronClipboard.readText() };
      });
      const menus = wm110.menus;
      const clip110 = wm110.clip;
      const need = (arr, label) => arr.includes(label);
      check('右键菜单（标签 / 记录行）',
        need(menus.tabItems, '复制 URL') && need(menus.tabItems, '重新加载') && need(menus.tabItems, '关闭其他') && need(menus.tabItems, '关闭')
          && need(menus.rowItems, '复制 URL') && need(menus.rowItems, '复制 cURL') && need(menus.rowItems, '重放') && need(menus.rowItems, '导出此条') && need(menus.rowItems, '另存响应体')
          && clip110 === menus.url,
        `标签项=${menus.tabItems.join('/')} 行项=${menus.rowItems.join('/')} 剪贴板一致=${clip110 === menus.url}`);
    } catch (e) { check('右键菜单（标签 / 记录行）', false, e.message); }

    // 111 设置应用到所有标签
    try {
      await settings.applySetting('ua', 'PolishProbe/1.0');
      const all = await pinvoke('cap:cfgAllTabs');
      const uas = state.tabs.map((t) => t.wc.getUserAgent());
      const okAll = all.ok && all.tabs === state.tabs.length && uas.every((u) => u === 'PolishProbe/1.0');
      await settings.applySetting('ua', '');
      await pinvoke('cap:cfgAllTabs');
      const uas2 = state.tabs.map((t) => t.wc.getUserAgent());
      check('设置应用到所有标签', okAll && uas2.every((u) => u === state.defaultUA),
        `${uas.length} 个标签统一=${okAll} 复位=${uas2.every((u) => u === state.defaultUA)}`);
    } catch (e) { check('设置应用到所有标签', false, e.message); }

    // 112 会话恢复标签布局与来源标记
    try {
      const tabsBefore112 = (await pinvoke('cap:tabList')).length;
      const realTabs = state.tabs.filter((t) => t.url && t.url !== 'about:blank').length;
      session.saveSync();
      const sess = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
      const restored112 = await pinvoke('cap:sessionRestore');
      await waitFor(async () => (await pinvoke('cap:tabList')).length === tabsBefore112 + sess.tabs.length, 15000, '恢复的标签已建').catch(() => {});
      const tabsAfter112 = (await pinvoke('cap:tabList')).length;
      const l112 = await pinvoke('cap:list');
      const domRestored = await peval(`(() => {
        document.getElementById('list').scrollTop = 1e9;   // 虚拟滚动：恢复的记录在尾部窗口里
        renderWindow();
        return !!document.querySelector('#list .row[data-restored="1"]');
      })()`);
      check('会话恢复标签布局与来源标记',
        Array.isArray(sess.tabs) && sess.tabs.length === Math.min(realTabs, 5) && restored112.ok
          && tabsAfter112 === tabsBefore112 + sess.tabs.length
          && l112.records.some((r) => r.restored === true) && domRestored,
        `保存 ${sess.tabs && sess.tabs.length} 标签（真实 ${realTabs}）/ 恢复后 ${tabsAfter112} 标签 / restored=${l112.records.filter((r) => r.restored).length} 条 / DOM 标记=${domRestored}`);
    } catch (e) { check('会话恢复标签布局与来源标记', false, e.message); }

    // 113 录制收尾（摘要可达 / 关窗也生成 md / 行首标标签）——开始与停止都走工具栏按钮，顺带覆盖 UI 链路
    try {
      await peval(`document.getElementById('recToggle').click()`);
      await waitFor(() => peval(`document.getElementById('recToggle').textContent.includes('停止录制')`), 8000, '录制已开始');
      const entriesBefore113 = recorder.status().entries;
      await extract.evalPage(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })); return true; })()`);
      await waitFor(() => recorder.status().entries > entriesBefore113, 8000, '点击已记账');
      await peval(`(() => { document.getElementById('status').textContent = ''; return true; })()`);
      await peval(`document.getElementById('recToggle').click()`);
      await waitFor(() => peval(`document.getElementById('recToggle').textContent.includes('开始录制')`), 8000, '录制已停止');
      // 状态栏可能被后续 cap:status 推送覆盖：在等到的这一刻把值取下来，而不是之后再读
      const st113 = await waitFor(() => peval(`document.getElementById('status').textContent.includes('录制完成') ? document.getElementById('status').textContent : null`), 8000, '状态栏显示摘要路径').catch(() => '');
      const i113 = await pinvoke('cap:recInfo');
      const md113 = i113.ok && fs.existsSync(i113.mdFile) ? fs.readFileSync(i113.mdFile, 'utf8') : '';
      const label113 = await peval(`document.getElementById('recToggle').textContent`);
      const r113b = await pinvoke('cap:recStart', { shots: false });
      await sleep(200);
      const flush113 = recorder.flushSync();
      const md113b = await waitFor(() => {
        if (!fs.existsSync(r113b.mdFile)) return null;
        const t = fs.readFileSync(r113b.mdFile, 'utf8');
        return t.includes('停止原因：退出') ? t : null;
      }, 10000, '录制摘要写入（退出原因）').catch(() => '');
      const tabPrefix = /^\[\d\d:\d\d\.\d\d\d\] #\d+ /m.test(md113);
      check('录制收尾（摘要可达 / 关窗也生成 md / 行首标标签）',
        i113.ok && tabPrefix && st113.includes('.md') && label113.includes('开始录制')
          && flush113.ok && md113b.includes('停止原因：退出'),
        `md=${path.basename(i113.mdFile || '')} 行首标签=${tabPrefix} 状态栏含路径=${st113.includes('.md')} 按钮复位=${label113.includes('开始录制')} 退出 md=${md113b.includes('停止原因：退出')}`);
    } catch (e) { check('录制收尾（摘要可达 / 关窗也生成 md / 行首标标签）', false, e.message); }

    // 114 录制中最近条目浮层
    try {
      await peval(`(() => { document.getElementById('recItems').innerHTML = ''; return true; })()`);
      const r114 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      await extract.evalPage(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })); return true; })()`);
      const read114 = () => peval(`(() => {
        const kids = [...document.querySelectorAll('#recItems > div')];
        return {
          hidden: document.getElementById('recPanel').hidden,
          n: kids.length,
          hasClick: kids.some((d) => d.textContent.includes('点击')),
          first: kids.length ? kids[0].textContent : '',
        };
      })()`);
      // 浮层只留最近 20 条：并发/繁忙时点击条目可能很快被挤出窗口，等它出现再断言（不再固定等 1s）
      const p114 = await waitFor(async () => {
        const p = await read114();
        return p.hasClick && p.n >= 1 ? p : null;
      }, 8000, '浮层出现点击条目').catch(() => null) || await read114();
      await pinvoke('cap:recStop');
      check('录制中最近条目浮层', r114.ok && p114.hidden === false && p114.n >= 1 && p114.hasClick,
        `可见=${!p114.hidden} 行数=${p114.n} 含点击=${p114.hasClick} 首行=${JSON.stringify(p114.first.slice(0, 60))}`);
    } catch (e) { check('录制中最近条目浮层', false, e.message); }

    // 115 日志过滤与行数上限
    try {
      logger.log('test', 'RECPROBE-A');
      logger.log('test', 'RECPROBE-B');
      const t115 = await pinvoke('cap:logTail', { lines: 1000, filter: 'RECPROBE' });
      const t115b = await pinvoke('cap:logTail', { lines: 1200 });
      const lines115 = t115.text ? t115.text.split('\n') : [];
      check('日志过滤与行数上限',
        t115.ok && lines115.length >= 2 && lines115.every((l) => l.includes('RECPROBE')) && t115b.ok && t115b.count <= 1200,
        `命中 ${lines115.length} 行全匹配=${lines115.every((l) => l.includes('RECPROBE'))} 无过滤 ${t115b.count} 行`);
    } catch (e) { check('日志过滤与行数上限', false, e.message); }

    // 116 WebSocket 视图过滤 / 暂停 / 清空
    try {
      await peval(`(() => { const f = document.getElementById('wsFilter'); f.value = 'hello-ws'; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await sleep(500);
      const w1 = await peval(`(() => {
        const kids = [...document.getElementById('ws').children];
        return { n: kids.length, all: kids.every((k) => k.textContent.includes('hello-ws')) };
      })()`);
      const paused = await peval(`(() => {
        document.getElementById('wsPause').checked = true;
        const before = document.getElementById('ws').children.length;
        appendWs({ kind: 'recv', payload: 'probe-frame', time: Date.now() });
        return { before, after: document.getElementById('ws').children.length };
      })()`);
      // 「清空显示」连主进程帧一起清（按钮名副其实）：点击后等 DOM 归零，主进程帧也应同时为 0
      await peval(`(() => { document.getElementById('wsClear').click(); return true; })()`);
      await waitFor(() => peval(`document.getElementById('ws').children.length === 0`), 5000, 'WS 清空生效');
      const cleared = await peval(`document.getElementById('ws').children.length`);
      const frames116 = await pinvoke('cap:ws');
      await peval(`(() => {
        document.getElementById('wsPause').checked = false;
        const f = document.getElementById('wsFilter');
        f.value = '';
        f.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      check('WebSocket 视图过滤/暂停/清空',
        w1.n >= 1 && w1.all && paused.before === paused.after && cleared === 0 && frames116.ok && frames116.frames.length === 0,
        `过滤后 ${w1.n} 行全命中=${w1.all} 暂停不动=${paused.before === paused.after} 清空后 DOM=${cleared} 主进程帧=${frames116.frames.length}`);
    } catch (e) { check('WebSocket 视图过滤/暂停/清空', false, e.message); }

    // 116b WebSocket 视图 DOM 上限（面板与主进程一致保留最近 2000 帧）
    try {
      const cap116b = await peval(`(() => {
        const box = document.getElementById('ws');
        box.innerHTML = '';
        for (let i = 0; i < 2100; i++) appendWs({ kind: 'recv', requestId: 'r' + i, opcode: 1, payload: 'frame-' + i, time: Date.now() });
        return { kids: box.children.length, n: document.getElementById('nWs').textContent, last: box.lastElementChild.textContent };
      })()`);
      check('WebSocket 视图 DOM 上限', cap116b.kids === 2000 && cap116b.n === '2000' && cap116b.last.includes('frame-2099'),
        `DOM=${cap116b.kids} 计数=${cap116b.n} 末帧=${cap116b.last.slice(-12)}`);
      await peval(`(() => { document.getElementById('wsClear').click(); return true; })()`);
    } catch (e) { check('WebSocket 视图 DOM 上限', false, e.message); }

    // 117 「关闭其他」标签
    try {
      const active117 = (await pinvoke('cap:tabList')).find((t) => t.active);
      const others117 = await pinvoke('cap:tabCloseOthers', active117.id);
      await sleep(400);
      const tabs117 = await pinvoke('cap:tabList');
      check('「关闭其他」标签',
        others117.ok && others117.closed >= 1 && tabs117.length === 1 && tabs117[0].id === active117.id,
        `关闭 ${others117.closed} 个 / 剩余 ${tabs117.length}`);
    } catch (e) { check('「关闭其他」标签', false, e.message); }

    /* ============================================ 118-132 第三轮：分析 / 导出 / 录制二期 / 页面工具 / 性能 */

    // 118 记录标记与备注（全走界面路径：行 → ★ 标记 → 备注输入）
    try {
      const id118 = await peval(`(() => {
        const row = [...document.querySelectorAll('#list .row')].find((n) => rows.get(Number(n.dataset.id)).rec.method === 'GET');
        if (!row) return null;
        row.click();
        return Number(row.dataset.id);
      })()`);
      await sleep(400);
      await peval(`(() => { document.getElementById('markStar').click(); return true; })()`);
      await sleep(400);
      await peval(`(() => { const c = document.getElementById('markComment'); c.value = 'probe-star'; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await sleep(400);
      const ui118 = await peval(`(() => {
        const row = document.querySelector('#list .row[data-id="${id118}"]');
        return {
          star: row ? row.dataset.star : '',
          btn: (document.getElementById('markStar') || {}).textContent || '',
          comment: (document.getElementById('markComment') || {}).value || '',
        };
      })()`);
      const d118 = await pinvoke('cap:detail', id118);
      await peval(`(() => {                                  // 复位：清备注 + 取消标记
        const c = document.getElementById('markComment');
        c.value = '';
        c.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('markStar').click();
        return true;
      })()`);
      await sleep(400);
      const off118 = await pinvoke('cap:detail', id118);
      check('记录标记与备注',
        id118 != null && ui118.star === '1' && ui118.btn.includes('已标记') && ui118.comment === 'probe-star'
          && !!d118 && d118.star === true && d118.comment === 'probe-star'
          && off118.star === false && off118.comment === '',
        `id=${id118} 列表标记=${ui118.star} 按钮=${JSON.stringify(ui118.btn)} 备注=${JSON.stringify(ui118.comment)} 详情=${d118 && d118.star}/${d118 && d118.comment} 复位=${off118 && off118.star}/${JSON.stringify(off118 && off118.comment)}`);
    } catch (e) { check('记录标记与备注', false, e.message); }

    // 119 概览统计
    try {
      const s119 = format.buildStats(state.records);
      const r119 = await pinvoke('cap:stats');
      const sumType = s119.byType.reduce((n, x) => n + x.count, 0);
      const sumStatus = s119.byStatus.reduce((n, x) => n + x.count, 0);
      check('概览统计',
        s119.total === state.records.length && s119.total > 0 && sumType === s119.total && sumStatus === s119.total
          && s119.byDomain.length >= 1 && s119.slowest.length >= 1 && !!s119.slowest[0].url && !!r119 && r119.total === s119.total,
        `总数=${s119.total} 域名=${s119.byDomain.length} 类型合计=${sumType} 状态合计=${sumStatus} 最慢=${s119.slowest.length} 主进程=${r119 && r119.total}`);
    } catch (e) { check('概览统计', false, e.message); }

    // 120 瀑布图视图
    try {
      const w120 = await peval(`(() => {
        view = 'wf';
        syncTabs();
        const expect = [...rows.values()].filter((v) => matches(v.rec) && v.rec.time && v.rec.duration != null).length;
        const bars = [...document.querySelectorAll('#wf .wfrow')];
        const lefts = bars.map((b) => parseFloat(b.querySelector('.wfbar2').style.left));
        let mono = true;
        for (let i = 1; i < lefts.length; i++) if (lefts[i] < lefts[i - 1] - 0.01) mono = false;
        const out = {
          bars: bars.length, expect, mono,
          info: document.getElementById('wfInfo').textContent,
          n: document.getElementById('nWf').textContent,
          titled: bars.length ? bars[0].title : '',
        };
        view = 'list';
        syncTabs();
        return out;
      })()`);
      check('瀑布图视图',
        w120.bars === w120.expect && w120.bars >= 1 && w120.mono && w120.info.includes('跨度') && Number(w120.n) === w120.bars && w120.titled.includes('ms'),
        `条形=${w120.bars}/${w120.expect} 偏移单调=${w120.mono} 信息=${JSON.stringify(w120.info)} 计数=${w120.n}`);
    } catch (e) { check('瀑布图视图', false, e.message); }

    // 121 响应体全文搜索
    try {
      const s121 = await pinvoke('cap:searchBody', '"ok":true');
      const ids121 = new Set(state.records.map((r) => r.id));
      await peval(`(() => { const f = document.getElementById('filter'); f.value = 'body:"ok":true'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(900);
      const ui121 = await peval(`(() => {
        const scan = [...rows.values()].filter((r) => matches(r.rec)).length;   // 内存口径（虚拟滚动下 DOM 只是窗口切片）
        return {
          n: document.getElementById('nReq').textContent,
          note: document.getElementById('listNote').hidden ? '' : document.getElementById('listNote').textContent,
          scan,
          dom: document.querySelectorAll('#list .row').length,
          size: rows.size,
        };
      })()`);
      await peval(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(400);
      const after121 = await peval(`document.getElementById('nReq').textContent`);
      check('响应体全文搜索',
        s121.ok && s121.count >= 1 && s121.ids.every((id) => ids121.has(id)) && Number(ui121.n) === s121.count
          && ui121.note.includes('响应体命中') && Number(after121) > s121.count,
        `命中=${s121.count} 面板可见=${ui121.n}（DOM 扫描 ${ui121.scan}/${ui121.dom}，内存 ${ui121.size}）提示=${JSON.stringify(ui121.note)} 清空过滤后=${after121}`);
    } catch (e) { check('响应体全文搜索', false, e.message); }

    // 122 转代码（Python / Node）
    try {
      const post = state.records.find((r) => r.method === 'POST' && r.postData)
        || { id: -1, method: 'POST', url: 'http://127.0.0.1/x', postData: 'ping=1', requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' } };
      const py = format.buildPythonRequests(post);
      const nf = format.buildNodeFetch(post);
      const ax = format.buildNodeAxios(post);
      check('转代码（Python/Node）',
        py.includes('import requests') && py.includes('requests.request("POST"') && py.includes("'ping=1'") && py.includes(post.url)
          && nf.includes('await fetch(') && nf.includes('body: "ping=1"') && nf.includes(post.url)
          && ax.includes('axios.request({') && ax.includes(post.url),
        `python=${py.length} fetch=${nf.length} axios=${ax.length} url=${post.url}`);
    } catch (e) { check('转代码（Python/Node）', false, e.message); }

    // 123 Postman 导出
    try {
      const rec123 = state.records.find((r) => r.method === 'POST' && r.postData) || state.records[state.records.length - 1];
      const idCount123 = state.records.filter((r) => r.id === rec123.id).length;   // 撞号时导出就会多出一条
      const f123 = path.join(outDir, 'postman.json');
      const r123 = await pinvoke('cap:exportPostman', { ids: [rec123.id], file: f123 });
      const col = r123.ok && fs.existsSync(f123) ? JSON.parse(fs.readFileSync(f123, 'utf8')) : null;
      check('Postman 导出',
        r123.ok && !!col && String(col.info.schema).includes('v2.1.0') && col.item.length === 1
          && col.item[0].request.method === rec123.method && col.item[0].request.header.length >= 1,
        r123.error || `${path.basename(f123)} item=${col && col.item.length} method=${col && col.item[0].request.method} header=${col && col.item[0].request.header.length} 同 id 记录数=${idCount123}`);
    } catch (e) { check('Postman 导出', false, e.message); }

    // 124 Markdown 表格
    try {
      const syn124 = [0, 1, 2].map((i) => ({
        id: 900 + i, method: 'GET', url: i === 1 ? 'http://x/a|b' : `http://x/${i}`,
        status: 200, type: 'XHR', encodedDataLength: 10, duration: 5, star: i === 0,
      }));
      const md124 = format.buildMarkdownTable(syn124);
      const lines124 = md124.split('\n').filter(Boolean);
      check('Markdown 表格',
        lines124.length === 5 && lines124[0].includes('| URL |') && md124.includes('\\|') && md124.includes('★'),
        `行数=${lines124.length} 表头=${JSON.stringify(lines124[0])} 转义=${md124.includes('\\|')} 星标=${md124.includes('★')}`);
    } catch (e) { check('Markdown 表格', false, e.message); }

    // 125 录制重放（输入 + 点击 → 对新页面重放，服务端命中数增加）
    try {
      const view125 = state.view.webContents;      // 117 关掉了最早那个标签，这里重新取当前活动视图
      await view125.loadURL(base + '/');
      await sleep(900);
      const st125 = await pinvoke('cap:recStart', { shots: false });
      await extract.evalPage(`(() => {
        const inp = document.querySelector('form input[name=q]');
        inp.focus();
        inp.value = 'replay-probe';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      const before125 = hits['/b'] || 0;
      await extract.evalPage(`(() => { document.querySelector('a[href="/b"]').click(); return true; })()`);
      await sleep(900);
      const stopped125 = await pinvoke('cap:recStop');
      await view125.loadURL(base + '/');                     // 回到起始页，重放时元素才在
      await sleep(800);
      const rp125 = await pinvoke('cap:recReplay', { file: stopped125.file, speed: 0 });
      await sleep(400);
      const idle125 = await pinvoke('cap:recReplayStop');
      const after125 = hits['/b'] || 0;
      check('录制重放',
        stopped125.ok && rp125.ok && rp125.total >= 2 && rp125.done === rp125.total && (rp125.failed || []).length === 0
          && after125 > before125 && idle125.ok === false,
        `动作 ${rp125.done}/${rp125.total} 失败=${(rp125.failed || []).length} /b 命中 ${before125}→${after125} 空闲停止=${idle125.error}`);
    } catch (e) { check('录制重放', false, e.message); }

    // 126 录制列表与读取
    try {
      const list126 = await pinvoke('cap:recList');
      const file126 = Array.isArray(list126) && list126.length ? list126[0].file : '';
      const r126 = file126 ? await pinvoke('cap:recRead', { file: file126 }) : null;
      const outside126 = await pinvoke('cap:recRead', { file: path.join(outDir, 'nope.jsonl') });
      check('录制列表与读取',
        Array.isArray(list126) && list126.length >= 1 && !!list126[0].file && list126[0].size > 0 && typeof list126[0].entries === 'number'
          && !!r126 && r126.ok && r126.md.includes('## 时间线') && r126.actions.length >= 1 && outside126.ok === false,
        `列表=${list126.length} 首项=${list126[0].base} entries=${list126[0].entries} md=${r126 && r126.md.length} 动作=${r126 && r126.actions.length} 越界=${outside126.error}`);
    } catch (e) { check('录制列表与读取', false, e.message); }

    // 127 录制转脚本（纯函数）
    try {
      const sc127 = recorder.buildScript([
        { n: 1, t: 0, a: 'click', sel: '#go' },
        { n: 2, t: 100, a: 'input', sel: '#q', value: 'abc' },
        { n: 3, t: 200, a: 'scroll', y: 1200 },
      ], { url: 'http://x/' });
      check('录制转脚本',
        sc127.includes("await page.goto('http://x/')") && sc127.includes("await page.click('#go')")
          && sc127.includes("await page.fill('#q', 'abc')") && sc127.includes('window.scrollTo(0, 1200)'),
        `${sc127.length} 字符`);
    } catch (e) { check('录制转脚本', false, e.message); }

    // 128 元素拾取（页面里点选 → 选择器进剪贴板，取消后标志复位）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(800);
      const p128 = await pinvoke('cap:pickStart');
      await sleep(300);
      const armed128 = await extract.evalPage('!!window.__wctPickArmed');
      const clip128 = await withClipboard(async () => {
        await extract.evalPage(`(() => {
          const el = document.querySelector('#pw');
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        })()`);
        await sleep(700);
        return electronClipboard.readText();
      });
      const cancel128 = await pinvoke('cap:pickCancel');
      const off128 = await extract.evalPage('!!window.__wctPickArmed');
      check('元素拾取', p128.ok && armed128 === true && clip128 === '#pw' && cancel128.ok && off128 === false,
        `注入=${p128.ok} 页面标志=${armed128} 剪贴板=${JSON.stringify(clip128)} 取消=${cancel128.ok} 复位=${off128 === false}`);
    } catch (e) { check('元素拾取', false, e.message); }

    // 129 执行 JS
    try {
      const e129a = await pinvoke('cap:eval', '1+1');
      const e129b = await pinvoke('cap:eval', 'throw new Error("boom")');
      const e129c = await pinvoke('cap:eval', '   ');
      check('执行 JS',
        e129a.ok && e129a.value === '2' && e129b.ok === false && String(e129b.error).includes('boom') && e129c.ok === false,
        `1+1=${JSON.stringify(e129a.value)} 异常=${JSON.stringify((e129b.error || '').slice(0, 40))} 空串=${e129c.ok}`);
    } catch (e) { check('执行 JS', false, e.message); }

    // 130 一键清理运行时数据
    try {
      await pinvoke('cap:cookieSet', { url: base + '/', name: 'wipe_ck', value: '1' });
      await pinvoke('cap:storageSet', { area: 'local', key: 'wipe_k', value: '1' });
      logger.log('test', 'WIPEPROBE');
      const w130 = await pinvoke('cap:wipe', { targets: ['cookies', 'storage', 'logs'] });
      await sleep(300);
      const ck130 = await pinvoke('cap:cookies');
      const pd130 = await extract.collectPageData();
      const log130 = logger.tail(50);
      const leftCk = (ck130.cookies || []).some((c) => c.name === 'wipe_ck');
      const leftLs = (pd130.page.localStorage || {}).wipe_k;
      check('一键清理运行时数据',
        w130.ok && w130.done.length === 3 && w130.failed.length === 0 && !leftCk && !leftLs && log130 === '',
        `done=${w130.done.join('/')} failed=${w130.failed.join('/')} 残留 cookie=${leftCk} localStorage=${leftLs} 日志残留=${log130.length} 字符`);
    } catch (e) { check('一键清理运行时数据', false, e.message); }

    // 172 自检沙盒隔离真实登录态（cap:wipe 只清沙盒里的持久分区）
    try {
      const ud172 = require('electron').app.getPath('userData');
      const part172 = require('electron').session.fromPartition(PARTITION).getStoragePath();
      check('自检沙盒隔离真实登录态',
        ud172.includes('wct-selftest') && String(part172).includes('wct-selftest'),
        `userData=${ud172} 分区=${part172}`);
    } catch (e) { check('自检沙盒隔离真实登录态', false, e.message); }

    // 131 抓包事件批处理（100ms 合并后与主进程一致；已 drop 的更新不复活行）
    try {
      resetActive();
      await reloadAndWait(state.view.webContents);
      await waitFor(() => state.records.some((r) => String(r.url).endsWith('/')), 20000, '批处理夹具记录');
      await sleep(500);                       // 等在途批次冲刷，下面的镜头在同一 peval 里取两侧
      const ui131 = await peval(`(async () => {
        const d = await ipcRenderer.invoke('cap:list');   // 与 DOM 在同一个任务里取，避免中间再进新记录
        refreshActiveList(d);
        const scan = [...rows.values()].filter((r) => matches(r.rec)).length;
        applyBatch({ records: [{ id: 991001, method: 'GET', url: 'http://batch/probe', type: 'XHR', status: 200, size: 1, duration: 1, time: new Date().toISOString() }] });
        const appended = rows.has(991001);
        applyBatch({ drops: [991001], updates: [{ id: 991001, method: 'GET', url: 'http://batch/probe', type: 'XHR', status: 500, size: 1, duration: 1, time: new Date().toISOString() }] });
        return { memory: rows.size, noted: d.records.length, scan, nReq: Number(document.getElementById('nReq').textContent), dom: document.querySelectorAll('#list .row').length, appended, revived: rows.has(991001) };
      })()`);
      check('抓包事件批处理',
        ui131.memory === ui131.noted && ui131.dom > 0 && ui131.dom <= 80 && ui131.nReq === ui131.scan
          && ui131.appended === true && ui131.revived === false,
        `主进程 ${ui131.noted} 条 / 面板内存 ${ui131.memory} / DOM ${ui131.dom} / nReq=${ui131.nReq}（扫描 ${ui131.scan}）放入=${ui131.appended} drop 后更新复活=${ui131.revived}`);
    } catch (e) { check('抓包事件批处理', false, e.message); }

    // 132 计数增量与列表差量同步
    try {
      const sync132 = await peval(`(async () => {
        const first = document.querySelector('#list .row');
        const d = await ipcRenderer.invoke('cap:list');
        refreshActiveList(d);
        const firstAfter = document.querySelector('#list .row');
        const scan = document.querySelectorAll('#list .row').length;
        return {
          same: first === firstAfter,
          n: Number(document.getElementById('nReq').textContent),
          scan,
          total: Number(document.getElementById('count').textContent),
          size: rows.size,
        };
      })()`);
      check('计数与差量同步',
        sync132.same && sync132.n === sync132.total && sync132.total === sync132.size && sync132.scan >= 1 && sync132.scan <= 80,
        `首行节点保持=${sync132.same} nReq=${sync132.n}（窗口 ${sync132.scan} 行）count=${sync132.total}=${sync132.size}`);
    } catch (e) { check('计数与差量同步', false, e.message); }

    // 133 录制动作带元素标签链与类型（jsonl / .md 时间线 / 面板实时条目 / cap:recRead 投影 四条通路）
    try {
      const st133 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      await extract.evalPage(`(() => {                                  // 在 <form> 里的 <input name=q> 输入
        const inp = document.querySelector('form input[name=q]');
        inp.value = 'tag-probe';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);
      await extract.evalPage(`(() => {                                  // 合成 submit（不触发导航）
        document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await sleep(300);
      await extract.evalPage(`(() => {                                  // 点击 <a href="/b">linkB</a>（最后做：会导航）
        document.querySelector('a[href="/b"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await sleep(700);
      const items133 = await peval(`document.getElementById('recItems').textContent`);   // 录制中面板实时条目
      const st133b = await pinvoke('cap:recStop');
      const acts133 = readRec(st133b.file).filter((l) => l.k === 'action');
      const click133 = acts133.find((x) => x.a === 'click' && x.tag === 'a');
      const input133 = acts133.find((x) => x.a === 'input');
      const submit133 = acts133.find((x) => x.a === 'submit');
      const md133 = st133b.ok && fs.existsSync(st133b.mdFile) ? fs.readFileSync(st133b.mdFile, 'utf8') : '';
      const rd133 = await pinvoke('cap:recRead', { file: st133b.file });
      const a133 = (rd133.actions || []).find((x) => x.a === 'input');
      check('录制动作带元素标签链与类型',
        st133.ok && !!click133 && click133.chain.includes('div.item') && click133.chain.includes('html')
          && !!input133 && input133.type === 'text' && input133.chain.startsWith('input')
          && !!submit133 && submit133.tag === 'form'
          && md133.includes('点击 a ← div.item') && md133.includes('输入 input ← form')
          && md133.includes(click133.sel)
          && items133.includes('点击 a ← div.item')
          && !!a133 && a133.tag === 'input' && typeof a133.type === 'string' && a133.chain.startsWith('input'),
        `click=${click133 && click133.chain} · sel=${click133 && click133.sel} input=${input133 && input133.chain} type=${input133 && input133.type} submit=${submit133 && submit133.tag} md=${md133.includes('点击 a ← div.item')}/${md133.includes('输入 input ← form')}/${md133.includes(click133.sel)} 面板=${items133.includes('点击 a ← div.item')} 投影 type=${a133 && typeof a133.type}`);
    } catch (e) { check('录制动作带元素标签链与类型', false, e.message); }

    // 134 回放脚本按元素类型分派（readRecording 投影补 type 后，checkbox → check、select → selectOption）
    try {
      const sc134 = recorder.buildScript([
        { n: 1, t: 0, a: 'change', sel: '#cb', tag: 'input', type: 'checkbox', checked: true },
        { n: 2, t: 100, a: 'change', sel: '#sel', tag: 'select', type: 'select-one', value: 'v' },
      ], { url: 'http://x/' });
      check('转脚本按类型分派',
        sc134.includes("await page.check('#cb')") && sc134.includes("await page.selectOption('#sel', 'v')"),
        sc134.split('\n').filter((l) => l.includes('page.')).join(' | '));
    } catch (e) { check('转脚本按类型分派', false, e.message); }

    // 135 录制条目点击即复制 CSS 选择器（写爬虫直接拿去用）
    try {
      const st135 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      await state.view.webContents.loadURL(base + '/');   // 133 的点击把页面导航到了 /b，这里先回起始页
      await sleep(900);
      await extract.evalPage(`(() => { document.querySelector('a[href="/a"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
      await sleep(800);
      const t135 = await withClipboard(async () => {
        const title = await peval(`(() => {
          const items = [...document.querySelectorAll('#recItems > div')];
          const hit = items.reverse().find((d) => d.onclick);
          if (!hit) return '';
          hit.click();
          return hit.title;
        })()`);
        await sleep(300);
        return { title, clip: electronClipboard.readText() };
      });
      const title135 = t135.title;
      const clip135 = t135.clip;
      const st135b = await pinvoke('cap:recStop');
      const sels135 = st135b.ok ? readRec(st135b.file).filter((l) => l.k === 'action' && l.a === 'click').map((l) => l.sel) : [];
      check('录制条目复制选择器',
        st135.ok && !!title135 && !!clip135 && sels135.includes(clip135) && String(title135).includes(clip135),
        `剪贴板=${JSON.stringify(clip135)} 条目 title=${JSON.stringify(title135)} 录制里的点击选择器=${JSON.stringify(sels135)}`);
    } catch (e) { check('录制条目复制选择器', false, e.message); }

    // 136 导出/复制按内存过滤（不再受 3000 行渲染上限影响）
    try {
      const cap136 = await peval(`(() => {
        for (let i = 0; i < 3006; i++) appendRecord({ id: 993000 + i, method: 'GET', url: 'http://cap136/' + i, type: 'XHR', status: 200, size: 1, duration: 1, time: new Date().toISOString() });
        const f = document.getElementById('filter');
        f.value = 'cap136';
        const hit = filteredIds().length;
        const dom = document.querySelectorAll('#list .row').length;
        const mem = rows.size;
        f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 3006; i++) dropRow(993000 + i);
        return { hit, dom, mem, after: rows.size };
      })()`);
      check('导出/复制按内存过滤',
        cap136.hit === 3006 && cap136.dom <= 80 && cap136.mem >= 3006,
        `命中=${cap136.hit} DOM 行=${cap136.dom} 内存=${cap136.mem} 清理后内存=${cap136.after}`);
    } catch (e) { check('导出/复制按内存过滤', false, e.message); }

    // 137 瀑布图跟随筛选
    try {
      const wf137 = await peval(`(() => {
        const f = document.getElementById('filter');
        f.value = 'api/data';
        f.dispatchEvent(new Event('input', { bubbles: true }));
        view = 'wf';
        syncTabs();
        const bars = document.querySelectorAll('#wf .wfrow').length;
        const expect = [...rows.values()].filter((v) => matches(v.rec) && v.rec.time && v.rec.duration != null).length;
        const info = document.getElementById('wfInfo').textContent;
        view = 'list';
        syncTabs();
        f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
        return { bars, expect, info };
      })()`);
      check('瀑布图跟随筛选', wf137.bars === wf137.expect && wf137.expect >= 1 && wf137.info.includes('命中'),
        `条形=${wf137.bars}/${wf137.expect} 信息=${JSON.stringify(wf137.info)}`);
    } catch (e) { check('瀑布图跟随筛选', false, e.message); }

    // 168 三个视图互斥显示（切到 WebSocket / 瀑布时请求列表必须让位）
    try {
      const disp168 = await peval(`(() => {
        const d = (id) => getComputedStyle(document.getElementById(id)).display;
        view = 'list'; syncTabs();
        const list0 = d('list'), wf0 = d('wfView'), ws0 = d('wsView');
        view = 'wf'; syncTabs();
        const listW = d('list'), wf1 = d('wfView');
        view = 'ws'; syncTabs();
        const listS = d('list'), ws1 = d('wsView');
        view = 'list'; syncTabs();
        return { list0, wf0, ws0, listW, wf1, listS, ws1, back: d('list') };
      })()`);
      check('视图切换互斥显示',
        disp168.list0 === 'block' && disp168.wf0 === 'none' && disp168.ws0 === 'none'
        && disp168.listW === 'none' && disp168.wf1 === 'flex'
        && disp168.listS === 'none' && disp168.ws1 === 'flex' && disp168.back === 'block',
        `list=${disp168.list0}/${disp168.listW}/${disp168.listS}/${disp168.back} wf=${disp168.wf0}→${disp168.wf1} ws=${disp168.ws0}→${disp168.ws1}`);
    } catch (e) { check('视图切换互斥显示', false, e.message); }

    // 138 响应体命中随新记录刷新
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      await peval(`(() => { const f = document.getElementById('filter'); f.value = 'body:"needle-refresh"'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(700);
      const n0 = await peval(`document.getElementById('nReq').textContent`);
      await extract.evalPage(`fetch('/api/needle').then((r) => r.text())`);
      await waitFor(async () => Number(await peval(`document.getElementById('nReq').textContent`)) >= 1, 8000, 'body 命中刷新').catch(() => {});
      const n1 = await peval(`document.getElementById('nReq').textContent`);
      const note1 = await peval(`document.getElementById('listNote').textContent`);
      await peval(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      check('响应体命中随新记录刷新', Number(n0) === 0 && Number(n1) >= 1 && note1.includes('响应体命中'),
        `刷新前=${n0} 刷新后=${n1} 提示=${JSON.stringify(note1)}`);
    } catch (e) { check('响应体命中随新记录刷新', false, e.message); }

    // 139 录制删除单条
    try {
      const r139 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      const r139b = await pinvoke('cap:recStop');
      const d139 = await pinvoke('cap:recDelete', { file: r139b.file });
      const list139 = await pinvoke('cap:recList');
      const outside139 = await pinvoke('cap:recDelete', { file: path.join(outDir, 'x.jsonl') });
      check('录制删除单条',
        r139.ok && d139.ok && d139.removed >= 2 && !fs.existsSync(r139b.file) && !fs.existsSync(r139b.mdFile)
          && !list139.some((x) => x.file === r139b.file) && outside139.ok === false,
        `删除 ${d139.removed} 个文件，列表剩余 ${list139.length} 条，越界=${outside139.error}`);
    } catch (e) { check('录制删除单条', false, e.message); }

    // 140 录制占用统计（含点击截图）
    try {
      const fakeJsonl = path.join(recDir, 'rec-probe.jsonl');
      const fakeShot = path.join(recDir, 'rec-probe-click-001.png');
      fs.writeFileSync(fakeJsonl, JSON.stringify({ k: 'note', n: 1, t: Date.now(), text: 'probe' }) + '\n', 'utf8');
      fs.writeFileSync(fakeShot, Buffer.alloc(10, 1));
      const list140 = await pinvoke('cap:recList');
      const item140 = list140.find((x) => x.base === 'rec-probe');
      const jsonlSize = fs.statSync(fakeJsonl).size;
      check('录制占用统计（含截图）',
        !!item140 && item140.shots === 1 && item140.bytes >= jsonlSize + 10,
        item140 ? `shots=${item140.shots} bytes=${item140.bytes}（jsonl ${jsonlSize} + png 10）` : '未列出 rec-probe');
      fs.rmSync(fakeJsonl, { force: true });
      fs.rmSync(fakeShot, { force: true });
    } catch (e) { check('录制占用统计（含截图）', false, e.message); }

    // 141 清理数据含录制记录
    try {
      await pinvoke('cap:recStart', { shots: false });
      await sleep(250);
      await pinvoke('cap:recStop');
      const w141 = await pinvoke('cap:wipe', { targets: ['recordings'] });
      const left141 = fs.readdirSync(recDir).filter((n) => /^rec-.*\.(jsonl|md|png)$/.test(n));
      check('清理数据含录制记录', w141.ok && w141.done.includes('recordings') && left141.length === 0,
        `done=${w141.done.join('/')} 残留=${left141.length} 个`);
    } catch (e) { check('清理数据含录制记录', false, e.message); }

    // 142 拾取面板侧取消（接上 cap:pickCancel，页面侧也要摘干净）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      await peval(`(() => { document.getElementById('extract').click(); return true; })()`);
      await sleep(300);
      await peval(`(() => { const b = [...document.querySelectorAll('#modalBody button')].find((x) => x.textContent === '拾取（行选择器）'); b.click(); return true; })()`);
      await sleep(500);
      const armed142 = await extract.evalPage('!!window.__wctPickArmed');
      await peval(`(() => { const t = [...document.querySelectorAll('#toasts .toast button')].find((x) => x.textContent === '取消'); t.click(); return true; })()`);
      await sleep(500);
      const off142 = await extract.evalPage('!!window.__wctPickArmed');
      check('拾取面板侧取消', armed142 === true && off142 === false, `注入=${armed142} 取消后=${off142}`);
    } catch (e) { check('拾取面板侧取消', false, e.message); }

    // 143 拾取到字段（选择器追加为字段行）
    try {
      await peval(`(() => { const b = [...document.querySelectorAll('#modalBody button')].find((x) => x.textContent === '拾取到字段'); b.click(); return true; })()`);
      await sleep(500);
      await extract.evalPage(`(() => {
        const el = document.querySelector('#pw');
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await sleep(700);
      const fields143 = await peval(`document.querySelectorAll('#modalBody textarea')[1].value`);
      await peval(`document.getElementById('modalClose').click()`);
      check('拾取到字段', String(fields143).includes('#pw'), `字段框末尾=${JSON.stringify(String(fields143).slice(-40))}`);
    } catch (e) { check('拾取到字段', false, e.message); }

    // 144 响应体 JSON 美化（按内容挑记录，避免挑到不含 "ok" 的 JSON）
    try {
      const rec144 = [...state.records].reverse().find((r) => r.body && r.body.includes('"ok":true'));
      const rawMark = '"ok":true';
      const prettyMark = '"ok": true';
      await peval('select(' + rec144.id + ')');            // 虚拟滚动：用 select 把它滚进窗口（不再按 DOM 行点）
      await waitFor(async () => await peval(`!!document.getElementById('bodyPretty')`), 8000, '美化按钮').catch(() => {});
      const hasBtn144 = await peval(`!!document.getElementById('bodyPretty')`);
      const before144 = await peval(`document.getElementById('detail').textContent.includes(${JSON.stringify(rawMark)})`);
      await peval(`(() => { const b = document.getElementById('bodyPretty'); if (b) b.click(); return true; })()`);
      await sleep(500);
      const pretty144 = await peval(`document.getElementById('detail').textContent.includes(${JSON.stringify(prettyMark)})`);
      await peval(`(() => { const b = document.getElementById('bodyPretty'); if (b) b.click(); return true; })()`);
      await sleep(500);
      const back144 = await peval(`document.getElementById('detail').textContent.includes(${JSON.stringify(rawMark)})`);
      check('响应体 JSON 美化', !!rec144 && hasBtn144 && before144 === true && pretty144 === true && back144 === true,
        `按钮=${hasBtn144} 原文命中=${before144} 美化后命中=${pretty144} 还原后命中=${back144}`);
    } catch (e) { check('响应体 JSON 美化', false, e.message); }

    // 145 下载提示（a[download] → will-download → toast + 日志）
    try {
      await extract.evalPage(`(() => {
        const a = document.createElement('a');
        a.href = '/dl.bin';
        a.download = 'probe.bin';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      })()`);
      await waitFor(async () => String(await peval(`document.getElementById('toasts').textContent`)).includes('下载'), 8000, '下载 toast').catch(() => {});
      await sleep(800);
      const toast145 = await peval(`document.getElementById('toasts').textContent`);
      const log145 = logger.tail(80);
      // 记录 note 回填是 will-download→done 的产物：等它出现；CDP 若压根没报这个下载请求（服务端有命中而列表无记录），
      // 只校验提示并在信息里如实标注（note 无记录可标，是 CDP 的可见性限制，不是回填逻辑坏了）
      const noteOk = await waitFor(async () => {
        const r = (await pinvoke('cap:list')).records.find((x) => String(x.url).endsWith('/dl.bin'));
        return r && String(r.note || '').includes('下载') ? String(r.note) : null;
      }, 10000, '下载记录 note').catch(() => null);
      const list145 = (await pinvoke('cap:list')).records;
      const dlRecs = list145.filter((x) => /dl\.bin/.test(String(x.url))).length;
      const server145 = hits['/dl.bin'] || 0;
      check('下载提示',
        toast145.includes('下载') && log145.includes('[download]') && (!!noteOk || (server145 > 0 && dlRecs === 0)),
        `toast=${JSON.stringify(String(toast145).slice(0, 60))} 日志=${log145.includes('[download]')} 服务端命中=${server145} 记录数=${dlRecs} note=${noteOk || '(无)'}${!noteOk && dlRecs === 0 ? '（CDP 未报该下载请求，note 无记录可标）' : ''}`);
    } catch (e) { check('下载提示', false, e.message); }

    // 146 重放导航（withNav）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      const st146 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      await extract.evalPage(`(() => { document.querySelector('a[href="/b"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
      await sleep(800);
      const st146b = await pinvoke('cap:recStop');
      const rd146 = await pinvoke('cap:recRead', { file: st146b.file });
      const navSteps = (rd146.actions || []).filter((a) => a.a === 'nav').length;
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      const before146 = hits['/b'] || 0;
      const rp146 = await pinvoke('cap:recReplay', { file: st146b.file, speed: 0, withNav: true });
      await sleep(400);
      const after146 = hits['/b'] || 0;
      check('重放导航（withNav）',
        st146.ok && navSteps >= 1 && rp146.ok && rp146.done === rp146.total && (rp146.failed || []).length === 0
          && rp146.skipped === 0 && after146 > before146,
        `步骤=${rp146.done}/${rp146.total} 跳过=${rp146.skipped} nav 步=${navSteps} /b 命中 ${before146}→${after146}`);
    } catch (e) { check('重放导航（withNav）', false, e.message); }

    // 147 代理连通性测试（给 url 只解析、不联网；不给才真发请求）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(800);
      const p147 = await pinvoke('cap:proxyTest', {});
      await settings.applySetting('proxy', 'socks5://127.0.0.1:1');
      const p147b = await pinvoke('cap:proxyTest', { url: 'http://example.com/' });
      await settings.applySetting('proxy', '');
      check('代理连通性测试',
        p147.ok && p147.status === 200 && typeof p147.proxy === 'string' && p147b.ok && String(p147b.proxy).includes('127.0.0.1:1'),
        `直连=${p147.status}（${p147.tookMs}ms，解析 ${p147.proxy}） 死代理解析=${p147b.proxy}`);
    } catch (e) { check('代理连通性测试', false, e.message); }

    /* ======================================== 148-156 第四轮：翻页提取 / 规则落盘 / XPath / 排序 / 快照 */

    // 148 任务预设增删与持久化（空名丢弃 → 落盘 → 清空）
    try {
      const r148 = await pinvoke('cap:cfg', {
        key: 'tasks',
        value: [
          { name: 't1', url: base + '/', rows: '.item', fields: '标题=.t', pages: 2, delay: 500 },
          { name: '', rows: 'x' },
        ],
      });
      const cfg148 = await pinvoke('cap:cfgAll');
      const t148 = (cfg148.tasks || [])[0];
      store.flush();
      const disk148 = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
      const diskTask = disk148.settings.tasks && disk148.settings.tasks[0];
      check('任务预设增删与持久化',
        r148.ok && (cfg148.tasks || []).length === 1 && !!t148 && t148.rows === '.item' && t148.pages === 2
          && !!diskTask && diskTask.fields === '标题=.t',
        `内存=${(cfg148.tasks || []).length} 条 rows=${t148 && t148.rows} pages=${t148 && t148.pages} 落盘字段=${diskTask && diskTask.fields}`);
      await pinvoke('cap:cfg', { key: 'tasks', value: [] });
    } catch (e) { check('任务预设增删与持久化', false, e.message); }

    // 149 翻页 + 提取合并（每页提取，翻到底合并，行带 _page）
    try {
      const r149 = await pinvoke('cap:taskRun', { url: base + '/', rows: '.item', fields: '标题=.t', pages: 3, delay: 600 });
      const endUrl149 = state.view.webContents.getURL();
      const titles149 = r149.ok ? r149.rows.map((r) => r.标题).join('') : '';
      check('翻页 + 提取合并',
        r149.ok && r149.rows.length === 9 && r149.pages === 3 && r149.reason === 'done'
          && r149.rows[0]._page === 1 && r149.rows[8]._page === 3
          && (titles149.match(/ABC/g) || []).length === 3 && /\/page\/3$/.test(endUrl149),
        r149.ok
          ? `合并=${r149.rows.length} 行 页=${r149.pages} reason=${r149.reason} 标题=${titles149} 末页=${endUrl149.replace(base, '')} 重复=${r149.dup}`
          : r149.error);
    } catch (e) { check('翻页 + 提取合并', false, e.message); }

    // 150 规则落盘（站点目录树镜像：命中写文件、CSS 不落、计数与 note）
    try {
      const dir150 = path.join(outDir, 'auto');
      const rel150 = ['site', `127.0.0.1_${port}`, 'api', 'data.json'];
      const relText150 = rel150.join('/');
      const file150 = path.join(dir150, ...rel150);
      const set150 = await pinvoke('cap:saveRuleSet', { on: true, urlRe: '/api/data', mimes: 'json', types: 'all', dir: dir150 });
      await reloadAndWait(state.view.webContents);
      try {
        await waitFor(() => fs.existsSync(file150), 8000, '落盘文件');
      } catch (e) { /* 下面按实际情况判定 */ }
      const exists150 = fs.existsSync(file150);
      const body150 = exists150 ? fs.readFileSync(file150, 'utf8') : '';
      const got150 = await pinvoke('cap:saveRuleGet');
      const list150 = (await pinvoke('cap:list')).records;
      const rec150 = list150.find((r) => String(r.url).endsWith('/api/data') && String(r.note || '').includes('已落盘'));
      const noCss150 = !fs.existsSync(path.join(dir150, 'site', `127.0.0.1_${port}`, 'style.css'));
      check('规则落盘（命中 / 未命中 / 计数）',
        set150.ok && exists150 && body150.includes('"ok":true') && noCss150
          && got150.ok && got150.n >= 1 && got150.rule.on === true
          && !!rec150 && String(rec150.note).includes(relText150),
        `文件=${relText150} 存在=${exists150} 计数=${got150.n} 大小=${got150.bytes}B 无 css=${noCss150} note=${rec150 ? rec150.note : '无'}`);
      await pinvoke('cap:saveRuleSet', { on: false, urlRe: '', mimes: '', types: 'all', dir: '' });
    } catch (e) { check('规则落盘（命中 / 未命中 / 计数）', false, e.message); }

    // 151 录制动作带 XPath（jsonl 与 cap:recRead 投影）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      const st151 = await pinvoke('cap:recStart', { shots: false });
      await sleep(300);
      await extract.evalPage(`(() => { document.querySelector('a[href="/b"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
      await sleep(800);
      const st151b = await pinvoke('cap:recStop');
      const click151 = st151b.ok ? readRec(st151b.file).find((l) => l.k === 'action' && l.a === 'click') : null;
      const rd151 = st151b.ok ? await pinvoke('cap:recRead', { file: st151b.file }) : { actions: [] };
      const a151 = (rd151.actions || []).find((x) => x.a === 'click');
      const xp151 = click151 ? click151.xpath : '';
      check('录制动作带 XPath',
        st151.ok && !!xp151 && (/^\/html\//.test(xp151) || /^\/\/\*\[@id=/.test(xp151)) && !!a151 && a151.xpath === xp151,
        `xpath=${xp151} 投影=${a151 && a151.xpath}`);
    } catch (e) { check('录制动作带 XPath', false, e.message); }

    // 152 提取支持 XPath（行选择器 + 行内相对字段）
    try {
      await state.view.webContents.loadURL(base + '/');
      await sleep(800);
      const ex152 = await extract.extractRows('xpath://div[@class="item"]', '标题=.t\n文本=xpath://span[1]');
      check('提取支持 XPath',
        ex152.ok && ex152.count === 3 && ex152.rows[0].标题 === 'A' && ex152.rows[0].文本 === 'A',
        ex152.ok ? `${ex152.count} 行 首行=${JSON.stringify(ex152.rows[0])}` : ex152.error);
    } catch (e) { check('提取支持 XPath', false, e.message); }

    // 153 Storage 批量导入（会话数据模态 → 导入 Storage）
    try {
      await peval(`document.getElementById('pageData').click()`);
      await waitFor(async () => await peval(`(() => { const b = [...document.querySelectorAll('#modalBody button')].find((x) => x.textContent === '导入 Storage'); return !!b; })()`), 8000, '会话数据模态').catch(() => {});
      const clicked153 = await peval(`(() => {
        const b = [...document.querySelectorAll('#modalBody button')].find((x) => x.textContent === '导入 Storage');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await sleep(400);
      const set153 = await peval(`(() => {
        const ta = document.querySelector('#modalBody textarea');
        if (!ta) return false;
        ta.value = '{"imp_k":"imp_v"}';
        const b = [...document.querySelectorAll('#modalFoot button')].find((x) => x.textContent === '导入');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await waitFor(async () => {
        const pd153 = await extract.collectPageData();
        return pd153.page.localStorage && pd153.page.localStorage.imp_k === 'imp_v';
      }, 8000, 'localStorage 导入').catch(() => {});
      const ls153 = (await extract.collectPageData()).page.localStorage || {};
      check('Storage 批量导入', clicked153 === true && set153 === true && ls153.imp_k === 'imp_v', `imp_k=${ls153.imp_k}`);
      await peval(`document.getElementById('modalClose').click()`);
      await pinvoke('cap:storageRemove', { area: 'local', key: 'imp_k' });
    } catch (e) { check('Storage 批量导入', false, e.message); }

    // 154 列表排序（大小↓，内存顺序不受影响）
    try {
      const s154 = await peval(`(() => {
        const oldest = [...rows.keys()][0];
        const sel = document.getElementById('sortBy');
        sel.value = 'size';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const shown = [...rows.values()].filter((r) => matches(r.rec));   // 排序只覆盖当前显示的记录
        const maxSize = Math.max(...shown.map((r) => r.rec.size || 0));
        document.getElementById('list').scrollTop = 0;      // 虚拟滚动：先滚到顶部，DOM 首行才是排序后的第一行
        renderWindow();
        const top = document.querySelector('#list .row');
        const topSize = top ? ((rows.get(Number(top.dataset.id)) || {}).rec || {}).size || 0 : -1;
        const stillOldest = [...rows.keys()][0] === oldest;
        sel.value = 'time';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { topSize, maxSize, stillOldest, groups: document.querySelectorAll('#list .grp').length };
      })()`);
      check('列表排序（大小↓）',
        s154.topSize === s154.maxSize && s154.maxSize > 0 && s154.stillOldest && s154.groups === 0,
        `首行=${s154.topSize}B 最大=${s154.maxSize}B 内存顺序未变=${s154.stillOldest} 复位后分组=${s154.groups}`);
    } catch (e) { check('列表排序（大小↓）', false, e.message); }

    // 155 域名分组（新增一条异主机记录 → 分组数 = 可见主机数）
    try {
      const g155 = await peval(`(() => {
        appendRecord({ id: 991554, method: 'GET', url: 'http://other.example/x', type: 'XHR', status: 200, size: 3, duration: 1, time: new Date().toISOString() });
        const sel = document.getElementById('sortBy');
        sel.value = 'domain';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const hosts = new Map();
        for (const r of rows.values()) {
          if (!matches(r.rec)) continue;
          let h = '(无法解析)';
          try { h = new URL(r.rec.url).host; } catch (e) { /* 保持默认 */ }
          hosts.set(h, (hosts.get(h) || 0) + 1);
        }
        const grps = [...document.querySelectorAll('#list .grp')].map((g) => g.textContent);
        const ok = grps.length >= 1
          && grps.every((t) => [...hosts.keys()].some((h) => t.startsWith(h + ' · ')))
          && grps.every((t) => { const h = t.split(' · ')[0]; return t.includes(h + ' · ' + hosts.get(h) + ' 条'); });
        sel.value = 'time';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const after = document.querySelectorAll('#list .grp').length;
        dropRow(991554);
        return { n: grps.length, hosts: hosts.size, ok, after, sample: grps.slice(0, 2).join(' | ') };
      })()`);
      check('域名分组',
        g155.ok && g155.n >= 1 && g155.hosts >= 2 && g155.after === 0,
        `分组=${g155.n} 主机=${g155.hosts} 标题匹配=${g155.ok} 复位后=${g155.after} 例=${g155.sample}`);
    } catch (e) { check('域名分组', false, e.message); }

    // 156 抓包快照保存与对比（先清空列表再制造一次真正的新请求：快照按 `METHOD url` 归组，历史同名键会抵消差异）
    try {
      await peval(`(() => { document.getElementById('clear').click(); return true; })()`);
      await sleep(500);
      await state.view.webContents.loadURL(base + '/');
      await sleep(900);
      const s156a = await pinvoke('cap:snapSave');
      await state.view.webContents.loadURL(base + '/page/2?fresh=1');
      await sleep(900);
      const s156b = await pinvoke('cap:snapSave');
      const list156 = await pinvoke('cap:snapList');
      const d156 = await pinvoke('cap:snapDiff');
      await peval(`(() => { document.getElementById('snapBtn').click(); return true; })()`);
      await waitFor(async () => await peval(`!!document.getElementById('snapDiff')`), 8000, '快照模态').catch(() => {});
      const clicked156 = await peval(`(() => { const b = document.getElementById('snapDiff'); if (!b) return false; b.click(); return true; })()`);
      await waitFor(async () => (await peval(`document.querySelectorAll('#modalBody table').length`)) >= 3, 8000, '差异表').catch(() => {});
      const tables156 = await peval(`document.querySelectorAll('#modalBody table').length`);
      check('快照保存与对比',
        s156a.ok && s156b.ok && list156.snaps.length === 2 && d156.ok && d156.addedN >= 1
          && Array.isArray(d156.removed) && Array.isArray(d156.changed) && clicked156 === true && tables156 >= 3,
        `快照=${list156.snaps.length} 条数=${list156.snaps.map((s) => s.count).join('/')} 新增=${d156.addedN} 消失=${d156.removedN} 变化=${d156.changedN} 表格=${tables156}`);
      await peval(`document.getElementById('modalClose').click()`);
    } catch (e) { check('快照保存与对比', false, e.message); }

    // ---------------- 158-161 离线包（当前页 + 静态资源镜像 / JS 清单 / network / hints）----------------
    // 先回到首页：入口必须是 base + '/'（标题 selftest），且它的 HTML / CSS / 图片都已被抓下
    const bundleDir = path.join(outDir, 'bundle');
    let bd = null;
    try {
      await state.view.webContents.loadURL(base + '/');
      await waitFor(() => ['/', '/style.css', '/img.png'].every((p) => state.records.some((r) => r.url === base + p && r.body != null)), 20000, '离线包资源');
      await sleep(300);
      bd = await pinvoke('cap:bundleSave', { dir: bundleDir, includeNetwork: true, includeHints: true });
    } catch (e) { bd = { ok: false, error: e.message }; }
    const bundleRead = (rel) => fs.readFileSync(path.join(bundleDir, ...String(rel).split('/')), 'utf8');

    // 158 打包落盘与结构
    try {
      if (!bd || !bd.ok) throw new Error('导出失败：' + JSON.stringify(bd || null));
      const manifest = JSON.parse(bundleRead('manifest.json'));
      const allOnDisk = manifest.files.every((f) => fs.existsSync(path.join(bundleDir, ...String(f.local).split('/'))));
      const jsIndex = JSON.parse(bundleRead('js/index.json'));
      const inlineText = bundleRead('js/_inline/001.js');
      check('离线包落盘与结构',
        bd.files >= 4 && bd.missing.length === 0 && fs.existsSync(path.join(bundleDir, ...String(bd.entry).split('/')))
          && allOnDisk && inlineText.includes('probe_cookie') && jsIndex.scripts.some((s) => s.kind === 'inline'),
        `${bd.files} 文件 / ${bd.bytes} 字节；entry=${bd.entry}；缺失=${bd.missing.length}；脚本=${jsIndex.scripts.map((s) => s.kind).join(',')}`);
    } catch (e) { check('离线包落盘与结构', false, e.message); }

    // 159 引用重写与字节一致
    try {
      if (!bd || !bd.ok) throw new Error('导出失败：' + JSON.stringify(bd || null));
      const manifest = JSON.parse(bundleRead('manifest.json'));
      const html = bundleRead(bd.entry);
      const cssRef = manifest.files.find((f) => /\/style\.css$/.test(f.url));
      const imgRef = manifest.files.find((f) => /\/img\.png$/.test(f.url));
      const css = cssRef ? bundleRead(cssRef.local) : '';
      const imgBytes = imgRef ? fs.readFileSync(path.join(bundleDir, ...String(imgRef.local).split('/'))) : Buffer.alloc(0);
      // 纯函数不变量：查询串哈希命名、目录 URL 的 index 命名、CSS 里 url(…) 的重写
      const namingOk = files.localPathOf('http://h/a.js?x=1', 'application/javascript', false) === `site/h/a_q_${crypto.createHash('sha1').update('x=1').digest('hex').slice(0, 8)}.js`
        && files.localPathOf('http://h/dir/', 'text/css', false) === 'site/h/dir/index.css'
        && bundle.rewriteRefs('body{background:url(/img.png)}', 'http://h/style.css', new Map([['http://h/img.png', 'site/h/img.png']]), 'site/h/style.css') === 'body{background:url(img.png)}';
      check('离线包引用重写与字节一致',
        !html.includes('href="/style.css"') && !html.includes('src="/img.png"') && /href="[^"]*style\.css"/.test(html)
          && css.includes('url(') && !css.includes('127.0.0.1:' + port) && imgBytes.equals(PNG_1PX) && namingOk,
        `HTML 重写=${/href="[^"]*style\.css"/.test(html)} CSS=${cssRef && cssRef.local} 图片=${imgBytes.length} 字节 纯函数=${namingOk}`);
    } catch (e) { check('离线包引用重写与字节一致', false, e.message); }

    // 160 离线可开：file:// 打开镜像入口，图片 / CSS / 内联脚本都生效
    try {
      if (!bd || !bd.ok) throw new Error('导出失败：' + JSON.stringify(bd || null));
      const entryPath = path.join(bundleDir, ...String(bd.entry).split('/'));
      await state.view.webContents.loadURL(pathToFileURL(entryPath).href);
      const imgExpr = `(() => { const p = document.querySelector('#pic'); return p ? p.naturalWidth : 0; })()`;
      await waitFor(async () => (await state.view.webContents.executeJavaScript(imgExpr, true)) > 0, 8000, '离线图片渲染').catch(() => {});
      const off = await state.view.webContents.executeJavaScript(`({
        title: document.title,
        img: ${imgExpr},
        margin: getComputedStyle(document.body).marginTop,
        probe: localStorage.getItem('probe'),
      })`, true);
      await state.view.webContents.loadURL(base + '/');          // 复位：后续断言继续用在线页
      check('离线包离线可开', off.title === 'selftest' && off.img > 0 && off.margin === '0px' && off.probe === '1',
        `title=${off.title} 图片宽=${off.img} margin=${off.margin} localStorage=${off.probe}`);
    } catch (e) { check('离线包离线可开', false, e.message); }

    // 161 network / hints 与面板入口
    try {
      if (!bd || !bd.ok) throw new Error('导出失败：' + JSON.stringify(bd || null));
      const net = JSON.parse(bundleRead('network.json'));
      const hints = JSON.parse(bundleRead('hints.json'));
      const postInNet = net.records.some((r) => r.method === 'POST' && r.postData === 'ping=1');
      const ping = hints.keywords.find((k) => k.keyword === 'ping');
      const probe = await peval(`(() => {
        const b = document.getElementById('bundleBtn');
        if (!b) return { exists: false, open: false, closed: false };
        b.click();
        const open = !document.getElementById('modal').hidden;
        document.getElementById('modalClose').click();
        return { exists: true, open, closed: document.getElementById('modal').hidden };
      })()`);
      check('离线包 network 与 hints',
        postInNet && !!ping && ping.hits.length > 0 && String(ping.hits[0].file).startsWith('js/_inline/')
          && probe.exists && probe.open && probe.closed,
        `POST 记录=${postInNet}；ping 命中=${ping ? ping.hits.length : 0}（${ping && ping.hits[0] ? `${ping.hits[0].file}:${ping.hits[0].line}` : '无'}）；按钮=${probe.exists} 模态=${probe.open}`);
    } catch (e) { check('离线包 network 与 hints', false, e.message); }

    // 162 详情显示请求发起者（CDP initiator 调用栈：哪个脚本哪一行发的请求）
    try {
      const get162 = state.records.find((r) => r.method === 'GET' && r.url === base + '/api/data');
      let has162 = false;
      if (get162) {
        await peval('select(' + get162.id + ')');
        await waitFor(async () => (await peval(`document.getElementById('detail').textContent`)).includes('发起者'), 8000, '详情发起者').catch(() => {});
        has162 = (await peval(`document.getElementById('detail').textContent`)).includes('发起者');
      }
      const frames162 = get162 && get162.initiator ? (get162.initiator.stack || []).length : 0;
      check('详情显示请求发起者',
        !!(get162 && get162.initiator && get162.initiator.type && frames162 >= 1 && has162),
        get162 && get162.initiator ? `type=${get162.initiator.type} 帧=${frames162} 详情含段=${has162}` : '无 initiator');
    } catch (e) { check('详情显示请求发起者', false, e.message); }

    // 163 请求耗时分解（CDP response.timing → DNS / 连接 / TLS / 发送 / 等待 / 下载）
    try {
      const post163 = state.records.find((r) => r.method === 'POST' && r.postData === 'ping=1');
      const tp163 = post163 ? capture.fullRecord(post163).timingParts : null;
      let has163 = false;
      if (post163) {
        await peval('select(' + post163.id + ')');
        await waitFor(async () => (await peval(`document.getElementById('detail').textContent`)).includes('耗时分解'), 8000, '详情耗时分解').catch(() => {});
        has163 = (await peval(`document.getElementById('detail').textContent`)).includes('耗时分解');
      }
      const keys163 = ['dns', 'connect', 'tls', 'send', 'wait', 'download'];
      check('请求耗时分解',
        !!(post163 && post163.timing && typeof post163.timing.receiveHeadersEnd === 'number' && tp163
          && keys163.every((k) => typeof tp163[k] === 'number' && tp163[k] >= 0) && has163),
        tp163 ? `receiveHeadersEnd=${post163.timing.receiveHeadersEnd} 等待=${tp163.wait}ms 下载=${tp163.download}ms 详情含段=${has163}` : '无 timing');
    } catch (e) { check('请求耗时分解', false, e.message); }

    // 164 OpenAPI 3 导出（同源 2xx 记录 → 接口文档；夹具的 POST ping=1 落在表单编码分支）
    try {
      const file164 = path.join(outDir, 'openapi.json');
      const oa164 = await pinvoke('cap:exportOpenApi', { file: file164 });
      const doc164 = JSON.parse(fs.readFileSync(file164, 'utf8'));
      const post164 = doc164.paths['/api/data'] && doc164.paths['/api/data'].post;
      const form164 = post164 && post164.requestBody && post164.requestBody.content['application/x-www-form-urlencoded'];
      check('OpenAPI 3 导出',
        !!(oa164 && oa164.ok && doc164.openapi === '3.0.3' && doc164.servers[0] && doc164.servers[0].url === base
          && post164 && form164 && form164.example.ping === '1'),
        `paths=${Object.keys(doc164.paths).length} 服务器=${doc164.servers[0] && doc164.servers[0].url} 表单示例=${form164 ? JSON.stringify(form164.example) : '无'}`);
    } catch (e) { check('OpenAPI 3 导出', false, e.message); }

    // 165 Mock 命中与透传（CDP Fetch 域：命中规则本地应答，未命中原样走服务器）
    try {
      const m165 = await pinvoke('cap:mockSet', {
        on: true,
        rules: [{ on: true, urlRe: '^' + base + '/api/needle', status: 201, headers: 'X-Mock: 1', body: '{"mocked":true}', bodyBase64: false }],
      });
      const got165 = await state.view.webContents.executeJavaScript(
        "Promise.all([fetch('/api/needle').then(async (r) => ({ status: r.status, ok: r.ok, type: r.type, mock: r.headers.get('x-mock'), text: await r.text() })).catch((e) => ({ err: String(e) })), fetch('/api/data').then((r) => r.json()).catch(() => null)])", true);
      const ruleId165 = m165 && m165.mock && m165.mock.rules[0] ? m165.mock.rules[0].id : '';
      const st165 = await pinvoke('cap:mockGet');
      const off165 = await pinvoke('cap:mockSet', { on: false, rules: [] });
      const needle = got165[0] || {};
      const pass = got165[1];
      check('Mock 命中与透传',
        !!(m165 && m165.ok && needle.status === 201 && needle.mock === '1' && /"mocked":true/.test(String(needle.text))
          && pass && pass.ok === true && (st165.hits[ruleId165] || 0) >= 1 && off165 && off165.ok && off165.on === false),
        `needle=${JSON.stringify(needle).slice(0, 220)} 透传=${pass && pass.ok} 命中=${st165 && st165.hits[ruleId165]} 关闭后开关=${off165 && off165.on}`);
    } catch (e) { check('Mock 命中与透传', false, e.message); }
  } catch (e) {
    check('自检执行', false, `${e.message} | status=${state.status} attached=${wc.debugger.isAttached()}`);
  }

  // ---------------- 67 GPU 判定不误触发（复核间隔 3s，见 GPU_RECHECK_MS）----------------
  try {
    const forced = process.argv.includes('--software-rendering');
    const settled = gpu.statusLooksSoftware(gpu.currentStatus());
    check('GPU 判定不误触发', state.softwareMode === (forced || settled),
      `softwareMode=${state.softwareMode} 稳定状态=${gpu.describe().gpuCompositing || '(未知)'} 强制参数=${forced}`);

    // 157 软件渲染下面板自动降级（关掉全屏模糊与阴影：老机器/无显卡时这几项最贵）
    // 运行期判定也会经 cap:gpu 通知面板，所以等它对齐，而不是只比启动时那一次
    await waitFor(() => state.win.webContents.executeJavaScript(
      `document.body.classList.contains('soft') === ${!!state.softwareMode}`, true), 5000, '面板软件渲染降级').catch(() => {});
    const soft = await state.win.webContents.executeJavaScript(`document.body.classList.contains('soft')`, true);
    check('软件渲染面板降级', soft === state.softwareMode,
      `面板 class=${soft ? 'soft' : '（无）'} softwareMode=${state.softwareMode}`);
  } catch (e) {
    check('GPU 判定不误触发', false, e.message);
  }

  // 178 活动标签内存记录 id 唯一（撞号会让「按 id 取详情/导出」拿到另一条）
  try {
    const seen178 = new Set();
    const dup178 = [];
    for (const r of state.records) {
      if (seen178.has(r.id)) dup178.push(r.id);
      seen178.add(r.id);
    }
    check('内存记录 id 唯一', dup178.length === 0,
      `记录 ${state.records.length} 条 / 唯一 id ${seen178.size} 个 / 重复 ${dup178.slice(0, 5).join(',') || '无'}`);
  } catch (e) { check('内存记录 id 唯一', false, e.message); }

  // 177 敏感权限默认拒绝（127.0.0.1 是安全上下文，不修的话 getCurrentPosition 会被放行）
  try {
    const geo = await extract.evalPage(`new Promise((res) => {
      if (!navigator.geolocation) return res('denied:no-api');
      navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res('denied:' + e.code), { timeout: 4000 });
    })`);
    const denied177 = String(geo).startsWith('denied');
    const log177 = logger.tail(80).includes('已拒绝页面权限请求');
    check('敏感权限默认拒绝', denied177 && log177, `定位回调=${geo} 日志已记录=${log177}`);
  } catch (e) { check('敏感权限默认拒绝', false, e.message); }

  // ---- 批次 2：数据完整性。都会改全局状态，放在套件末尾 ----

  // 173 次要头缓存不随请求数增长（暂停抓取时记录不建，extraInfo 若照存就是 1:1 的泄漏）
  // 暂停/恢复的切换瞬间可能有零星事件顺序残留，所以判据是「远小于请求数」而不是精确为 0。
  try {
    await state.view.webContents.loadURL(base + '/');
    await sleep(600);
    await pinvoke('cap:setEnabled', false);
    await extract.evalPage(`Promise.all(Array.from({ length: 40 }, (_, i) => fetch('/api/needle?off=' + i).then((r) => r.text()))).catch(() => {})`).catch(() => {});
    await sleep(1200);
    const pendOff = state.activeTab.pendingExtra.size;
    await pinvoke('cap:setEnabled', true);
    await extract.evalPage(`Promise.all(Array.from({ length: 20 }, (_, i) => fetch('/api/needle?p=' + i).then((r) => r.text()))).catch(() => {})`).catch(() => {});
    await sleep(1200);
    const pendOn = state.activeTab.pendingExtra.size;
    check('次要头缓存不随请求数增长', pendOff <= 5 && pendOn <= 5,
      `暂停 40 请求后残留=${pendOff}，恢复后再 20 请求残留=${pendOn}（修复前分别是 40 / 随请求数增长，上限 500）`);
  } catch (e) { check('次要头缓存不随请求数增长', false, e.message); }

  // 174 同一 URL 并发响应落盘不互相覆盖（uniquePathUnder 的存在性检查必须串行）
  try {
    const saveDir174 = path.join(outDir, 'autosave-race');
    fs.rmSync(saveDir174, { recursive: true, force: true });
    await pinvoke('cap:saveRuleSet', { on: true, dir: saveDir174, urlRe: '/api/data\\?race=1', types: 'all', mimes: '' });
    await extract.evalPage(`Promise.all([fetch('/api/data?race=1'), fetch('/api/data?race=1')]).then((r) => r.map((x) => x.text()))`).catch(() => {});
    await waitFor(() => capture.autoSaveState().n >= 2, 20000, '并发响应落盘').catch(() => {});
    await sleep(500);
    const st174 = capture.autoSaveState();
    const dir174 = path.join(saveDir174, 'site');
    const files174 = [];
    const walk174 = (d, pre) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk174(path.join(d, e.name), pre);
        else files174.push(pre + e.name);
      }
    };
    if (fs.existsSync(dir174)) walk174(dir174, '');
    await pinvoke('cap:saveRuleSet', { on: false, dir: saveDir174, urlRe: '/api/data\\?race=1', types: 'all', mimes: '' });
    // 同 URL 的查询串在文件名里是 _q_<hash>（与离线包同一套命名），重名再插 -1
    check('并发响应落盘不覆盖', st174.n >= 2 && files174.length === st174.n && files174.length === 2
      && files174.every((f) => /^data_q_[0-9a-f]{8}(-\d+)?\.json$/.test(f)) && files174.some((f) => /-\d+\.json$/.test(f)),
      `计数=${st174.n} 文件=[${files174.join(', ')}]`);
  } catch (e) { check('并发响应落盘不覆盖', false, e.message); }

  // 175 退出收尾不丢 summary（等在飞写入落定后再同步补写）
  try {
    const st175 = await pinvoke('cap:recStart', { shots: false });
    await extract.evalPage(`fetch('/api/data?quitting=1').then((r) => r.text())`).catch(() => {});
    await sleep(400);
    await recorder.flushAsync('quit');
    const lines175 = fs.readFileSync(st175.file, 'utf8').trim().split('\n').filter(Boolean);
    const last175 = JSON.parse(lines175[lines175.length - 1]);
    const md175 = fs.existsSync(st175.mdFile) ? fs.readFileSync(st175.mdFile, 'utf8') : '';
    check('退出收尾不丢 summary', last175.k === 'summary' && last175.reason === 'quit' && md175.includes('停止原因：退出'),
      `最后一行 k=${last175.k} reason=${last175.reason} md=${md175.includes('停止原因：退出')}`);
  } catch (e) { check('退出收尾不丢 summary', false, e.message); }

  // 176 会话写盘原子且可重叠（无 .tmp 残留、重叠调用不报错）
  try {
    const sa176 = await session.save();
    const sb176 = await session.save();
    const onDisk176 = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
    const tmp176 = fs.existsSync(session.filePath() + '.tmp') || fs.existsSync(session.filePath() + '.sync.tmp');
    check('会话写盘原子且可重叠', sa176.ok && sb176.ok && Array.isArray(onDisk176.records) && !tmp176,
      `第一=${sa176.ok} 第二=${sb176.skipped ? 'skipped(互斥)' : 'ok'} 落盘=${onDisk176.records.length} 条 tmp 残留=${tmp176}`);
  } catch (e) { check('会话写盘原子且可重叠', false, e.message); }

  // 177 工具栏自适应换行（窗口变窄 → 按钮折行，页面视图从工具栏实际底部开始；面板底部不被裁）
  try {
    const size0 = state.win.getContentSize();
    const measure = () => peval(`(() => {
      const t = document.getElementById('toolbar3').getBoundingClientRect();
      const p = document.getElementById('panel').getBoundingClientRect();
      return {
        h3: Math.round(t.height), top: Math.round(t.top),
        bottom: Math.round(document.getElementById('tabstrip').getBoundingClientRect().bottom),
        panelBottom: Math.round(p.bottom), vh: window.innerHeight,
        overflow: Math.round(document.body.scrollHeight - window.innerHeight),
      };
    })()`);
    state.win.setContentSize(1000, size0[1]);
    await sleep(700);                 // ResizeObserver → cap:toolbarH → layout
    const narrow = await measure();
    const yNarrow = state.view.getBounds().y, thNarrow = state.toolbarH;
    state.win.setContentSize(size0[0], size0[1]);
    await sleep(700);
    const wide = await measure();
    const yWide = state.view.getBounds().y, thWide = state.toolbarH;
    check('工具栏自适应换行',
      narrow.h3 > 44 && narrow.bottom === thNarrow && yNarrow === thNarrow
        && wide.bottom === thWide && yWide === thWide && narrow.h3 > wide.h3,
      `1000px 工具栏高=${narrow.h3} 上报=${thNarrow} 视图y=${yNarrow}｜${size0[0]}px 工具栏高=${wide.h3} 上报=${thWide} 视图y=${yWide}`);
    check('面板底部不被裁（工具栏换行）',
      narrow.panelBottom === narrow.vh && wide.panelBottom === wide.vh && narrow.overflow <= 0 && wide.overflow <= 0,
      `窄窗 面板底=${narrow.panelBottom}/视口=${narrow.vh} 溢出=${narrow.overflow}｜宽窗 面板底=${wide.panelBottom}/视口=${wide.vh} 溢出=${wide.overflow}`);
  } catch (e) { check('工具栏自适应换行', false, e.message); }

  /* ================================== 178-190 第七轮：缺陷回归与承诺对齐 */

  // 178 窗口启动参数合并（纯函数：保存值优先、缺省兜底、x/y 必须是有限数）
  try {
    const w1 = windowInitOptions({ width: 1234, height: 777, x: 5, y: 6 });
    const w2 = windowInitOptions({ width: 1234 });
    const w3 = windowInitOptions(null);
    check('窗口参数合并（纯函数）',
      w1.width === 1234 && w1.height === 777 && w1.x === 5 && w1.y === 6 && w1.minWidth === 900 && w1.minHeight === 600
        && w2.width === 1234 && w2.x === undefined && w2.y === undefined
        && w3.width === 1440 && w3.height === 900 && w3.x === undefined,
      `保存=${JSON.stringify(w1)} 缺 x/y=${w2.x === undefined} 空参数=${w3.width}×${w3.height}`);
  } catch (e) { check('窗口参数合并（纯函数）', false, e.message); }

  // 179 窗口位置 null 不被当作 0（Number(null)===0 会让没拖过窗口的机器重启跳到屏幕左上角）
  try {
    const p179 = path.join(outDir, 'window-null.json');
    fs.writeFileSync(p179, JSON.stringify({ version: 1, app: { window: { width: 1200, height: 800, x: null, y: null } } }), 'utf8');
    const r179a = store.readFile(p179);
    fs.writeFileSync(p179, JSON.stringify({ version: 1, app: { window: { width: 1200, height: 800, x: 12, y: 8 } } }), 'utf8');
    const r179b = store.readFile(p179);
    check('窗口位置 null 不当 0',
      r179a.data.app.window.x === null && r179a.data.app.window.y === null
        && r179b.data.app.window.x === 12 && r179b.data.app.window.y === 8,
      `null → ${JSON.stringify([r179a.data.app.window.x, r179a.data.app.window.y])}；12/8 → ${JSON.stringify([r179b.data.app.window.x, r179b.data.app.window.y])}`);
  } catch (e) { check('窗口位置 null 不当 0', false, e.message); }

  // 后续几项需要一份干净的夹具现场（记录 + 面板行 + 清空过滤）
  resetActive();
  await reloadAndWait(state.view.webContents);
  await waitFor(() => state.records.some((r) => r.url === base + '/api/data' && r.duration != null), 20000, '夹具记录（含耗时）');
  await peval(`(() => { document.getElementById('filter').value = ''; reapplyFilter(); return true; })()`);
  await peval(`ipcRenderer.invoke('cap:list').then((d) => { refreshActiveList(d); return true; })`);
  await sleep(300);

  // 180 详情定时器清空后不复活（clearDetail 必须取消在途的 200ms 刷新）
  try {
    const rec180 = [...state.records].reverse().find((r) => r.url.endsWith('/api/data'));
    await peval(`(async () => { select(${rec180.id}); scheduleDetailRender(${rec180.id}); clearDetail(); return true; })()`);
    await sleep(500);
    const d180 = await peval(`({ html: document.getElementById('detail').innerHTML.length, id: detailId })`);
    check('详情清空不复活', d180.html === 0 && d180.id === null, `详情字符=${d180.html} detailId=${d180.id}`);
  } catch (e) { check('详情清空不复活', false, e.message); }

  // 181 瀑布点条后列表定位（先切回列表再滚动，隐藏状态下 clientHeight=0 会把滚动夹成 0）
  try {
    await peval(`(() => {
      const recs = [];
      for (let i = 0; i < 200; i++) recs.push({ id: 993000 + i, method: 'GET', url: 'http://wf-click/path/' + i, type: 'XHR', status: 200, size: 10, duration: 5 + (i % 20), time: new Date(Date.now() - (200 - i) * 10).toISOString() });
      applyBatch({ records: recs });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 150));          // 等合并渲染落地：列表总高度与窗口才是最新
    const w181 = await peval(`(() => {
      view = 'wf'; syncTabs(); renderWaterfall();
      const rowsEls = [...document.querySelectorAll('#wf .wfrow')];
      if (rowsEls.length < 6) return { ok: false, n: rowsEls.length, top: 0, sel: false, view };
      rowsEls[rowsEls.length - 1].click();
      return { ok: true, n: rowsEls.length, top: Math.round(el.list.scrollTop), sel: !!document.querySelector('#list .row.sel'), view };
    })()`);
    await peval(`applyBatch({ drops: Array.from({ length: 200 }, (_, i) => 993000 + i) })`);
    check('瀑布点条后列表定位', w181.ok && w181.top > 0 && w181.sel && w181.view === 'list',
      `瀑布行=${w181.n} scrollTop=${w181.top} 高亮=${w181.sel} 视图=${w181.view}`);
  } catch (e) { check('瀑布点条后列表定位', false, e.message); }

  // 182 body 命中集随标签切换作废（命中集只在单标签内有效）
  try {
    await peval(`(() => { bodyQuery = 'zzz-不存在'; bodyHits = new Set([1, 2, 3]); updateListNote(); return true; })()`);
    const t182 = await pinvoke('cap:tabNew');
    if (!t182 || !t182.ok) throw new Error('新建标签失败：' + JSON.stringify(t182));
    await sleep(600);
    const s182 = await peval(`({ hits: bodyHits ? bodyHits.size : null, note: document.getElementById('listNote').textContent, rows: rows.size })`);
    await pinvoke('cap:tabClose', t182.id);
    await sleep(400);
    await peval(`(() => { bodyQuery = ''; bodyHits = null; updateListNote(); return true; })()`);
    const fresh182 = await peval('bodyHits === null');
    check('body 命中集随标签作废', s182.hits === 0 && s182.note.includes('0 条') && fresh182 === true && s182.rows === 0,
      `新标签命中=${s182.hits} 提示=${JSON.stringify(s182.note)} 行数=${s182.rows}`);
  } catch (e) { check('body 命中集随标签作废', false, e.message); }

  // 183 瀑布窗口化（3000 条只画可见切片）
  try {
    const w183 = await peval(`(() => {
      const recs = [];
      for (let i = 0; i < 3000; i++) recs.push({ id: 990000 + i, method: 'GET', url: 'http://wf.test/path/' + i, type: 'XHR', status: 200, size: 10, duration: 5 + (i % 30), time: new Date(Date.now() - (3000 - i) * 10).toISOString() });
      applyBatch({ records: recs });
      view = 'wf'; syncTabs();
      renderWaterfall();
      const box = document.getElementById('wf');
      const wrap = box.children[0];
      const kids = wrap && wrap.classList ? wrap.querySelectorAll('.wfrow').length : -1;
      const h = wrap ? Math.round(wrap.offsetHeight) : -1;
      const total = Number(document.getElementById('nWf').textContent);
      view = 'list'; syncTabs();
      applyBatch({ drops: recs.map((r) => r.id) });
      return { kids, h, total, expectH: total * 18 };
    })()`);
    check('瀑布窗口化（只画可见切片）',
      w183.kids > 0 && w183.kids < 80 && w183.total >= 3000 && Math.abs(w183.h - w183.expectH) <= 18,
      `DOM 行=${w183.kids} 内层高=${w183.h}（期望 ${w183.expectH}）nWf=${w183.total}`);
  } catch (e) { check('瀑布窗口化（只画可见切片）', false, e.message); }

  // 184 一批只渲染一次：合并渲染后计数与窗口仍一致
  try {
    const b184 = await peval(`(async () => {
      const recs = [];
      for (let i = 0; i < 1000; i++) recs.push({ id: 995000 + i, method: 'GET', url: 'http://batch.test/p/' + i, type: 'XHR', status: 200, size: 2, duration: 3, time: new Date().toISOString() });
      applyBatch({ records: recs });
      await new Promise((r) => setTimeout(r, 0));            // 让合并渲染的微任务落地
      const out = { memory: rows.size, nReq: Number(document.getElementById('nReq').textContent), count: Number(document.getElementById('count').textContent), dom: document.querySelectorAll('#list .row').length };
      applyBatch({ drops: recs.map((r) => r.id) });
      await new Promise((r) => setTimeout(r, 0));
      return out;
    })()`);
    check('一批只渲染一次（计数一致）',
      b184.memory >= 1000 && b184.nReq === b184.memory && b184.count === b184.memory && b184.dom > 0 && b184.dom <= 80,
      `内存=${b184.memory} nReq=${b184.nReq} count=${b184.count} DOM=${b184.dom}`);
  } catch (e) { check('一批只渲染一次（计数一致）', false, e.message); }

  // 185 WS 批量追加后到底（滚动写合并到微任务；同一任务内取数，不受真帧干扰）
  try {
    const ws185 = await peval(`(async () => {
      document.getElementById('wsPause').checked = false;
      document.getElementById('wsFilter').value = '';
      const box = document.getElementById('ws');
      box.innerHTML = '';
      document.getElementById('nWs').textContent = '0';
      view = 'ws'; syncTabs();
      for (let i = 0; i < 50; i++) appendWs({ kind: 'recv', payload: 'scroll-' + i, time: Date.now() });
      await null;                                            // 微任务落地：合并的「滚到底」应已完成
      const out = { atBottom: Math.abs(box.scrollTop - (box.scrollHeight - box.clientHeight)) <= 1, kids: box.children.length };
      box.innerHTML = '';
      document.getElementById('nWs').textContent = '0';
      view = 'list'; syncTabs();
      return out;
    })()`);
    check('WS 批量追加后到底', ws185.atBottom && ws185.kids === 50, `到底=${ws185.atBottom} 行=${ws185.kids}`);
  } catch (e) { check('WS 批量追加后到底', false, e.message); }

  // 186 hints 关键词定位（脚本行缓存后结果等价）
  try {
    const jsTexts = [
      { file: 'a.js', text: 'line1\nconst token = "abc";\nline3' },
      { file: 'b.js', text: 'no hit here\nvar xyz = 1;' },
    ];
    const records = [{ method: 'POST', url: 'http://x/api', postData: '{"token":"abc"}' }];
    const h1 = bundle.buildHints(records, jsTexts);
    const h2 = bundle.buildHints(records, jsTexts);
    const token = h1.keywords.find((k) => k.keyword === 'token');
    check('hints 关键词定位（缓存等价）',
      JSON.stringify(h1.keywords) === JSON.stringify(h2.keywords) && !!token && token.hits.length === 1
        && token.hits[0].file === 'a.js' && token.hits[0].line === 2 && token.hits[0].text.includes('const token'),
      `关键词=${h1.keywords.length} token 命中=${token ? token.hits.map((x) => `${x.file}:${x.line}`).join(',') : '无'}`);
  } catch (e) { check('hints 关键词定位（缓存等价）', false, e.message); }

  // 187 记录备注全链路可见（行标记 / 详情 / cap:detail）
  try {
    await peval(`ipcRenderer.invoke('cap:list').then((d) => { refreshActiveList(d); return true; })`);
    await sleep(200);
    const rec187 = [...state.records].reverse().find((r) => String(r.url).endsWith('/api/data') && !r.note);
    if (!rec187) throw new Error('没有可标记的 /api/data 记录');
    if (!capture.markNote(rec187.url, '已落盘：probe/x.json')) throw new Error('markNote 未命中记录');
    await waitFor(() => peval(`[...rows.values()].some((v) => String(v.rec.note || '').includes('已落盘'))`), 8000, '面板收到 note 更新');
    const ui187 = await peval(`(() => {
      el.list.scrollTop = 1e9; renderWindow();
      const marked = [...document.querySelectorAll('#list .row')].find((n) => (n.title || '').includes('备注：'));
      return { marked: !!marked, noteAttr: !!document.querySelector('#list .row[data-note="1"]'), title: marked ? marked.title.slice(0, 60) : '' };
    })()`);
    const d187 = await pinvoke('cap:detail', rec187.id);
    const detail187 = await peval(`(async () => { select(${rec187.id}); await new Promise((r) => setTimeout(r, 400)); return document.getElementById('detail').innerHTML.includes('备注'); })()`);
    check('记录备注全链路可见',
      ui187.marked && ui187.noteAttr && !!d187 && String(d187.note || '').includes('已落盘') && detail187 === true,
      `行标记=${ui187.marked} data-note=${ui187.noteAttr} 详情备注段=${detail187} cap:detail.note=${d187 && JSON.stringify(String(d187.note).slice(0, 24))}`);
  } catch (e) { check('记录备注全链路可见', false, e.message); }

  // 188 页面清单截断可见（2100 条链接 → 截到 2000 并给出总数）
  try {
    const t188 = await pinvoke('cap:tabNew');
    if (!t188 || !t188.ok) throw new Error('新建标签失败：' + JSON.stringify(t188));
    // 新标签先空导航挂 CDP，随后才载入目标；在 CDP 就绪前导航会让 about:blank 的初始化链被中断
    const tab188 = state.tabs.find((t) => t.id === t188.id);
    await waitFor(() => !!(tab188 && tab188.wc && tab188.wc.debugger.isAttached()), 15000, '新标签 CDP 就绪');
    await pinvoke('cap:navigate', `${base}/manylinks`);
    await waitFor(() => state.view.webContents.getURL().endsWith('/manylinks'), 15000, 'manylinks 载入');
    const hv188 = await pinvoke('cap:harvest');
    const ui188 = await peval(`(() => { document.getElementById('harvest').click(); return true; })()`);
    await sleep(600);
    const stat188 = await peval(`(() => { const m = document.getElementById('modalBody'); return m ? m.textContent.slice(0, 120) : ''; })()`);
    await peval(`closeModal()`);
    await pinvoke('cap:tabClose', t188.id);
    await sleep(400);
    check('页面清单截断可见',
      hv188.ok && hv188.links.length === 2000 && hv188.totals && hv188.totals.links === 2100 && ui188 && stat188.includes('已截断'),
      `links=${hv188.links.length}/${hv188.totals && hv188.totals.links} 面板提示=${JSON.stringify(String(stat188).slice(0, 60))}`);
  } catch (e) { check('页面清单截断可见', false, e.message); }

  // 189 会话 whenIdle 等在飞写（退出/重启先等它落定再 saveSync）
  try {
    const p189 = session.save();                 // 不 await：让写在飞
    await session.whenIdle();
    await p189;
    const tmp189 = fs.existsSync(session.filePath() + '.tmp') || fs.existsSync(session.filePath() + '.sync.tmp');
    const disk189 = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
    check('会话 whenIdle 等写在飞', Array.isArray(disk189.records) && !tmp189, `tmp 残留=${tmp189} 落盘=${disk189.records.length} 条`);
  } catch (e) { check('会话 whenIdle 等写在飞', false, e.message); }

  // 190 记录上限提示（5000 条满后首次丢弃时状态栏与日志提示一次）
  try {
    const t190 = await pinvoke('cap:tabNew');
    if (!t190 || !t190.ok) throw new Error('新建标签失败：' + JSON.stringify(t190));
    const tab190 = state.activeTab;
    await waitFor(() => tab190 && tab190.wc && tab190.wc.debugger.isAttached(), 15000, '新标签 CDP 就绪');   // 先等 CDP：命中上限要靠真实请求触发
    for (let i = 0; i < 5000; i++) {
      tab190.records.push({ id: 900000 + i, cdpId: 'fake' + i, url: 'http://fake/' + i, redirects: [], method: 'GET', note: '', body: null, bodyBase64: false, bodyError: null, failed: null, star: false, comment: '', requestHeaders: {}, responseHeaders: null, mime: '', encodedDataLength: 0, duration: null, remoteIP: '', protocol: '', type: '', time: new Date().toISOString(), status: 0, statusText: '', initiator: null, postData: null, requestHeadersRaw: null, responseHeadersRaw: null });
    }
    const nav190 = await pinvoke('cap:navigate', `${base}/`);
    const hit190 = await waitFor(() => tab190.capNote === true, 20000, '记录上限提示').then(() => true).catch(() => false);
    const log190 = logger.tail(400);
    const under190 = tab190.records.length;
    await pinvoke('cap:tabClose', t190.id);
    await sleep(400);
    check('记录上限提示', hit190 && log190.includes('开始丢弃最早记录'),
      `capNote=${hit190} 日志命中=${log190.includes('开始丢弃最早记录')} 导航=${nav190 && nav190.ok} 条数=${under190} 服务端首页命中=${hits['/'] || 0}`);
  } catch (e) { check('记录上限提示', false, e.message); }

  // ---- 编号不回退：这三项会改活动标签的状态（清空 / 恢复 / 切标签），放在套件末尾 ----

  // 169 清空后编号不回退（撞号会让新记录既不显示、详情又取到旧记录）
  try {
    await state.view.webContents.loadURL(base + '/');
    await waitFor(() => state.records.some((r) => r.url === base + '/api/data'), 20000, '清空前抓包就绪');
    const seqBefore = state.activeTab.seq;
    await pinvoke('cap:clear');
    await peval(`(() => { resetListDom(); clearDetail(); return true; })()`);
    await extract.evalPage(`fetch('/api/data?afterclear=1').then((r) => r.text())`).catch(() => {});
    const fresh169 = await waitFor(() => state.records.find((r) => String(r.url).includes('afterclear=1')), 20000, '清空后的新记录');
    await waitFor(() => peval('rows.has(' + fresh169.id + ')'), 8000, '新记录进了面板').catch(() => {});
    const inRows169 = await peval('rows.has(' + fresh169.id + ')');
    const detail169 = await pinvoke('cap:detail', fresh169.id);
    check('清空后编号不回退', state.activeTab.seq > seqBefore && fresh169.id > seqBefore && inRows169 === true
      && !!detail169 && String(detail169.url).includes('afterclear=1'),
      `seq ${seqBefore}→${state.activeTab.seq} 新id=${fresh169.id} 面板可见=${inRows169} 详情URL=${detail169 && String(detail169.url).slice(-40)}`);
  } catch (e) { check('清空后编号不回退', false, e.message); }

  // 170 会话恢复后编号续接
  try {
    session.saveSync();
    const maxRestored = Math.max(0, ...JSON.parse(fs.readFileSync(session.filePath(), 'utf8')).records.map((x) => x.id || 0));
    const rs170 = await pinvoke('cap:sessionRestore');
    await extract.evalPage(`fetch('/api/data?afterrestore=1').then((r) => r.text())`).catch(() => {});
    const fresh170 = await waitFor(() => state.records.find((r) => String(r.url).includes('afterrestore=1')), 20000, '恢复后的新记录');
    const detail170 = await pinvoke('cap:detail', fresh170.id);
    check('会话恢复后编号续接', rs170.ok && fresh170.id > maxRestored
      && !!detail170 && String(detail170.url).includes('afterrestore=1'),
      `恢复 ${rs170.count} 条（max id=${maxRestored}）新 id=${fresh170.id} 详情URL=${detail170 && String(detail170.url).slice(-40)}`);
  } catch (e) { check('会话恢复后编号续接', false, e.message); }

  // 171 切标签收起详情（id 只在标签内唯一，留着旧详情会复制到错的那条）
  try {
    await state.view.webContents.loadURL(base + '/');
    await waitFor(() => state.records.some((r) => r.body != null), 20000, '切标签前抓包就绪');
    const rec171 = state.records.find((r) => r.body != null);
    await peval(`select(${rec171 ? rec171.id : 0})`);
    await waitFor(() => peval('detailId != null'), 5000, '详情已打开').catch(() => {});
    if (state.tabs.length < 2) await pinvoke('cap:tabNew', `${base}/page/2`);
    const target171 = state.tabs.find((t) => t !== state.activeTab);
    await pinvoke('cap:tabActivate', target171.id);
    await waitFor(() => peval('selected === null'), 8000, '切标签后收起详情').catch(() => {});
    const st171 = await peval(`({ sel: selected, html: document.getElementById('detail').innerHTML })`);
    check('切标签收起详情', st171.sel === null && st171.html === '',
      `selected=${st171.sel} 详情残留 ${st171.html.length} 字符`);
  } catch (e) { check('切标签收起详情', false, e.message); }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  clearTimeout(watchdog);
  server.close();
  // 产物目录（含离线包镜像树）只在失败时保留，方便排查；本轮沙盒目录（按 PID 隔离）同理
  if (!failed) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* 有句柄占用就算了 */ }
    for (const d of sandboxDirs || []) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 同上 */ } }
  } else {
    console.log(`失败产物保留：${outDir}`);
    for (const d of sandboxDirs || []) console.log(`沙盒目录保留：${d}`);
  }
  require('electron').app.exit(failed ? 1 : 0);
}

module.exports = { run };
