'use strict';
/*
 * 落盘：保存对话框、文本写入、响应体批量导出。
 * 所有文件写入都从这里走；重名不覆盖，自动加 -1/-2 后缀。
 */
const { app, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
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

// 落盘规则命中时写一条响应体：平铺到目标目录，文件名 = 序号_方法_主机+路径，重名加 -1/-2 后缀
async function saveAutoBody(rec, dir) {
  let hostPath = rec.url;
  try { const u = new URL(rec.url); hostPath = u.host + u.pathname; } catch (e) { /* 非标准 URL 用原串 */ }
  const base = `${String(rec.id).padStart(4, '0')}_${rec.method}_${sanitizeName(hostPath, 80)}`;
  const file = await uniquePath(dir, base, mimeExt(rec.mime));
  const data = rec.bodyBase64 ? Buffer.from(rec.body, 'base64') : Buffer.from(String(rec.body), 'utf8');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return path.basename(file);
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
  sanitizeName, uniquePath, mimeExt, saveWithDialog, saveTextFile, saveBinaryFile, saveBodies,
  pickDirectory, saveAutoBody,
  siteHost, exportBaseName, pickJsonFile,
};
