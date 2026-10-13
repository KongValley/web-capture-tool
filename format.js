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

module.exports = {
  mergedHeaders, requestHeaderList, responseHeaderList, headerValue, parseHeaderLines,
  buildCurl, csvEscape, rowsToCsv, tablesToCsv, buildHar,
};
