'use strict';
/*
 * 纯函数：请求头合并 / cURL / CSV / HAR。
 * 不 require electron，便于自检直接调用断言。
 */

// CDP 的 *Raw 头（requestWillBeSentExtraInfo / responseReceivedExtraInfo）是对象 {name: value}，
// 不是数组；对象项优先（含 Set-Cookie / Cookie），缺的用普通头补。
function mergedHeaders(raw, plain) {
  const out = [];
  const seen = new Set();
  for (const src of [raw, plain]) {
    if (!src) continue;
    for (const k of Object.keys(src)) {
      const lk = k.toLowerCase();
      if (seen.has(lk)) continue;
      seen.add(lk);
      const v = src[k];
      out.push({ name: k, value: Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v) });
    }
  }
  return out;
}

const requestHeaderList = (rec) => mergedHeaders(rec.requestHeadersRaw, rec.requestHeaders);
const responseHeaderList = (rec) => mergedHeaders(rec.responseHeadersRaw, rec.responseHeaders);

function headerValue(list, name) {
  const h = list.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

const SKIP_CURL = new Set(['content-length', 'host']);

// 请求头文本 → { name: value }：每行按第一个 ':' 切分；空行跳过
function parseHeaderLines(text) {
  const out = {};
  let bad = 0;
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) { bad++; continue; }
    const k = t.slice(0, i).trim();
    if (!k) { bad++; continue; }
    out[k] = t.slice(i + 1).trim();
  }
  if (!Object.keys(out).length && bad) return { ok: false, error: '请求头格式应为 名称: 值（每行一个）' };
  return { ok: true, value: out };
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildCurl(rec) {
  const parts = [`curl ${shellQuote(rec.url)}`];
  if (rec.method && rec.method !== 'GET') parts.push(`-X ${rec.method}`);
  for (const h of requestHeaderList(rec)) {
    if (SKIP_CURL.has(h.name.toLowerCase())) continue;
    parts.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  if (rec.postData) parts.push(`--data-raw ${shellQuote(rec.postData)}`);
  return parts.join(' ');
}

const BOM = '\uFEFF';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToCsv(rows) {
  if (!rows || !rows.length) return BOM;
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r || {})) if (!cols.includes(k)) cols.push(k);
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r ? r[c] : '')).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

function tablesToCsv(tables) {
  if (!tables || !tables.length) return BOM;
  const out = [];
  tables.forEach((t, i) => {
    out.push(`# 表格${i + 1}`);
    if (t.headers && t.headers.length) out.push(t.headers.map(csvEscape).join(','));
    for (const row of t.rows || []) out.push((row || []).map(csvEscape).join(','));
    out.push('');
  });
  return BOM + out.join('\r\n');
}

function buildHar(records, title) {
  const now = new Date().toISOString();
  const entries = (records || []).map((rec) => {
    const reqH = requestHeaderList(rec);
    const resH = responseHeaderList(rec);
    const qs = [];
    try { new URL(rec.url).searchParams.forEach((v, k) => qs.push({ name: k, value: v })); } catch (e) { /* 非标准 URL 忽略查询串 */ }
    const size = rec.body == null
      ? (rec.encodedDataLength || 0)
      : (rec.bodyBase64 ? Math.round((rec.body.length * 3) / 4) : Buffer.byteLength(rec.body));
    const content = { size, mimeType: rec.mime || 'x-unknown' };
    if (rec.body != null) content.text = rec.body;
    if (rec.bodyBase64) content.encoding = 'base64';
    const entry = {
      pageref: 'page_1',
      startedDateTime: rec.time,
      time: rec.duration || 0,
      request: {
        method: rec.method, url: rec.url, httpVersion: rec.protocol || 'HTTP/1.1',
        cookies: [], headers: reqH, queryString: qs,
        headersSize: -1, bodySize: rec.postData ? Buffer.byteLength(rec.postData) : 0,
      },
      response: {
        status: rec.status, statusText: rec.statusText || '', httpVersion: rec.protocol || 'HTTP/1.1',
        cookies: [], headers: resH, content,
        redirectURL: (rec.redirects[0] && rec.redirects[0].location) || '',
        headersSize: -1, bodySize: rec.encodedDataLength || 0,
      },
      cache: {},
      timings: { send: 0, wait: rec.duration || 0, receive: 0 },
      serverIPAddress: rec.remoteIP || '',
      _resourceType: rec.type,
    };
    if (rec.postData) entry.request.postData = { mimeType: headerValue(reqH, 'content-type') || 'text/plain', text: rec.postData };
    if (rec.failed && rec.failed.errorText) entry.response._error = rec.failed.errorText;
    if (rec.failed && rec.failed.blockedReason) entry._blocked = rec.failed.blockedReason;
    return entry;
  });
  return {
    log: {
      version: '1.2',
      creator: { name: 'web-capture-tool', version: '1.0.0' },
      pages: [{
        startedDateTime: (records && records[0] && records[0].time) || now,
        id: 'page_1', title: title || '', pageTimings: {},
      }],
      entries,
    },
  };
}

