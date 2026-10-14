'use strict';
/*
 * 性能基准（--bench）：本地起一台压力服务器，把「主进程抓包 / 面板渲染 / 过滤 / 更新 / 排序 / 会话序列化 / 内存」打成一张表。
 * 用途：老机器上跑一遍找瓶颈，或对比优化前后的同一台机器数字（绝对值受机器影响，看同一台机器上的前后差）。
 * 不改动业务数据：配置 / 日志 / 会话 / 下载都改道到系统临时目录（见 main.js 的 SANDBOX）。
 */
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { net } = require('electron');

const BURST = Number(process.env.WCT_BENCH_N || 800);   // 突发请求数（页面同时打这么多 XHR）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 30000, label = '条件') {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`超时等待：${label}`);
    await sleep(50);
  }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// 压力页：并行发 BURST 个 XHR（每个 1KB JSON），并把结果写进标题以便外部观察
function burstPage(port, n) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>burst</title>
<link rel="stylesheet" href="/style.css"></head><body><h1>burst ${n}</h1>
<div id="box"></div>
<script>
  let done = 0;
  const n = ${n};
  for (let i = 0; i < n; i++) {
    fetch('/api/data?i=' + i).then((r) => r.json()).then(() => { done++; document.title = 'burst ' + done; }).catch(() => { done++; });
  }
<\/script></body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const hits = {};
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      hits[u.pathname] = (hits[u.pathname] || 0) + 1;
      const noStore = { 'Cache-Control': 'no-store' };
      const port = server.address().port;
      if (u.pathname === '/api/data') {
        const pad = 'x'.repeat(900);
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, noStore));
        res.end(JSON.stringify({ ok: true, i: Number(u.searchParams.get('i') || 0), pad }));
        return;
      }
      if (u.pathname === '/style.css') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/css' }, noStore));
        res.end('body { margin: 0; }');
        return;
      }
      if (u.pathname === '/img.png') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'image/png' }, noStore));
        res.end(PNG_1PX);
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noStore));
      res.end(u.pathname === '/burst' ? burstPage(port, Number(u.searchParams.get('n') || BURST)) : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>bench</title></head><body><h1>bench</h1><img src="/img.png"></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits }));
  });
}

// 面板侧的一组渲染耗时（同一 peval 内测 3 次取中位数，避免 IPC 往返噪声）
const PANEL_BENCH = `(() => {
  const bench = (fn, n = 3) => {
    const xs = [];
    for (let i = 0; i < n; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
    xs.sort((a, b) => a - b);
    return Math.round(xs[Math.floor(xs.length / 2)] * 10) / 10;
  };
  const mk = (id, i) => ({ id, method: i % 7 === 0 ? 'POST' : 'GET', url: 'http://bench.host/path/' + i + '?q=' + (i % 13), type: i % 5 === 0 ? 'Fetch' : 'XHR', status: [200, 200, 200, 404, 500][i % 5], size: 1024 + i, duration: 5 + (i % 40), time: new Date().toISOString() });
  const out = {};
  let base = 880000;

  // 1) 流式追加 3000 行（不进批处理的路径）
  out.append3000 = bench(() => { const b = base; base += 3000; for (let i = 0; i < 3000; i++) appendRecord(mk(b + i, i)); }, 1);

  // 2) 批处理里追加 1000 行（主进程 100ms 合并的真实路径）
  out.batch1000 = bench(() => { const b = base; base += 1000; const recs = []; for (let i = 0; i < 1000; i++) recs.push(mk(b + i, i)); applyBatch({ records: recs, drops: [], updates: [], ws: [] }); }, 1);

  // 3) 1000 条更新（同一批里只改状态与耗时）
  out.update1000 = bench(() => {
    const recs = [];
    for (const r of rows.values()) { if (recs.length >= 1000) break; recs.push(Object.assign({}, r.rec, { status: 201, duration: 42 })); }
    applyBatch({ records: [], updates: recs, drops: [], ws: [] });
  });

  // 4) 过滤（输入事件 → 全列表可见性重算）
  const f = document.getElementById('filter');
  out.filter = bench(() => { f.value = 'path/1'; f.dispatchEvent(new Event('input', { bubbles: true })); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
  out.filtered = Number(document.getElementById('nReq').textContent);

  // 5) 列预设切换（全列表重画）
  const col = document.getElementById('colSet');
  out.colSet = bench(() => { col.value = 'dt'; refilter(); col.value = 'd'; refilter(); });

  // 6) 排序 / 域名分组（重排 DOM）
  const sort = document.getElementById('sortBy');
  out.sort = bench(() => { sort.value = 'size'; applySort(); sort.value = 'time'; applySort(); }, 1);
  out.group = bench(() => { sort.value = 'domain'; applySort(); sort.value = 'time'; applySort(); }, 1);

  // 清理合成行，计数回到真实记录
  for (const [id, r] of [...rows]) if (id >= 880000) dropRow(id);
  out.rows = rows.size;
  out.dom = document.querySelectorAll('#list .row').length;
  out.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : -1;
  return out;
})()`;

