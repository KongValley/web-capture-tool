'use strict';
/*
 * 手册截图：npm run shots（= electron . --shots）
 *
 * 起一台本地示例站点 → 驱动真实窗口到一个个「可截图状态」→ 把 PNG 写进 docs/img/。
 * 与自检/基准同一套沙盒（配置 / 日志 / 会话 / 录制全在系统临时目录），不碰用户真实数据。
 * 只摆位 + 截图，不做断言；跑完把每张图的尺寸与体积打出来，自己去 docs/img/ 里看。
 * 注意：窗口会真的弹出来（隐藏窗口合成不出画面），跑完自动退出。
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { nativeImage } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'img');
const WIN_W = 2200;           // 比屏幕宽也行：capturePage 抓的是 webContents，不依赖窗口完整可见
const WIN_H = 900;            // 2200 宽下三条工具栏按钮能排下，不被窗口右缘切掉
const PANEL_W = 860;          // 面板宽一点：详情按钮条与弹窗都不被切
const SETTLE = 420;           // 每次截图前的静置时间：等合成器出画面

let port = 0;                 // 示例站点的端口，APP_JS 里用 __PORT__ 占位

/* ------------------------------------------------------------ 示例站点 */

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>示例商城 · 商品列表</title>
<link rel="stylesheet" href="/style.css"></head>
<body>
<header class="top"><div class="brand">示例商城</div>
<nav>首页　商品　订单　关于</nav></header>
<main class="wrap">
  <section class="card">
    <h2>账号登录</h2>
    <form id="loginForm">
      <label>用户名 <input name="user" value="demo"></label>
      <label>密码 <input name="pass" type="password" value="123456"></label>
      <button type="submit">登录</button>
      <span class="hint" id="loginMsg"></span>
    </form>
  </section>
  <section class="card">
    <h2>商品列表</h2>
    <table id="items"><thead><tr><th>ID</th><th>商品</th><th>价格</th><th>库存</th></tr></thead>
    <tbody></tbody></table>
    <p class="hint" id="loadMsg">加载中…</p>
  </section>
</main>
<script src="/app.js"></script>
</body></html>`;

const CSS = `*{box-sizing:border-box}
body{margin:0;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#22272e;background:#f6f7f9}
.top{display:flex;align-items:center;gap:24px;height:56px;padding:0 24px;background:#fff;border-bottom:1px solid #e3e6ea}
.brand{font-size:18px;font-weight:700;color:#2f6fd0}
nav{color:#6b7280}
.wrap{display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px 24px;align-items:start}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:16px}
.card h2{margin:0 0 12px;font-size:15px}
label{display:block;margin-bottom:8px;color:#4b5563}
input{width:100%;height:30px;padding:0 8px;border:1px solid #d7dbe0;border-radius:4px}
button{height:32px;padding:0 14px;border:1px solid #2f6fd0;border-radius:4px;background:#2f6fd0;color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid #eef0f3;text-align:left}
th{color:#6b7280;font-weight:500}
.hint{color:#6b7280;font-size:12px;margin:8px 0 0}
.ok{color:#177245}`;

const APP_JS = `document.cookie = 'theme=dark; path=/';
localStorage.setItem('cart', JSON.stringify([1001, 1002]));
document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'demo', pass: '123456', remember: true }) })
    .then((r) => r.json())
    .then((d) => { const m = document.getElementById('loginMsg'); m.textContent = '登录成功，token=' + d.token; m.className = 'hint ok'; });
});
fetch('/api/items').then((r) => r.json()).then((d) => {
  const tb = document.querySelector('#items tbody');
  tb.innerHTML = d.items.map((it) => '<tr><td>' + it.id + '</td><td>' + it.name + '</td><td>￥' + it.price + '</td><td>' + it.stock + '</td></tr>').join('');
  const m = document.getElementById('loadMsg'); m.textContent = '共 ' + d.total + ' 条 · 来自 ' + location.host;
  m.className = 'hint ok';
});
fetch('/api/search?q=手机&page=2');
fetch('/api/slow');
fetch('/api/fail').catch(() => {});
fetch('http://localhost:__PORT__/api/items?from=localhost').catch(() => {});   // 第二个域名，用来看域名分组/统计
const s = document.createElement('script'); s.src = '/lazy.js'; document.head.appendChild(s);`;

function startFixture(cb) {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: 1001 + i, name: '商品 ' + (i + 1), price: ((i + 1) * 19.9).toFixed(2), stock: i * 3 + 2 }));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, extra) => {
      res.writeHead(code, Object.assign({ 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, extra || {}));
      res.end(body);
    };
    if (u.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
    if (u.pathname === '/style.css') return send(200, 'text/css; charset=utf-8', CSS);
    if (u.pathname === '/app.js') return send(200, 'application/javascript; charset=utf-8', APP_JS.replace('__PORT__', String(port)));
    if (u.pathname === '/lazy.js') return send(200, 'application/javascript', 'window.__lazy = 1;');
    if (u.pathname === '/logo.svg') return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2f6fd0"/></svg>');
    if (u.pathname === '/api/items') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, total: items.length, items }));
    if (u.pathname === '/api/search') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, q: u.searchParams.get('q'), page: Number(u.searchParams.get('page') || 1), hits: items.slice(0, 3) }));
    if (u.pathname === '/api/login') {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => send(200, 'application/json; charset=utf-8',
        JSON.stringify({ ok: true, user: 'demo', token: 'demo-token-7f3a' }), { 'Set-Cookie': 'sid=demo-6f2a1c; Path=/; SameSite=Lax' }));
      return;
    }
    if (u.pathname === '/api/slow') return setTimeout(() => send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, delayed: true })), 900);
    if (u.pathname === '/api/fail') return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '服务端错误' }));
    if (u.pathname === '/api/report.csv') return send(200, 'text/csv; charset=utf-8', 'id,name\n1001,商品 1\n1002,商品 2\n');
    return send(404, 'text/plain; charset=utf-8', 'not found');
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; cb(port, server); });
}