const STATUS_CLASS = (s) => (!s ? '失败/未响应' : s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : '2xx');
// 当前标签的抓包概览：按域名 / 类型 / 状态分组，外加最慢与最大的 top10（纯函数，面板「统计概览」用）
function buildStats(records) {
  const list = records || [];
  const byDomain = new Map();
  const byType = new Map();
  const byStatus = new Map();
  for (const r of list) {
    let host = '';
    try { host = new URL(r.url).host; } catch (e) { host = '(无法解析)'; }
    const d = byDomain.get(host) || { host, count: 0, bytes: 0 };
    d.count++;
    d.bytes += r.encodedDataLength || 0;
    byDomain.set(host, d);
    const t = r.type || '(未知)';
    byType.set(t, (byType.get(t) || 0) + 1);
    const cls = STATUS_CLASS(r.status);
    byStatus.set(cls, (byStatus.get(cls) || 0) + 1);
  }
  const top = (arr, cmp) => arr.slice().sort(cmp).slice(0, 10);
  return {
    total: list.length,
    totalBytes: list.reduce((n, r) => n + (r.encodedDataLength || 0), 0),
    byDomain: top([...byDomain.values()], (a, b) => b.bytes - a.bytes || b.count - a.count),
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byStatus: [...byStatus.entries()].map(([cls, count]) => ({ cls, count })).sort((a, b) => b.count - a.count),
    slowest: top(list.filter((r) => r.duration != null), (a, b) => b.duration - a.duration)
      .map((r) => ({ method: r.method, url: r.url, ms: r.duration })),
    largest: top(list, (a, b) => (b.encodedDataLength || 0) - (a.encodedDataLength || 0))
      .map((r) => ({ method: r.method, url: r.url, size: r.encodedDataLength || 0 })),
  };
}

/* ------------------------------------------------- 抓包快照对比 */

// 两次抓包快照对比：按 `METHOD url` 归组（同键多条取第一条代表 + 记条数）。
// 耗时差超过 max(20ms, 20%) 才算「变化」，避免噪声；每个分组最多列 100 条。
function diffSnapshots(a, b) {
  const group = (items) => {
    const m = new Map();
    for (const it of items || []) {
      const k = it.k;
      const g = m.get(k) || { k, n: 0, first: it };
      g.n++;
      m.set(k, g);
    }
    return m;
  };
  const A = group(a && a.items);
  const B = group(b && b.items);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, gb] of B) {
    const ga = A.get(k);
    if (!ga) { added.push({ k, status: gb.first.status, size: gb.first.size, ms: gb.first.duration, n: gb.n }); continue; }
    const dur = (x, y) => (x == null || y == null ? x !== y : Math.abs(y - x) > Math.max(20, x * 0.2));
    if (ga.first.status !== gb.first.status || dur(ga.first.duration, gb.first.duration) || ga.first.size !== gb.first.size) {
      changed.push({ k, from: { status: ga.first.status, ms: ga.first.duration, size: ga.first.size }, to: { status: gb.first.status, ms: gb.first.duration, size: gb.first.size } });
    }
  }
  for (const [k, ga] of A) if (!B.has(k)) removed.push({ k, status: ga.first.status, size: ga.first.size, ms: ga.first.duration, n: ga.n });
  const cap = (arr) => arr.slice(0, 100);
  return {
    added: cap(added), removed: cap(removed), changed: cap(changed),
    addedN: added.length, removedN: removed.length, changedN: changed.length,
  };
}

/* ------------------------------------------------- 抓包转代码 / 表格导出 */

