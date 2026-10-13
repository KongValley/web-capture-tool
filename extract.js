'use strict';
/*
 * 页面侧数据采集与提取：所有"在页面里跑 JS"的逻辑都从这里走。
 * 优先用 CDP Runtime.evaluate（不受页面 CSP 限制），CDP 未挂载时退回 executeJavaScript。
 */
const { session } = require('electron');
const { state, PARTITION } = require('./state');

async function evalPage(expression) {
  const wc = state.view && state.view.webContents;
  if (!wc) throw new Error('视图未就绪');
  if (wc.debugger.isAttached()) {
    const r = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本执行异常');
    return r.result.value;
  }
  return wc.executeJavaScript(expression, true);
}

const STORAGE_EXPR = `(() => {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
  return {
    url: location.href, title: document.title,
    cookies: document.cookie,
    localStorage: dump(localStorage), sessionStorage: dump(sessionStorage)
  };
})()`;

async function collectPageData() {
  const wc = state.view.webContents;
  const [html, page] = await Promise.all([
    evalPage('document.documentElement.outerHTML').catch((e) => `<!-- 取 HTML 失败：${e.message} -->`),
    evalPage(STORAGE_EXPR).catch((e) => ({ error: e.message })),
  ]);
  const cookies = await session.fromPartition(PARTITION).cookies.get({});
  return { url: wc.getURL(), title: wc.getTitle(), html, page, cookies };
}

/* ------------------------------------------------------------ 数据提取 */

const MAX_FIELDS = 50;
const MAX_ROWS = 5000;

// '标题=.title' / '链接=a@href' / '正文=@html' / ':self' —— 最后一个 @ 之后是属性名（@ 在第 0 位时不算）
function parseFields(text) {
  const lines = String(text == null ? '' : text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => {
    const i = line.indexOf('=');
    const name = (i < 0 ? line : line.slice(0, i)).trim() || line;
    let sel = i < 0 ? line : line.slice(i + 1).trim();
    let attr = null;
    const at = sel.lastIndexOf('@');
    if (at > 0) { attr = sel.slice(at + 1).trim(); sel = sel.slice(0, at).trim(); }
    if (!sel) sel = ':self';
    return { name, sel, attr };
  });
}

async function extractRows(selRows, selFields) {
  const rowSel = String(selRows == null ? '' : selRows).trim();
  if (!rowSel) return { ok: false, error: '请填写行选择器' };
  const lines = String(selFields == null ? '' : selFields).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_FIELDS) return { ok: false, error: `字段最多 ${MAX_FIELDS} 个` };
  const fields = parseFields(selFields);
  if (!fields.length) return { ok: false, error: '请填写字段（每行 名称=选择器）' };

  const expr = `(() => {
    const rowSel = ${JSON.stringify(rowSel)};
    const fields = ${JSON.stringify(fields)};
    const all = Array.from(document.querySelectorAll(rowSel));
    const els = all.slice(0, ${MAX_ROWS});
    const rows = els.map((el) => {
      const o = {};
      for (const f of fields) {
        const t = f.sel === ':self' ? el : el.querySelector(f.sel);
        if (!t) { o[f.name] = null; continue; }
        if (!f.attr) o[f.name] = (t.textContent || '').trim();
        else if (f.attr === 'href' && t.href) o[f.name] = t.href;
        else if (f.attr === 'src' && t.src) o[f.name] = t.src;
        else if (f.attr === 'html') o[f.name] = t.innerHTML;
        else o[f.name] = t.getAttribute(f.attr);
      }
      return o;
    });
    return { rows, total: all.length };
  })()`;

  try {
    const r = await evalPage(expr);
    return { ok: true, rows: r.rows, count: r.rows.length, truncated: r.total > r.rows.length };
  } catch (e) {
    return { ok: false, error: `提取失败：${e.message}` };
  }
}

const HARVEST_EXPR = `(() => {
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ text: (a.textContent || '').trim().slice(0, 200), href: a.href }));
  const seen = new Set(); const uniqLinks = [];
  for (const l of links) { if (!seen.has(l.href)) { seen.add(l.href); uniqLinks.push(l); } }
  const images = [...document.querySelectorAll('img')].map((i) => ({ src: i.currentSrc || i.src, alt: i.alt, width: i.naturalWidth, height: i.naturalHeight }));
  const forms = [...document.querySelectorAll('form')].map((f) => ({ action: f.action, method: (f.method || 'get').toUpperCase(),
    fields: [...f.querySelectorAll('input,select,textarea')].map((e) => e.name).filter(Boolean) }));
  const tables = [...document.querySelectorAll('table')].map((t, i) => {
    let headers = [...t.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
    if (!headers.length) {
      const first = t.querySelector('tr');
      if (first) headers = [...first.querySelectorAll('th,td')].map((c) => (c.textContent || '').trim());
    }
    const rows = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()).slice(0, 40)).slice(0, 200);
    return { index: i, headers, rows };
  });
  return {
    url: location.href, title: document.title,
    links: uniqLinks.slice(0, 2000), images: images.slice(0, 1000),
    forms: forms.slice(0, 200), tables: tables.slice(0, 50),
  };
})()`;

async function harvest() {
  try {
    const r = await evalPage(HARVEST_EXPR);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: `页面清单提取失败：${e.message}` };
  }
}

module.exports = { evalPage, STORAGE_EXPR, collectPageData, extractRows, harvest, parseFields };
