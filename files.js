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

async function saveBodies(dir) {
  let target = dir;
  if (!target) {
    const r = await dialog.showOpenDialog(state.win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    target = r.filePaths[0];
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

module.exports = { sanitizeName, uniquePath, mimeExt, saveWithDialog, saveTextFile, saveBinaryFile, saveBodies };
