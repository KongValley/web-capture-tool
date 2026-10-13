'use strict';
/*
 * GPU 状态判定。
 * 只依赖 electron 的 app，纯判定逻辑单独暴露，便于自检直接断言。
 *
 * 注意：核显（Intel HD/UHD、AMD APU Vega）是支持 D3D11 的真 GPU，正常走硬件加速。
 * 判定只看 Chromium 上报的实际状态，不做「是否独显」「显卡型号」之类的判断。
 */
const { app } = require('electron');

const SOFTWARE_RE = /software|disabled|unavailable/i;

function statusLooksSoftware(status) {
  if (!status || typeof status !== 'object') return false;
  return SOFTWARE_RE.test(String(status.gpu_compositing || ''));
}

function currentStatus() {
  try { return app.getGPUFeatureStatus(); } catch (e) { return null; }
}

function describe() {
  const status = currentStatus();
  return {
    status,
    gpuCompositing: status ? String(status.gpu_compositing || '') : '',
    looksSoftware: statusLooksSoftware(status),
  };
}

module.exports = { statusLooksSoftware, currentStatus, describe, SOFTWARE_RE };
