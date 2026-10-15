'use strict';
/*
 * 离线包：把当前页 HTML 与其静态资源（JS/CSS/图片/字体/媒体）按原始路径镜像成一个目录，
 * HTML / CSS 里的引用重写成相对路径，双击入口文件即可离线打开。
 * 只使用抓包已捕获的字节，不发新请求；抓不到的资源记进 manifest.missing，不中断整个导出。
 * 产出（全部相对导出目录）：
 *   manifest.json                      文件清单 / 缺失清单 / 计数
 *   network.json                       本次抓包的请求头 / 请求体 / 响应头（不含响应体）
 *   js/index.json + js/_inline/NNN.js  外链与动态脚本清单、内联脚本副本
 *   hints.json                         请求参数名 / 值在已存 JS 里的出现位置（定位加密 / 签名代码）
 *   site/<host>/…                      镜像站（入口 HTML 与全部静态资源）
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { state } = require('./state');
const files = require('./files');
const capture = require('./capture');
const extract = require('./extract');

const INLINE_DIR = 'js/_inline';               // 内联脚本副本目录
const STATIC_RECORD_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media']);
// performance 条目里排除「接口类」initiator：它们的字节不属于离线复现所需的静态资源（network.json 里另有记录）
const SKIP_INITIATORS = new Set(['fetch', 'xmlhttprequest', 'beacon', 'eventsource', 'websocket', 'navigation', 'iframe', 'ping']);
const MAX_HINT_FILE = 8 * 1024 * 1024;         // 单个 JS 参与线索定位的上限
const MAX_HINT_TOTAL = 64 * 1024 * 1024;       // 全部 JS 参与线索定位的上限
const HINT_HITS = 3;                           // 每个关键词最多几条命中
const HINT_TEXT = 200;                         // 命中行截断长度
const HINT_VALUES_PER_KEY = 3;                 // 每个参数键最多带几个值去定位

// 页面侧清单：一次 evalPage 拿全（页面枚举不到的资源由 state.records 兜底）
const PAGE_EXPR = `(() => ({
  baseURI: document.baseURI,
  resources: performance.getEntriesByType('resource').map((e) => ({ url: e.name, initiatorType: e.initiatorType })),
  scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src),
  links: [...document.querySelectorAll('link[href]')].map((l) => ({ url: l.href, rel: l.rel })),
  media: [...document.querySelectorAll('img[src],source[src],video[src],audio[src]')].map((e) => e.src),
  inline: [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent)
}))()`;

const stripHash = (s) => String(s == null ? '' : s).split('#')[0];
const skippable = (url) => /^(data|blob|javascript|about|chrome-extension):/i.test(String(url || ''));
const toBuffer = (rec) => (rec.bodyBase64 ? Buffer.from(rec.body, 'base64') : Buffer.from(String(rec.body), 'utf8'));

/* ---------------------------------------------------- 引用重写（纯函数） */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 把文本里的引用（绝对 URL / //host/… / /path / 相对 baseUrl 形态）换成相对 fromFile 的路径。
// 未命中映射的引用原样保留：不猜测、不报错。
function rewriteRefs(text, baseUrl, map, fromFile) {
  const fromDir = path.posix.dirname(String(fromFile).replace(/\\/g, '/'));
  const toRel = (target) => {
    const t = String(target).replace(/\\/g, '/');
    return path.posix.relative(fromDir, t) || path.posix.basename(t);
  };
  let base = null;
  try { base = new URL(String(baseUrl || '')); } catch (e) { base = null; }
  const jobs = [];
  for (const [rawUrl, targetFile] of map) {
    let t = null;
    try { t = new URL(String(rawUrl)); } catch (e) { continue; }
    const forms = new Set([t.href, '//' + t.host + t.pathname + t.search, t.pathname + t.search]);
    if (base && base.origin === t.origin) {
      const rel = path.posix.relative(path.posix.dirname(base.pathname), t.pathname);
      if (rel) {
        for (const form of rel.startsWith('.') ? [rel] : [rel, './' + rel]) {
          if (new URL(form, base).href === t.href) forms.add(form);   // 只在解析回目标 URL 时才算候选
        }
      }
    }
    const to = toRel(targetFile);
    for (const form of forms) if (form && form.length > 1) jobs.push({ form, to });
  }
  jobs.sort((a, b) => b.form.length - a.form.length);                  // 长形态优先，避免短形态先吃掉
  let out = String(text == null ? '' : text);
  for (const j of jobs) {
    out = out.replace(new RegExp('(?<=["\'\\s=(,])' + escapeRe(j.form) + '(?=["\')\\s>,])', 'g'), () => j.to);
  }
  return out;
}