const SNIPPET_SKIP = new Set(['content-length', 'host']);   // 由各语言的 HTTP 客户端自己算
const pyStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const jsStr = (s) => JSON.stringify(String(s));
const bodyOf = (rec) => (rec.postData == null ? '' : String(rec.postData));
const snippetHeaders = (rec) => requestHeaderList(rec).filter((h) => !SNIPPET_SKIP.has(h.name.toLowerCase()));

function buildPythonRequests(rec) {
  const hs = snippetHeaders(rec);
  const body = bodyOf(rec);
  const out = ['import requests', '', `url = ${pyStr(rec.url)}`];
  if (hs.length) {
    out.push('headers = {');
    for (const h of hs) out.push(`    ${jsStr(h.name)}: ${jsStr(h.value)},`);
    out.push('}');
  } else {
    out.push('headers = {}');
  }
  if (body) out.push(`data = ${pyStr(body)}`);
  out.push('');
  out.push(`r = requests.request(${jsStr(rec.method)}, url, headers=headers${body ? ', data=data.encode("utf-8")' : ''}, timeout=30)`);
  out.push('print(r.status_code, len(r.content))');
  return out.join('\n') + '\n';
}

function buildNodeFetch(rec) {
  const hs = snippetHeaders(rec);
  const body = bodyOf(rec);
  const out = ['// Node 18+（内置 fetch）', 'const headers = {'];
  for (const h of hs) out.push(`  ${jsStr(h.name)}: ${jsStr(h.value)},`);
  out.push('};');
  const opts = [`method: ${jsStr(rec.method)}`, 'headers'];
  if (body) opts.push(`body: ${jsStr(body)}`);
  out.push(`const res = await fetch(${jsStr(rec.url)}, { ${opts.join(', ')} });`);
  out.push('console.log(res.status, await res.text());');
  return out.join('\n') + '\n';
}

function buildNodeAxios(rec) {
  const hs = snippetHeaders(rec);
  const body = bodyOf(rec);
  const out = ["const axios = require('axios');", '', 'const headers = {'];
  for (const h of hs) out.push(`  ${jsStr(h.name)}: ${jsStr(h.value)},`);
  out.push('};');
  const opts = [`method: ${jsStr(rec.method)}`, `url: ${jsStr(rec.url)}`, 'headers'];
  if (body) opts.push(`data: ${jsStr(body)}`);
  out.push(`const res = await axios.request({ ${opts.join(', ')} });`);
  out.push('console.log(res.status, res.data);');
  return out.join('\n') + '\n';
}

// Postman Collection v2.1（可直接导入 Postman / Insomnia）
function buildPostmanCollection(records, name) {
  return {
    info: {
      name: name || 'web-capture-tool',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: (records || []).map((rec, i) => {
      const request = {
        method: rec.method,
        header: snippetHeaders(rec).map((h) => ({ key: h.name, value: h.value })),
        url: { raw: rec.url },
      };
      const body = bodyOf(rec);
      if (body) request.body = { mode: 'raw', raw: body };
      return { name: `${i + 1}. ${rec.method} ${rec.url}`, request };
    }),
  };
}

function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
  return (n / 1048576).toFixed(1) + 'M';
}

function buildMarkdownTable(records) {
  const cells = (arr) => `| ${arr.join(' | ')} |`;
  const escPipe = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|');
  const out = [];
  out.push(cells(['#', '方法', '状态', '类型', '大小', '耗时', '★', 'URL']));
  out.push(cells(['---', '---', '---', '---', '---', '---', '---', '---']));
  (records || []).forEach((r, i) => {
    out.push(cells([
      i + 1, escPipe(r.method), escPipe(r.status || (r.failed ? '×' : '')), escPipe(r.type),
      humanSize(r.encodedDataLength || 0), r.duration == null ? '' : `${r.duration}ms`,
      r.star ? '★' : '', escPipe(r.url),
    ]));
  });
  return out.join('\n') + '\n';
}

module.exports = {
  mergedHeaders, requestHeaderList, responseHeaderList, headerValue, parseHeaderLines,
  buildCurl, csvEscape, rowsToCsv, tablesToCsv, buildHar, buildStats, diffSnapshots,
  buildPythonRequests, buildNodeFetch, buildNodeAxios, buildPostmanCollection, buildMarkdownTable,
};
