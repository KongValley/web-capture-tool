'use strict';
/*
 * 落盘：保存对话框、文本写入、响应体批量导出、站点目录树路径（离线包与规则落盘共用）。
 * 所有文件写入都从这里走；重名不覆盖，自动加 -1/-2 后缀。
 */
const { app, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { state } = require('./state');

function sanitizeName(s, max = 120) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned.slice(0, max) || 'unnamed';
}

async function exists(p) {
  try { await fs.access(p); return true; } catch (e) { return false; }
}

async function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 1; i <= 999 && (await exists(p)); i++) p = path.join(dir, `${base}-${i}.${ext}`);
  if (await exists(p)) throw new Error('同名文件过多（已到 -999）');
  return p;
}

// 按「包内相对路径」落盘；同名时在扩展名前插 -1/-2（与 uniquePath 同一套语义）
async function uniquePathUnder(dir, local) {
  const parts = String(local).split('/');
  const name = parts.pop();
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let p = path.join(dir, ...parts, name);
  for (let i = 1; i <= 999 && (await exists(p)); i++) p = path.join(dir, ...parts, `${stem}-${i}${ext}`);
  if (await exists(p)) throw new Error('同名文件过多（已到 -999）');
  return p;
}

function mimeExt(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('css')) return 'css';
  if (m.includes('javascript') || m.includes('ecmascript')) return 'js';
  if (m.includes('svg')) return 'svg';
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'webp';
  if (m.includes('font') || m.includes('woff')) return 'woff2';
  if (m.includes('xml')) return 'xml';
  if (m.startsWith('text/')) return 'txt';
  return 'bin';
}

/* --------------------------------------- 站点目录树路径（离线包 / 规则落盘共用） */

const SITE_DIR = 'site';                       // 镜像站根目录

// URL → 包内相对路径：site/<host>/<路径段…>/<文件名>
// host 目录；路径段逐段 sanitize、丢弃空段与 ..；目录 URL 的末段用 index.<mimeExt>；
// 无扩展名补 mimeExt；查询串非空在扩展名前插 _q_<sha1 前 8 位>；入口页额外保证 .html
function localPathOf(url, mime, isEntry) {
  let u = null;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch (e) { /* 非标准 URL：按原串当路径 */ }
  const host = sanitizeName(u ? u.host : 'raw', 60);
  const rawPath = u ? u.pathname : String(url == null ? '' : url).split(/[?#]/)[0];
  const segs = rawPath.split('/').filter((s) => s && s !== '.' && s !== '..').map((s) => sanitizeName(s, 80));
  let name = segs.pop() || '';
  if (/\/$/.test(rawPath) || !name) {            // 目录（含根路径）：末段换成 index 文件
    if (name) segs.push(name);
    name = '';
  }
  let ext = '';
  if (name && /\.[a-z0-9]{1,10}$/i.test(name)) {
    const i = name.lastIndexOf('.');
    ext = name.slice(i);
    name = name.slice(0, i);
  }
  if (!name) name = 'index';
  if (!ext) ext = '.' + mimeExt(isEntry ? 'text/html' : mime);
  const query = u ? u.search.replace(/^\?/, '') : '';
  if (query) name += '_q_' + crypto.createHash('sha1').update(query).digest('hex').slice(0, 8);
  return [SITE_DIR, host].concat(segs, name + ext).join('/');
}

async function saveWithDialog(defaultName, content) {
  const r = await dialog.showSaveDialog(state.win, { defaultPath: path.join(app.getPath('downloads'), defaultName) });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  if (typeof content === 'string') await fs.writeFile(r.filePath, content, 'utf8');
  else await fs.writeFile(r.filePath, content);
  return { ok: true, file: r.filePath };
}

// file 参数用于自检旁路系统对话框；正常调用不传，走保存对话框。
async function saveTextFile({ defaultName, content, file } = {}) {
  if (file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String(content == null ? '' : content), 'utf8');
    return { ok: true, file };
  }
  return saveWithDialog(defaultName || 'export.txt', String(content == null ? '' : content));
}

// 与 saveTextFile 同形，但写 Buffer（截图 / PDF / base64 响应体）
async function saveBinaryFile({ defaultName, buffer, file } = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    return { ok: true, file };
  }
  return saveWithDialog(defaultName || 'export.bin', data);
}

// 选一个目录（批量存盘 / 落盘规则共用）
async function pickDirectory() {
  const r = await dialog.showOpenDialog(state.win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, dir: r.filePaths[0] };
}

async function saveBodies(dir) {
  let target = dir;
  if (!target) {
    const picked = await pickDirectory();
    if (!picked.ok) return picked;
    target = picked.dir;
  }
  await fs.mkdir(target, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (let i = 0; i < state.records.length; i++) {
    const rec = state.records[i];
    if (rec.body == null) { skipped++; continue; }
    let base;
    try {
      const u = new URL(rec.url);
      base = `${String(i + 1).padStart(3, '0')}_${rec.method}_${sanitizeName(u.host + u.pathname, 100)}`;
    } catch (e) {
      base = `${String(i + 1).padStart(3, '0')}_${rec.method}_${sanitizeName(rec.url, 100)}`;
    }
    const filePath = await uniquePath(target, base, mimeExt(rec.mime));
    const data = rec.bodyBase64 ? Buffer.from(rec.body, 'base64') : Buffer.from(rec.body, 'utf8');
    await fs.writeFile(filePath, data);
    written++;
  }
  return { ok: true, dir: target, written, skipped };
}

// 落盘规则命中时写一条响应体：按站点目录树镜像（site/<host>/<路径>），重名在扩展名前加 -1/-2
async function saveAutoBody(rec, dir) {
  const local = localPathOf(rec.url, rec.mime, false);
  const file = await uniquePathUnder(dir, local);
  const data = rec.bodyBase64 ? Buffer.from(rec.body, 'base64') : Buffer.from(String(rec.body), 'utf8');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return local;                                   // 包内相对路径：capture 用它写 note，界面能看到落点
}

// 站点前缀：只取主机名，非法字符换成 _，解析失败返回空串
function siteHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/[^a-z0-9.-]/gi, '_').replace(/^\.+|\.+$/g, '');
  } catch (e) { return ''; }
}

// 导出默认文件名：<主机名-><kind>-<ISO 时间戳，: 和 . 换成 ->
function exportBaseName(kind, url, at) {
  const stamp = new Date(at == null ? Date.now() : at).toISOString().replace(/[:.]/g, '-');
  const host = siteHost(url);
  return `${host ? `${host}-` : ''}${kind}-${stamp}`;
}

// 选一个 JSON 文件（设置导入用）
async function pickJsonFile() {
  const r = await dialog.showOpenDialog(state.win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, file: r.filePaths[0] };
}

module.exports = {
  sanitizeName, uniquePath, uniquePathUnder, mimeExt, localPathOf, saveWithDialog, saveTextFile, saveBinaryFile, saveBodies,
  pickDirectory, saveAutoBody,
  siteHost, exportBaseName, pickJsonFile,
};
