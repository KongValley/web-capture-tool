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
    if (r.exceptionDetails) {
      // CDP 的 text 只有「Uncaught」，真正的错误信息在 exception.description（含堆栈）
      const d = r.exceptionDetails.exception || {};
      throw new Error(d.description || r.exceptionDetails.text || '页面脚本执行异常');
    }
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
// 'xpath:' 前缀 = 该选择器按 XPath 解析（XPath 里自带 @，因此跳过属性截断）；行选择器同样支持前缀
function parseFields(text) {
  const lines = String(text == null ? '' : text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => {
    const i = line.indexOf('=');
    const name = (i < 0 ? line : line.slice(0, i)).trim() || line;
    let sel = i < 0 ? line : line.slice(i + 1).trim();
    if (sel.startsWith('xpath:')) return { name, sel: sel.slice(6).trim(), attr: null, mode: 'xpath' };
    let attr = null;
    const at = sel.lastIndexOf('@');
    if (at > 0) { attr = sel.slice(at + 1).trim(); sel = sel.slice(0, at).trim(); }
    if (!sel) sel = ':self';
    return { name, sel, attr, mode: 'css' };
  });
}

async function extractRows(selRows, selFields) {
  const rowSel = String(selRows == null ? '' : selRows).trim();
  if (!rowSel) return { ok: false, error: '请填写行选择器' };
  const lines = String(selFields == null ? '' : selFields).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_FIELDS) return { ok: false, error: `字段最多 ${MAX_FIELDS} 个` };
  const fields = parseFields(selFields);
  if (!fields.length) return { ok: false, error: '请填写字段（每行 名称=选择器）' };
  const rowMode = rowSel.startsWith('xpath:') ? 'xpath' : 'css';
  const rowExpr = rowMode === 'xpath' ? rowSel.slice(6).trim() : rowSel;

  const expr = `(() => {
    const rowSel = ${JSON.stringify(rowExpr)};
    const rowMode = ${JSON.stringify(rowMode)};
    const fields = ${JSON.stringify(fields)};
    // 行级字段的 root 是行元素：以 // 开头的 XPath 改写成 .//，才在行内求值
    const evalXpath = (root, sel, first) => {
      const e = root.nodeType === 9 || !sel.startsWith('//') ? sel : '.' + sel;
      const type = first ? XPathResult.FIRST_ORDERED_NODE_TYPE : XPathResult.ORDERED_NODE_ITERATOR_TYPE;
      return document.evaluate(e, root, null, type, null);
    };
    const findAll = (root, sel, mode) => {
      if (mode === 'xpath') {
        const it = evalXpath(root, sel, false);
        const out = [];
        let n;
        while ((n = it.iterateNext())) out.push(n);
        return out;
      }
      return Array.from(root.querySelectorAll(sel));
    };
    const findOne = (root, sel, mode) => {
      if (mode === 'xpath') return evalXpath(root, sel, true).singleNodeValue;
      return root.querySelector(sel);
    };
    const all = findAll(document, rowSel, rowMode);
    const els = all.slice(0, ${MAX_ROWS});
    const rows = els.map((el) => {
      const o = {};
      for (const f of fields) {
        const t = f.sel === ':self' ? el : findOne(el, f.sel, f.mode);
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
    // 截断前的总数：面板据此提示「已截断」，不再让用户以为页面就这么点内容
    totals: { links: uniqLinks.length, images: images.length, forms: forms.length, tables: tables.length },
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
