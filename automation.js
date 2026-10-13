'use strict';
/*
 * 自动化：当前页自动滚动加载 + 自动翻页 N 页。
 * 只驱动同一个视图，不做站内队列爬取。state.auto 用于运行态与停止标志。
 */
const { state, setStatus } = require('./state');
const extract = require('./extract');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

const SCROLL_EXPR = '(() => { const h = document.documentElement.scrollHeight; window.scrollTo(0, h); return h; })()';
const HEIGHT_EXPR = 'document.documentElement.scrollHeight';

// 找「下一页」并点击；返回其标识，找不到返回 null
const NEXT_EXPR = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const rel = document.querySelector('a[rel="next"]');
  if (rel && vis(rel)) { rel.click(); return rel.href || 'rel=next'; }
  const T = ['下一页', '下页', 'next', 'next page', '›', '»', '更多', 'more'];
  for (const el of document.querySelectorAll('a,button')) {
    if (!vis(el)) continue;
    const t = (el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    const lt = t.toLowerCase();
    if (T.some((x) => t === x || lt === x)) { el.click(); return el.href || t; }
    if (aria.includes('下一页') || aria.toLowerCase().includes('next')) { el.click(); return el.href || aria; }
  }
  return null;
})()`;

const SCROLL_TIMEOUT = 120000;

async function runScroll(rounds, t0) {
  let done = 0;
  let stable = 0;
  let reason = 'done';
  for (let i = 0; i < rounds; i++) {
    if (state.auto.stop) { reason = 'stopped'; break; }
    if (Date.now() - t0 > SCROLL_TIMEOUT) { reason = 'timeout'; break; }
    const h = await extract.evalPage(SCROLL_EXPR);
    await sleep(800);
    let h2 = h;
    try { h2 = await extract.evalPage(HEIGHT_EXPR); } catch (e) { /* 页面正在跳转，按未增长处理 */ }
    done = i + 1;
    setStatus(`自动滚动 ${done}/${rounds}…`);
    if (h2 <= h) {
      stable++;
      if (stable >= 2) { reason = 'done'; break; }
    } else stable = 0;
  }
  return { rounds: done, reason };
}

async function runPages(pages, delay) {
  const wc = state.view.webContents;
  let done = 1;
  let reason = 'done';
  for (let i = 1; i < pages; i++) {
    if (state.auto.stop) { reason = 'stopped'; break; }
    const loaded = new Promise((res) => wc.once('did-finish-load', () => res(true)));   // 先挂监听再点击，避免竞态
    const hit = await extract.evalPage(NEXT_EXPR);
    if (!hit) { reason = 'no-next'; break; }
    await Promise.race([loaded, sleep(Math.max(delay, 1000)).then(() => false)]);
    await sleep(200);
    done = i + 1;
    setStatus(`自动翻页 ${done}/${pages}…`);
  }
  return { pages: done, reason };
}

async function autoRun(opts) {
  const o = opts || {};
  const mode = o.mode === 'page' ? 'page' : 'scroll';
  const rounds = clampInt(o.rounds, 1, 50, 5);
  const pages = clampInt(o.pages, 1, 100, 3);
  const delay = clampInt(o.delay, 200, 60000, 2000);
  if (state.auto.running) return { ok: false, error: '已有自动化任务在运行' };
  state.auto.running = true;
  state.auto.stop = false;
  const t0 = Date.now();
  try {
    const r = mode === 'scroll' ? await runScroll(rounds, t0) : await runPages(pages, delay);
    return Object.assign({ ok: true, mode }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    state.auto.running = false;
    state.auto.stop = false;
  }
}

function autoStop() {
  if (!state.auto.running) return { ok: false, error: '当前没有自动化任务' };
  state.auto.stop = true;
  return { ok: true };
}

module.exports = { autoRun, autoStop };
