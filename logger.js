'use strict';
/*
 * 诊断日志：<userData>/logs/app.log
 * 只依赖 electron 的 app 与 node 内置模块。
 * appendFileSync 保证崩溃路径也能落盘；任何异常都吞掉——日志失败不能反过来影响主流程。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TAIL_LINES = 2000;

let overrideFile = null;
let file = null;

function filePath() {
  return file || overrideFile || path.join(app.getPath('userData'), 'logs', 'app.log');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

// 自检用：改道到临时路径并清空目录（必须在首次 log 之前调用）
function useFile(p) {
  overrideFile = p;
  file = p;
  try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch (e) { /* 删不掉就按现状追加 */ }
  return p;
}

// 超过上限就滚成 app.log.1（只保留一代）
function rotate(p) {
  try {
    if (fs.statSync(p).size <= MAX_BYTES) return;
    try { fs.rmSync(`${p}.1`, { force: true }); } catch (e) { /* 没有旧文件 */ }
    fs.renameSync(p, `${p}.1`);
  } catch (e) { /* 文件不存在等，忽略 */ }
}

function log(kind, message, extra) {
  const line = `${new Date().toISOString()} [${kind}] ${message}${extra ? ' ' + safeJson(extra) : ''}`;
  console.log(line);
  try {
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotate(p);
    fs.appendFileSync(p, line + '\n');
  } catch (e) { /* 日志失败不能反过来影响主流程 */ }
}

// 读文件尾 n 行（可带子串过滤）；文件不存在返回空串
function tail(n = 200, filter = '') {
  try {
    let lines = fs.readFileSync(filePath(), 'utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (filter) lines = lines.filter((l) => l.includes(filter));
    return lines.slice(-Math.min(n, MAX_TAIL_LINES)).join('\n');
  } catch (e) {
    return '';
  }
}

module.exports = { MAX_BYTES, filePath, useFile, log, tail, safeJson };
