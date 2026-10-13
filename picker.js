'use strict';
/*
 * 元素拾取器：往页面注入「悬停高亮 + 点击回传选择器」，选择器算法与录制共用 recorder.SELECTOR_SRC。
 * 回传走 CDP binding（页面 → 主进程），由 capture.js 的 Runtime.bindingCalled 分发到 onBinding。
 * 依赖方向：picker → {state, logger, recorder}；capture 反过来只做事件分发，recorder 不认识 picker。
 */
const { state, send } = require('./state');
const logger = require('./logger');
const recorder = require('./recorder');

const BINDING = '__wctPick';

const PICK_SCRIPT = `(() => {
  if (window.__wctPickArmed) return;
  window.__wctPickArmed = true;
  ${recorder.SELECTOR_SRC}
  let last = null;
  const hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;background:#4c8dff22;display:none';
  document.documentElement.appendChild(hl);
  const post = (o) => { try { if (window.__wctPick) window.__wctPick(JSON.stringify(o)); } catch (e) {} };
  const move = (e) => {
    const el = e.target;
    if (!el || el === hl) return;
    const r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
    last = el;
  };
  function cleanup() {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', onKey, true);
    window.__wctPickArmed = false;
    try { delete window.__wctPickCleanup; } catch (e) {}
    if (hl.parentNode) hl.parentNode.removeChild(hl);
  }
  window.__wctPickCleanup = cleanup;             // 面板侧取消时主进程会调它把页面摘干净
  function click(e) {
    e.preventDefault(); e.stopPropagation();
    const el = last || e.target;
    post({ sel: selOf(el), tag: ((el && el.tagName) || '').toLowerCase(), text: String((el && el.textContent) || '').trim().slice(0, 80) });
    cleanup();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    post({ cancel: true });
    cleanup();
  }
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', onKey, true);
})()`;

let armed = null;   // { wcId, identifier }：当前注入中的标签

function activeWc() {
  const v = state.view;
  return v && !v.webContents.isDestroyed() ? v.webContents : null;
}

async function start() {
  const wc = activeWc();
  if (!wc) return { ok: false, error: '视图未就绪' };
  const dbg = wc.debugger;
  if (!dbg.isAttached()) return { ok: false, error: 'CDP 未就绪' };
  await stop();                                  // 重复点击「拾取」：先清掉上一次的注入
  try {
    await dbg.sendCommand('Runtime.enable');
    await dbg.sendCommand('Runtime.addBinding', { name: BINDING });
    const r = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PICK_SCRIPT });
    armed = { wcId: wc.id, identifier: r && r.identifier };
    await dbg.sendCommand('Runtime.evaluate', { expression: PICK_SCRIPT, returnByValue: true });
    return { ok: true };
  } catch (e) {
    logger.log('pick', `注入失败：${e.message}`);
    armed = null;
    return { ok: false, error: e.message };
  }
}

async function stop() {
  if (!armed) return { ok: true };
  const item = armed;
  armed = null;
  const wc = state.tabs.map((t) => t.wc).find((c) => c.id === item.wcId) || activeWc();
  if (!wc || wc.isDestroyed()) return { ok: true };
  // 页面侧也要摘干净：否则高亮框与三个事件监听会留在页面上（用户点一下才自清理）
  try {
    if (wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: '(() => { if (typeof window.__wctPickCleanup === "function") { window.__wctPickCleanup(); return true; } window.__wctPickArmed = false; return false; })()',
        returnByValue: true,
      });
    }
  } catch (e) { /* 页面已导航或目标失效 */ }
  try {
    if (item.identifier) await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: item.identifier });
  } catch (e) { /* 目标已失效 */ }
  try {
    await wc.debugger.sendCommand('Runtime.removeBinding', { name: BINDING });
  } catch (e) { /* 目标已失效 */ }
  return { ok: true };
}

// 页面回传：取消或拾取都要摘掉注入，再把结果推给面板
function onBinding(params) {
  let payload = null;
  try { payload = JSON.parse(params.payload); } catch (e) { return; }
  if (!payload) return;
  stop().catch(() => {});
  send('cap:picked', payload.cancel ? { cancel: true } : payload);
}

module.exports = { BINDING, PICK_SCRIPT, start, stop, onBinding };