/* ------------------------------------------------------------------ 线索定位（纯函数） */

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (e) { return v; }
}

// 关键词 = URL 查询参数键 ∪ POST/PUT 键（JSON 顶层键或 &/= 拆键）∪ 这些键用过的值（去重 / 长度 3–64 / 跳过纯数字）
function buildHints(records, jsTexts) {
  const generatedAt = new Date().toISOString();
  if (!jsTexts || !jsTexts.length) return { generatedAt, keywords: [] };   // 没有已存 JS，定位无意义
  const valuesOf = new Map();     // 键 → Set(用过的值)
  const keys = [];
  const touch = (k, v) => {
    const key = String(k == null ? '' : k);
    if (!key) return;
    if (!valuesOf.has(key)) { valuesOf.set(key, new Set()); keys.push(key); }
    const val = v == null ? '' : String(v);
    if (val) valuesOf.get(key).add(val);
  };
  for (const r of records || []) {
    try {
      for (const [k, v] of new URL(r.url).searchParams) touch(k, v);
    } catch (e) { /* 非标准 URL 跳过 */ }
    const m = String(r.method || '').toUpperCase();
    if ((m === 'POST' || m === 'PUT') && r.postData) {
      let parsed = null;
      try { parsed = JSON.parse(r.postData); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) touch(k, v && typeof v === 'object' ? '' : v);
      } else {
        for (const pair of String(r.postData).split('&')) {
          if (!pair) continue;
          const i = pair.indexOf('=');
          touch(safeDecode(i < 0 ? pair : pair.slice(0, i)), i < 0 ? '' : safeDecode(pair.slice(i + 1)));
        }
      }
    }
  }
  // 关键词可达上百个：脚本行只切一遍（原实现对每个关键词把所有脚本重新 split('\n')，几十 MB 文本会卡分钟级）
  const scanned = [];
  let total = 0;
  for (const f of jsTexts) {
    if (f.text.length > MAX_HINT_FILE) continue;
    if (total + f.text.length > MAX_HINT_TOTAL) break;
    total += f.text.length;
    scanned.push({ file: f.file, lines: f.text.split('\n') });
  }
  const search = (keyword) => {
    const hits = [];
    for (const f of scanned) {
      for (let i = 0; i < f.lines.length && hits.length < HINT_HITS; i++) {
        if (f.lines[i].includes(keyword)) hits.push({ file: f.file, line: i + 1, text: f.lines[i].trim().slice(0, HINT_TEXT) });
      }
      if (hits.length >= HINT_HITS) break;
    }
    return hits;
  };
  const keywords = [];
  for (const key of keys) {
    keywords.push({ keyword: key, kind: 'param', hits: search(key) });
    let n = 0;
    for (const v of valuesOf.get(key)) {
      if (n >= HINT_VALUES_PER_KEY) break;
      if (v.length < 3 || v.length > 64 || /^\d+$/.test(v)) continue;
      n++;
      keywords.push({ keyword: v, kind: 'value', hits: search(v) });
    }
  }
  return { generatedAt: new Date().toISOString(), keywords };
}

/* ---------------------------------------------------------------------------- 导出 */

// 每条 URL 取最后一条「带响应体」的记录：记录是抓包现场，晚到的才是最终服务的那份
function bodyRecord(url) {
  for (let i = state.records.length - 1; i >= 0; i--) {
    const r = state.records[i];
    if (r.body == null) continue;
    if (stripHash(r.url) === url) return r;
  }
  return null;
}

