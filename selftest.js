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
      const port = server.address().port;
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
      if (u.pathname === '/img.png') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'image/png' }, noStore));
        res.end(PNG_1PX);
        return;
      }
      if (u.pathname === '/style.css') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/css' }, noStore));
        res.end('body { margin: 0; }');
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
      const key = req.headers['sec-websocket-key'];
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

async function run({ state, store, gpu, extract, settings, automation, format, files, capture, logger, session, resetActive, PARTITION }) {
  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, pass: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  };

  check('目标架构 ia32（Win7 32 位目标）', process.arch === 'ia32',
    `electron=${process.versions.electron} chromium=${process.versions.chrome} node=${process.versions.node} arch=${process.arch}`);

  // ---------------- 56-58 图标 ----------------
  try {
    const ico = readIco(path.join(__dirname, 'build', 'icon.ico'));
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
      const tmp = path.join(os.tmpdir(), 'wct-selftest-keys', 'settings.json');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: { proxy: 'x', evil: 1 } }), 'utf8');
      const r = store.readFile(tmp);
      return r.data.settings.evil === undefined && r.data.settings.proxy === 'x';
    })());

    const badPath = path.join(os.tmpdir(), 'wct-selftest-bad', 'settings.json');
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

  // 窗口被其它窗口遮挡时 Chromium 会推迟滚动事件与合成帧，自检必须让窗口在最前
  try { state.win.moveTop(); state.win.focus(); } catch (e) { /* 无窗口环境忽略 */ }

  // 看门狗：卡死时也要退出并留下最后一条断言，避免整个自检无声挂起
  const watchdog = setTimeout(() => {
    console.log('FAIL  自检看门狗超时（180s），进程强制退出');
    require('electron').app.exit(2);
  }, 180000);

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
    const panel = state.win.webContents;
    const peval = (expr) => panel.executeJavaScript(expr, true);
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
    const sc = await automation.autoRun({ mode: 'scroll', rounds: 5 });
    const extraCount = await extract.evalPage('document.querySelectorAll(".extra").length');
    const scrollDiag = await extract.evalPage('JSON.stringify({h: document.documentElement.scrollHeight, ih: window.innerHeight, y: Math.round(window.scrollY)})');
    check('自动滚动触发无限加载', sc.ok && extraCount >= 1,
      sc.ok ? `轮次=${sc.rounds} reason=${sc.reason} .extra=${extraCount} 视口=${scrollDiag} view=${JSON.stringify(state.view.getBounds())} win=${JSON.stringify(state.win.getContentBounds())} visible=${state.win.isVisible()}` : sc.error);

    // ---------------- 32 自动翻页 ----------------
    const pg = await automation.autoRun({ mode: 'page', pages: 3, delay: 300 });
    const endUrl = wc.getURL();
    check('自动翻页到达第 3 页', pg.ok && /\/page\/3$/.test(endUrl), pg.ok ? `pages=${pg.pages} reason=${pg.reason} url=${endUrl}` : pg.error);
    check('自动翻页中间页已抓取', state.records.some((r) => /\/page\/2$/.test(r.url)));

    // ---------------- 33 响应体批量存盘 ----------------
    const tmpDir = path.join(os.tmpdir(), `wct-selftest-${Date.now()}`);
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

    const pinvoke = (channel, ...args) => panel.executeJavaScript(
      `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`, true);
    const outDir = path.join(os.tmpdir(), `wct-selftest-out-${Date.now()}`);
    fs.mkdirSync(outDir, { recursive: true });

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
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: 200 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 200 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: 200 }));
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
      check('详情渲染节流（200ms 合并）', t2 - t1 === 1, `渲染次数 ${t1} → ${t2}`);
    } catch (e) { check('详情渲染节流（200ms 合并）', false, e.message); }

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
      const r85 = await pinvoke('cap:screenshot', { mode: 'visible', file: f85 });
      const buf = fs.readFileSync(f85);
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

    // 89 会话写盘
    try {
      const saved = session.saveSync();
      const sessionOnDisk = JSON.parse(fs.readFileSync(session.filePath(), 'utf8'));
      check('会话写盘', saved.ok && fs.existsSync(session.filePath()) && sessionOnDisk.records.length === Math.min(state.records.length, 2000),
        `${sessionOnDisk.records.length} 条 / 内存 ${state.records.length} 条`);
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
      await waitFor(async () => (await peval('document.querySelectorAll("#list .row").length')) === restored.count && restored.count > 0,
        8000, '横幅恢复列表').catch(() => {});
      const uiRows = await peval('document.querySelectorAll("#list .row").length');
      // 面板横幅「忽略」：删除会话文件
      await peval(`(() => { document.querySelectorAll('#bannerActions button')[1].click(); return true; })()`);
      await sleep(300);
      const discarded = await pinvoke('cap:sessionInfo');
      check('会话恢复',
        info.exists === true && restored.ok && restored.count === Math.min(info.count, 2000) && restored.records.length === restored.count
          && uiRows === restored.count && discarded.exists === false,
        `exists=${info.exists} 写盘 ${info.count} 条 / 恢复 ${restored.count} 条 / 横幅渲染 ${uiRows} 行 / 忽略后存在=${discarded.exists}`);
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
      await pinvoke('cap:tabNew', `${base}/page/2?tab=2`);
      await sleep(1800);
      await pinvoke('cap:tabNew', `${base}/page/3?tab=3`);
      await sleep(1800);
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
      check('多标签创建与隔离', tabs.length === 3 && bad.length === 0,
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
      await sleep(1500);
      const l2 = await pinvoke('cap:list');
      check('标签切换与关闭', switched && closed.ok && after.length === 2 && destroyed && l2.records.some((r) => r.url === `${base}/`),
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
  } catch (e) {
    check('自检执行', false, `${e.message} | status=${state.status} attached=${wc.debugger.isAttached()}`);
  }

  // ---------------- 67 GPU 判定不误触发（运行 20 秒后复核瞬时状态已稳定）----------------
  try {
    const forced = process.argv.includes('--software-rendering');
    const settled = gpu.statusLooksSoftware(gpu.currentStatus());
    check('GPU 判定不误触发', state.softwareMode === (forced || settled),
      `softwareMode=${state.softwareMode} 稳定状态=${gpu.describe().gpuCompositing || '(未知)'} 强制参数=${forced}`);
  } catch (e) {
    check('GPU 判定不误触发', false, e.message);
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  clearTimeout(watchdog);
  server.close();
  require('electron').app.exit(failed ? 1 : 0);
}

module.exports = { run };
