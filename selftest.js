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
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      hits[u.pathname] = (hits[u.pathname] || 0) + 1;
      lastHeaders[u.pathname] = req.headers;
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
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, lastHeaders }));
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

async function run({ state, store, gpu, extract, settings, automation, format, files, capture, PARTITION }) {
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

  const { server, hits, lastHeaders } = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wc = state.view.webContents;

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
    state.records.length = 0; state.byId.clear(); state.seq = 0;   // 等价于面板「清空」
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
      sc.ok ? `轮次=${sc.rounds} reason=${sc.reason} .extra=${extraCount} 视口=${scrollDiag}` : sc.error);

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
    const missingEls = await peval(`['toasts','banner','bannerText','bannerAction','bannerClose','appSettings']
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