function networkSnapshot(pageUrl) {
  return {
    pageUrl,
    savedAt: new Date().toISOString(),
    records: state.records.map((r) => {
      const f = capture.fullRecord(r);
      return {
        id: f.id, method: f.method, url: f.url, type: f.type, time: f.time,
        status: f.status, statusText: f.statusText, mime: f.mime,
        size: f.encodedDataLength, duration: f.durationMs, failed: f.failed,
        redirects: f.redirects,
        requestHeaders: f.requestHeaders, requestHeadersRaw: f.requestHeadersRaw, postData: f.postData,
        initiator: f.initiator || null,
        timing: f.timing || null, timingParts: f.timingParts || null,
        responseHeaders: f.responseHeaders, responseHeadersRaw: f.responseHeadersRaw,
      };
    }),
  };
}

async function saveBundle(opts = {}) {
  const t0 = Date.now();
  const includeNetwork = opts.includeNetwork !== false;
  const includeHints = opts.includeHints !== false;
  let dir = opts.dir ? String(opts.dir) : '';
  if (!dir) {
    const picked = await files.pickDirectory();
    if (!picked.ok) return { ok: false, canceled: true };
    dir = picked.dir;
  }
  try {
    const wc = state.view && state.view.webContents;
    const pageUrl = wc ? stripHash(wc.getURL()) : '';
    const title = wc ? wc.getTitle() : '';
    let page = null;
    try { page = await extract.evalPage(PAGE_EXPR); } catch (e) { page = null; }
    page = page || { resources: [], scripts: [], links: [], media: [], inline: [] };

    /* ---- 1) 待导出 URL 集合：页面侧枚举 ∪ 记录里的静态类型 ∪ JS 并集 ---- */
    const urls = new Map();                  // url → { url, type }
    const addUrl = (raw, type) => {
      const url = stripHash(raw);
      if (!url || skippable(url)) return;
      const prev = urls.get(url);
      if (!prev) urls.set(url, { url, type: type || '' });
      else if (!prev.type && type) prev.type = type;
    };
    const tagScripts = new Set();            // <script src>
    const dynScripts = new Set();            // 只在 performance 里（运行时动态加载）
    const addScript = (raw) => {
      const url = stripHash(raw);
      if (!url || skippable(url)) return;
      if (tagScripts.has(url)) return;
      dynScripts.add(url);
      addUrl(url, 'Script');
    };
    for (const s of page.scripts || []) {
      addUrl(s, 'Script');
      tagScripts.add(stripHash(s));
    }
    for (const e of page.resources || []) {
      const init = String(e.initiatorType || '').toLowerCase();
      if (SKIP_INITIATORS.has(init)) continue;
      if (init === 'script') addScript(e.url);
      else addUrl(e.url, '');
    }
    for (const l of page.links || []) addUrl(l.url, /stylesheet/i.test(l.rel || '') ? 'Stylesheet' : '');
    for (const m of page.media || []) addUrl(m, '');
    const scriptUrls = new Set([...tagScripts, ...dynScripts]);
    for (const r of state.records) {
      const type = String(r.type || '');
      const isScript = type === 'Script' || /javascript|ecmascript/i.test(r.mime || '');
      if (STATIC_RECORD_TYPES.has(type) || isScript) addUrl(r.url, isScript ? 'Script' : type);
      if (isScript) scriptUrls.add(stripHash(r.url));
    }
    for (const u of scriptUrls) addUrl(u, 'Script');

    /* ---- 2) 映射 + 字节（入口先占路径，其余按 URL 排序保证产出稳定） ---- */
    const used = new Map();                  // local → url（路径冲突检测）
    const missing = [];
    const jobs = [];
    const entryRec = pageUrl ? bodyRecord(pageUrl) : null;
    const entryLocal = pageUrl ? files.localPathOf(pageUrl, (entryRec && entryRec.mime) || 'text/html', true) : '';
    if (pageUrl) jobs.push({ url: pageUrl, local: entryLocal, mime: (entryRec && entryRec.mime) || 'text/html', type: (entryRec && entryRec.type) || 'Document', rec: entryRec, isEntry: true });
    for (const it of [...urls.values()].sort((a, b) => a.url.localeCompare(b.url))) {
      if (it.url === pageUrl) continue;
      const rec = bodyRecord(it.url);
      jobs.push({
        url: it.url,
        local: files.localPathOf(it.url, (rec && rec.mime) || '', false),
        mime: (rec && rec.mime) || '', type: it.type || (rec && rec.type) || '', rec,
      });
    }
    const fileMap = new Map();               // url → local（引用重写用，缺失的也保留映射）
    for (const job of jobs) {
      const owner = used.get(job.local);
      if (owner && owner !== job.url) { missing.push({ url: job.url, reason: '路径冲突' }); continue; }
      used.set(job.local, job.url);
      fileMap.set(job.url, job.local);
      if (!job.rec) { missing.push({ url: job.url, reason: '未抓到响应体' }); continue; }
      job.bytes = toBuffer(job.rec);
      job.rewrite = !!(job.isEntry || /css/i.test(job.mime) || job.type === 'Stylesheet');
    }

    /* ---- 3) 落盘：入口 HTML 与 CSS 先重写引用，逐文件容错 ---- */
    const dirOf = (local) => path.join(dir, ...String(local).split('/'));
    const written = [];
    const jsTexts = [];
    const scripts = [];
    for (const job of jobs) {
      if (!job.bytes) continue;
      try {
        const bytes = job.rewrite ? Buffer.from(rewriteRefs(job.bytes.toString('utf8'), job.url, fileMap, job.local), 'utf8') : job.bytes;
        const p = dirOf(job.local);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, bytes);
        written.push({ url: job.url, local: job.local, mime: job.mime, type: job.type || 'Other', size: bytes.length });
        if (scriptUrls.has(job.url)) {
          const kind = tagScripts.has(job.url) ? 'external' : dynScripts.has(job.url) ? 'dynamic' : 'external';
          scripts.push({ url: job.url, local: job.local, bytes: bytes.length, kind });
          jsTexts.push({ file: job.local, text: job.bytes.toString('utf8') });
        }
      } catch (e) {
        missing.push({ url: job.url, reason: `写入失败：${e.message}` });
      }
    }
    // 内联脚本副本：页面脚本原文 + 来源注释，一条一个文件
    let inlineN = 0;
    for (const s of page.inline || []) {
      const body = String(s == null ? '' : s);
      if (!body.trim()) continue;
      inlineN++;
      const local = `${INLINE_DIR}/${String(inlineN).padStart(3, '0')}.js`;
      const text = `// 页面内联脚本 #${inlineN}（来自 ${pageUrl}）\n${body}`;
      try {
        const p = dirOf(local);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, text, 'utf8');
        const size = Buffer.byteLength(text, 'utf8');
        written.push({ url: '', local, mime: 'application/javascript', type: 'Inline', size });
        scripts.push({ url: '', local, bytes: size, kind: 'inline' });
        jsTexts.push({ file: local, text });
      } catch (e) {
        missing.push({ url: `inline #${inlineN}`, reason: `写入失败：${e.message}` });
      }
    }

    /* ---- 4) 附带产物 ---- */
    const byKind = {};
    let bytes = 0;
    for (const f of written) {
      bytes += f.size;
      byKind[f.type] = (byKind[f.type] || 0) + 1;
    }
    const write = async (local, content) => {
      const p = dirOf(local);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content, 'utf8');
    };
    const network = includeNetwork ? networkSnapshot(pageUrl) : null;
    const hints = includeHints ? buildHints(state.records, jsTexts) : null;
    await write('manifest.json', JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      pageUrl, title, entry: entryLocal,
      counts: { files: written.length, bytes, byKind },
      files: written,
      missing,
      options: { includeNetwork, includeHints },
    }, null, 2));
    await write('js/index.json', JSON.stringify({ pageUrl, scripts }, null, 2));
    if (network) await write('network.json', JSON.stringify(network, null, 2));
    if (hints) await write('hints.json', JSON.stringify(hints, null, 2));

    return {
      ok: true, dir, entry: entryLocal,
      files: written.length, bytes, byKind, missing,
      network: network ? network.records.length : 0,
      hints: hints ? hints.keywords.length : 0,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { saveBundle, rewriteRefs, buildHints };