/* --------------------------------------------------------------- 工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(inj) {
  const { state, layout, toolbarH } = inj;
  const wc = () => state.win.webContents;
  const peval = (code) => wc().executeJavaScript(code, true);
  const page = (code) => state.view.webContents.executeJavaScript(code, true);

  async function waitFor(fn, ms, label) {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await fn(); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
      await sleep(120);
    }
  }
  // 弹窗 / 提示条 / 轻提示这类临时遮挡，截图前统一清掉（提示里可能带临时目录路径，不进公开截图）
  async function hideBanners() {
    await peval("(() => { const b = document.getElementById('banner'); if (b && !b.hidden) { const x = document.getElementById('bannerClose'); if (x) x.click(); } const t = document.getElementById('toasts'); if (t) t.innerHTML = ''; })()");
  }
  async function closeModal() {
    await peval("(() => { const m = document.getElementById('modal'); if (!m.hidden) { const c = document.getElementById('modalClose'); if (c) c.click(); } })()");
    await sleep(150);
  }
  async function shot(name, rect) {
    if (!rect) rect = null;
    else if (rect === 'window') rect = null;
    else if (rect === 'panel') {
      // 从工具栏下面开始截：面板图要的是面板本身，工具栏高度按运行时上报的实际值裁（换行后比常量高）
      const h = state.toolbarH || toolbarH;
      const { width, height } = state.win.getContentBounds();
      rect = { x: Math.max(0, width - PANEL_W), y: h, width: Math.min(PANEL_W, width), height: Math.max(0, height - h) };
    }
    await hideBanners();
    await sleep(SETTLE);
    const img = await wc().capturePage(rect);
    const png = img.toPNG();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), png);
    const sz = img.getSize();
    console.log(`  ${name}.png   ${sz.width}×${sz.height}   ${(png.length / 1024).toFixed(0)} KB`);
  }

  // 整窗截图：capturePage 拿不到原生页面视图（BrowserView 是独立合成层），
  // 系统级窗口抓取在 GPU 合成的窗口上抓不出来（PrintWindow/BitBlt 失败）。
  // 因此自己合成两张 capturePage：窗口内容（工具栏 + 面板，页面区域是透明的）叠在页面视图之上。
  // 窗口内容里带半透明的地方（弹窗遮罩）按 source-over 混合，页面在遮罩下仍可见。
  async function shotWindow(name) {
    await hideBanners();
    await sleep(SETTLE);
    const win = state.win;
    const wcImg = await win.webContents.capturePage();
    const viewImg = await state.view.webContents.capturePage();
    const { width: cw, height: ch } = win.getContentBounds();
    const vb = state.view.getBounds();
    const W = wcImg.getSize().width;
    const H = wcImg.getSize().height;
    const sx = W / cw;
    const sy = H / ch;
    const out = wcImg.toBitmap();
    const pv = viewImg.toBitmap();
    const pw = Math.min(Math.round(vb.width * sx), viewImg.getSize().width);
    const ph = Math.min(Math.round(vb.height * sy), viewImg.getSize().height);
    const x0 = Math.round(vb.x * sx);
    const y0 = Math.round(vb.y * sy);
    const srcW = viewImg.getSize().width;
    for (let y = 0; y < ph; y++) {
      let dp = ((y0 + y) * W + x0) * 4;              // BGRA
      let sp = y * srcW * 4;
      for (let x = 0; x < pw; x++, dp += 4, sp += 4) {
        // 页面视图在真实窗口里盖在窗口内容之上：直接贴页面像素；窗口内容不透明处（工具栏 / 面板）本就在视图范围外
        out[dp] = pv[sp]; out[dp + 1] = pv[sp + 1]; out[dp + 2] = pv[sp + 2]; out[dp + 3] = 255;
      }
    }
    const img = nativeImage.createFromBitmap(out, { width: W, height: H });
    const png = img.toPNG();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), png);
    console.log(`  ${name}.png   ${W}×${H}   ${(png.length / 1024).toFixed(0)} KB   （整窗合成）`);
  }
  const modalVisible = () => peval("!document.getElementById('modal').hidden");
  const click = (id) => peval(`document.getElementById('${id}').click()`);
  const panelShot = (n) => shot(n, 'panel');

  async function main() {
    const { settings, capture, session } = inj;

    fs.mkdirSync(OUT, { recursive: true });
    await session.discard();                                  // 清掉上次遗留的会话文件，避免恢复横幅入镜
    state.win.setContentSize(WIN_W, WIN_H);
    await peval('applyPanelWidth(' + PANEL_W + ')');
    state.panelWidth = PANEL_W;                               // 视图宽度由主进程摆：同步一下，否则页面会压住面板左缘
    if (layout) layout();
    await sleep(300);

    await state.view.webContents.loadURL('http://127.0.0.1:' + port + '/');   // 打开示例站点
    await waitFor(async () => Number(await peval('rows.size')) >= 6, 20000, '示例站点请求入列表');
    await page("!!document.querySelector('#items tbody tr')");
    await sleep(400);

    /* 1. 界面总览：左页面 + 右面板（整窗抓取） */
    await peval("select(rows.size ? [...rows.values()][rows.size - 1].rec.id : 0)");
    await shotWindow('01-overview');

    /* 2. 列表 + 详情：挑一条 JSON 接口，展开响应体 */
    const jsonId = await peval("(() => { const r = [...rows.values()].find((x) => x.rec.mime && x.rec.mime.includes('json') && x.rec.method === 'GET'); return r ? r.rec.id : 0; })()");
    await peval('select(' + jsonId + ')');
    await waitFor(modalVisible, 8000, '详情').catch(() => {});
    await waitFor(async () => String(await peval("document.getElementById('detail').textContent")).includes('响应体'), 8000, '详情渲染');
    await peval("(() => { const b = document.getElementById('bodyPretty'); if (b) b.click(); })()");
    await panelShot('02-list-detail');

    /* 2b. 详情下半段：滚到底看响应体（已美化） */
    await peval("(() => { const d = document.getElementById('detail'); d.scrollTop = d.scrollHeight; })()");
    await panelShot('02b-detail-body');
    await peval("(() => { const d = document.getElementById('detail'); d.scrollTop = 0; })()");

    /* 3. 过滤语法：过滤框 + 命中数 */
    await peval("(() => { const f = document.getElementById('filter'); f.value = 'mime:json status:2xx'; f.dispatchEvent(new Event('input')); })()");
    await sleep(500);
    await panelShot('03-filter');

    /* 4. 瀑布视图 */
    await peval("document.querySelector('.tab[data-view=\"wf\"]').click()");
    await sleep(600);
    await panelShot('04-waterfall');
    await peval("document.querySelector('.tab[data-view=\"list\"]').click()");
    await sleep(300);

    /* 5. 统计概览 */
    await click('statsBtn');
    await waitFor(modalVisible, 8000, '统计概览');
    await shotWindow('05-stats');
    await closeModal();

    /* 6. CSS/XPath 提取：填好选择器，跑一次，截结果表 */
    await fluidExtract();
    /* 7. 会话数据（Cookie / Storage） */
    await click('pageData');
    await waitFor(modalVisible, 8000, '会话数据');
    await shotWindow('07-page-data');
    await closeModal();

    /* 8. 离线包 */
    await click('bundleBtn');
    await waitFor(modalVisible, 8000, '离线包');
    await shotWindow('08-bundle');
    await closeModal();

    /* 9. 重放请求：先真发一次登录（拿到 POST 记录），再打开重放弹窗 */
    await page("document.querySelector('#loginForm button').click()");
    await waitFor(async () => Number(await peval("(() => { let n = 0; for (const x of rows.values()) if (x.rec.method === 'POST') n++; return n; })()")) >= 1, 15000, 'POST 记录');
    const postId = await peval("(() => { const r = [...rows.values()].find((x) => x.rec.method === 'POST'); return r ? r.rec.id : 0; })()");
    await peval('select(' + postId + ')');
    await waitFor(async () => String(await peval("document.getElementById('detail').textContent")).includes('重放请求'), 8000, '详情按钮');
    await click('replayReq');
    await waitFor(modalVisible, 8000, '重放请求');
    await shotWindow('09-replay');
    await closeModal();

    /* 10. 设置（软件渲染 / GPU / 兼容） */
    await click('appSettings');
    await waitFor(modalVisible, 8000, '设置');
    await shotWindow('10-settings');
    await closeModal();

    /* 11. 录制历史：真跑一次录制（点击 + 输入 + 提交），再打开历史 */
    await click('recToggle');
    await sleep(400);
    await page("(() => { document.querySelector('input[name=user]').focus(); document.querySelector('#loginForm button').click(); })()");
    await sleep(500);
    await page("!!document.querySelector('#items tbody tr')");
    await page('window.scrollTo(0, 120)');
    await sleep(400);
    await click('recToggle');                                  // 停止
    await sleep(900);                                          // 等摘要落盘
    await click('recBrowse');
    await waitFor(modalVisible, 8000, '录制历史');
    await shotWindow('11-recording');
    await closeModal();

    /* 12. Mock：加一条规则、让页面真命中一次，再打开 Mock 弹窗 */
    await settings.applySetting('mock', {
      on: true,
      rules: [{ on: true, urlRe: '^http://127\\.0\\.0\\.1:\\d+/api/fail', status: 200, headers: 'X-Mock: 1\nContent-Type: application/json', body: '{"ok":true,"mocked":true}', bodyBase64: false }],
    });
    await capture.syncMock();
    const nMock = Number(await peval('rows.size'));
    await page('location.reload()');
    // rows.size 是面板累计值、本轮之前就 >= 8，所以必须等「新增记录且命中改写后的状态码」
    await waitFor(async () => await peval(`rows.size > ${nMock} && [...rows.values()].some((v) => v.rec && String(v.rec.url).includes('/api/fail') && v.rec.status === 200)`), 20000, 'Mock 命中后重新抓取');
    await sleep(300);
    await click('mockRule');
    await waitFor(modalVisible, 8000, 'Mock');
    await shotWindow('12-mock');
    await closeModal();

    /* 收尾：关掉 Mock，别把沙盒留在开启状态 */
    await settings.applySetting('mock', { on: false, rules: [] });
    await capture.syncMock();
    console.log(`  截图目录：${OUT}`);
  }

  // 提取弹窗：填行选择器与字段 → 提取 → 截图（结果表最说明问题）
  async function fluidExtract() {
    await click('extract');
    await waitFor(modalVisible, 8000, 'CSS 提取');
    await peval(`(() => {
      const box = document.getElementById('modalBox');
      const areas = box.querySelectorAll('textarea');
      if (areas[0]) areas[0].value = '#items tbody tr';
      if (areas[1]) areas[1].value = 'ID=td:nth-child(1)\\n商品=td:nth-child(2)\\n价格=td:nth-child(3)';
    })()`);
    await click('extractRun');
    await waitFor(async () => String(await peval("document.getElementById('modalBox').textContent")).includes('1001'), 8000, '提取结果');
    await shotWindow('06-extract');
    await closeModal();
  }

  return { main };
}

/* --------------------------------------------------------------- 入口 */

function run(inj) {
  startFixture(async () => {
    const api = make(inj);
    try {
      await api.main();
      console.log('shots: 全部截图完成');
    } catch (e) {
      console.error('shots: 失败 —— ' + ((e && e.message) || e));
      console.error((e && e.stack) || '');
      process.exitCode = 1;
    }
    setTimeout(() => inj.state.win.close(), 200);             // 关窗退出（window-all-closed → app.quit）
  });
}

module.exports = { run };
