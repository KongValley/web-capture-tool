'use strict';
/*
 * 生成程序图标（零依赖）：build/icon.ico（7 个尺寸）+ build/icon-128.ico（≤128 回退件）。
 *
 * 图形规范（改图标就改这里）：
 *   - 底板：圆角方块，内缩 0.02，圆角半径 0.22，竖直渐变 #4C8DFF → #2B5BD7
 *   - 放大镜镜圈：圆心 (0.42, 0.40)，外半径 0.21，内半径 0.135，白色
 *   - 镜柄：胶囊 (0.565,0.545) → (0.76,0.74)，半径 0.055，白色
 * ICO 用 BMP 条目（不用 PNG 压缩），保证 rcedit / Win7 都能解析。
 * 纯函数式：无随机、无时间依赖，同一输入逐字节一致。
 */
const fs = require('node:fs');
const path = require('node:path');

const SIZE_ALL = [16, 24, 32, 48, 64, 128, 256];
const SIZE_128 = [16, 24, 32, 48, 64, 128];
const SS = 4;                       // 每轴 4 个子采样 → 每像素 16 个

const BODY_INSET = 0.02;
const BODY_RADIUS = 0.22;
const TOP = [0x4c, 0x8d, 0xff];     // #4C8DFF
const BOTTOM = [0x2b, 0x5b, 0xd7];  // #2B5BD7
const WHITE = [0xff, 0xff, 0xff];

const LENS = { x: 0.42, y: 0.40, rOut: 0.21, rIn: 0.135 };
const HANDLE = { x1: 0.565, y1: 0.545, x2: 0.76, y2: 0.74, r: 0.055 };

function inSquircle(u, v) {
  const h = 0.5 - BODY_INSET;
  const r = BODY_RADIUS;
  const dx = Math.abs(u - 0.5);
  const dy = Math.abs(v - 0.5);
  if (dx > h || dy > h) return false;
  if (dx <= h - r || dy <= h - r) return true;
  const cx = dx - (h - r);
  const cy = dy - (h - r);
  return cx * cx + cy * cy <= r * r;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (x1 + t * vx);
  const dy = py - (y1 + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function inWhite(u, v) {
  const dl = Math.hypot(u - LENS.x, v - LENS.y);
  if (dl <= LENS.rOut && dl >= LENS.rIn) return true;
  return distToSegment(u, v, HANDLE.x1, HANDLE.y1, HANDLE.x2, HANDLE.y2) <= HANDLE.r;
}

// 返回 S×S 的 RGBA（自上而下）像素
function renderRGBA(S) {
  const out = Buffer.alloc(S * S * 4);
  const samples = SS * SS;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let body = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / S;
          const v = (y + (sy + 0.5) / SS) / S;
          if (!inSquircle(u, v)) continue;
          body++;
          if (inWhite(u, v)) white++;
        }
      }
      const i = (y * S + x) * 4;
      if (!body) continue;                       // 底板外：全透明
      const t = S > 1 ? y / (S - 1) : 0;
      const w = white / body;                    // 白色占「底板内」的比例
      for (let c = 0; c < 3; c++) {
        const base = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
        out[i + c] = Math.round(base + (WHITE[c] - base) * w);
      }
      out[i + 3] = Math.round((body / samples) * 255);
    }
  }
  return out;
}

function bmpEntry(S, rgba) {
  const maskRow = Math.ceil(S / 32) * 4;
  const maskBytes = maskRow * S;
  const buf = Buffer.alloc(40 + S * S * 4 + maskBytes);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(S, 4);
  buf.writeInt32LE(S * 2, 8);          // BMP 高度含掩码，故为 2 倍
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);            // BI_RGB
  buf.writeUInt32LE(S * S * 4 + maskBytes, 20);
  let off = 40;
  for (let y = S - 1; y >= 0; y--) {    // 自下而上
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      buf[off++] = rgba[i + 2];         // B
      buf[off++] = rgba[i + 1];         // G
      buf[off++] = rgba[i];             // R
      buf[off++] = rgba[i + 3];         // A
    }
  }
  return buf;                            // 掩码区已是 0
}

function buildIco(sizes) {
  const images = sizes.map((S) => bmpEntry(S, renderRGBA(S)));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((S, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(S >= 256 ? 0 : S, e);
    header.writeUInt8(S >= 256 ? 0 : S, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

// 回读自检：头字段、条目数、尺寸、偏移都不越界
function inspect(buf, expectSizes) {
  const errs = [];
  if (buf.readUInt16LE(0) !== 0) errs.push('reserved 非 0');
  if (buf.readUInt16LE(2) !== 1) errs.push('type 非 1');
  const count = buf.readUInt16LE(4);
  if (count !== expectSizes.length) errs.push(`条目数 ${count} != ${expectSizes.length}`);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = buf.readUInt8(e) || 256;
    const h = buf.readUInt8(e + 1) || 256;
    const bits = buf.readUInt16LE(e + 6);
    const size = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (w !== expectSizes[i] || h !== expectSizes[i]) errs.push(`第 ${i} 项尺寸 ${w}x${h} != ${expectSizes[i]}`);
    if (bits !== 32) errs.push(`第 ${i} 项位深 ${bits} != 32`);
    if (off + size > buf.length) errs.push(`第 ${i} 项越界 ${off}+${size} > ${buf.length}`);
  }
  return errs;
}

function write(name, sizes) {
  const dir = path.join(__dirname, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const buf = buildIco(sizes);
  fs.writeFileSync(file, buf);
  const errs = inspect(fs.readFileSync(file), sizes);
  if (errs.length) {
    console.error(`自检失败 ${name}：${errs.join('；')}`);
    process.exit(1);
  }
  console.log(`已写入 build/${name}（${sizes.length} 个尺寸，${buf.length} 字节）`);
}

write('icon.ico', SIZE_ALL);
write('icon-128.ico', SIZE_128);

module.exports = { buildIco, renderRGBA, inspect, SIZE_ALL };