async function run({ state, capture, session, gpu }) {
  const add = (name, value, unit, extra = '') => console.log(`${name.padEnd(30, ' ')} ${String(value).padStart(9, ' ')} ${unit}${extra ? '   ' + extra : ''}`);

  const { server, hits } = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wc = state.view.webContents;
  const panel = state.win.webContents;
  const peval = (expr) => panel.executeJavaScript(expr, true);
  const cpuMs = (u) => Math.round((u.user + u.system) / 1000);

  console.log(`\n环境：${process.arch} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`);
  console.log(`CPU：${(os.cpus()[0] || {}).model || '?'} × ${os.cpus().length} · 内存 ${(os.totalmem() / 1073741824).toFixed(1)}GB · 软件渲染 ${state.softwareMode ? '是' : '否'}`);
  console.log(`负载：突发 ${BURST} 个请求（每个约 1KB JSON）\n`);

  try {
    await waitFor(() => wc.debugger.isAttached() && state.status === '抓取中', 20000, 'CDP 就绪');
    await wc.loadURL(base + '/');
    await sleep(500);

    // ---- 主进程：突发请求的 CPU 与墙钟 ----
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    await wc.loadURL(`${base}/burst?n=${BURST}`);
    await waitFor(() => hits['/api/data'] >= BURST, 120000, '突发请求到达服务器');
    const cpu = process.cpuUsage(cpu0);
    const wall = Date.now() - t0;
    add('突发请求（墙钟）', wall, 'ms', `${BURST} 个请求`);
    add('突发请求（主进程 CPU）', cpuMs(cpu), 'ms');
    add('  每请求主进程 CPU', (cpuMs(cpu) / BURST).toFixed(3), 'ms');
    await waitFor(() => state.records.length >= BURST + 2, 120000, '记录入内存');
    const domReady = Date.now() - t0;
    await waitFor(async () => Number(await peval(`document.querySelectorAll('#list .row').length`)) >= BURST, 60000, '面板渲染完成');
    add('面板渲染完成（含 100ms 批）', Date.now() - t0, 'ms', `DOM 就绪 ${domReady}ms`);

    // ---- 本地测试服务器自身开销（对照）：net.request 直读同一批 URL，不经 CDP / 面板 ----
    try {
      const cpuS0 = process.cpuUsage();
      await Promise.all(Array.from({ length: BURST }, (_, i) => new Promise((res) => {
        const req = net.request({ method: 'GET', url: `${base}/api/data?i=${i}` });
        req.on('response', (r) => { r.on('data', () => {}); r.on('end', () => res()); });
        req.on('error', () => res());
        req.end();
      })));
      const cpuS = process.cpuUsage(cpuS0);
      add('  其中本地测试服务器', cpuMs(cpuS), 'ms', 'net.request 直读，不含 CDP/面板');
    } catch (e) { /* 对照项失败不影响其它数字 */ }

    // ---- 面板渲染热路径 ----
    const p = await peval(PANEL_BENCH);
    add('追加 3000 行', p.append3000, 'ms', '逐条 appendRecord');
    add('批处理追加 1000 行', p.batch1000, 'ms', 'applyBatch');
    add('1000 条更新', p.update1000, 'ms');
    add('过滤（输入事件）', p.filter, 'ms', `命中 ${p.filtered} 行`);
    add('切换列预设（重画）', p.colSet, 'ms');
    add('按大小排序（重排）', p.sort, 'ms');
    add('域名分组（重排）', p.group, 'ms');
    add('面板内存', p.heapMB, 'MB', `行 ${p.rows} / DOM ${p.dom}`);

    // ---- 会话序列化（同步 JSON 成本，30s 定时器每次都要付）----
    const s0 = Date.now();
    const json = JSON.stringify(state.records.map(capture.fullRecord));
    add('会话序列化（同步 JSON）', Date.now() - s0, 'ms', `${(json.length / 1048576).toFixed(1)}MB / ${state.records.length} 条`);
    const s1 = Date.now();
    const saved = await session.save();
    add('会话写盘（含磁盘）', Date.now() - s1, 'ms', saved.ok ? path.basename(saved.file) : saved.error);
    fs.rmSync(path.dirname(session.filePath()), { recursive: true, force: true });

    // ---- 主进程内存 ----
    const mem = process.memoryUsage();
    add('主进程内存（RSS）', Math.round(mem.rss / 1048576), 'MB', `heap ${Math.round(mem.heapUsed / 1048576)}MB`);

    console.log(`\n提示：老机器上同一份代码的数字会整体放大（CPU 主频 / 内存带宽 / 机械硬盘），对比优化前后请在同一台机器上跑。`);
    add('GPU 状态', (gpu.describe().gpuCompositing || '(未知)'), '');
  } catch (e) {
    console.log(`\n基准执行失败：${e.message}`);
  }

  server.close();
  require('electron').app.exit(0);
}

module.exports = { run };
