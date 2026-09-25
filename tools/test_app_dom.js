'use strict';
// 用 DOM/Web API 桩在 Node 中完整驱动 app.js，验证 UI 逻辑、播放/暂停、灵敏度、导出
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 22050;
function makeClickPcm(bpm, seconds) {
  const n = Math.floor(seconds * SR);
  const pcm = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < seconds; t += beat) {
    const idx = Math.floor(t * SR);
    for (let k = 0; k < 0.1 * SR && idx + k < n; k++) {
      pcm[idx + k] += 0.8 * Math.exp(-k / (0.02 * SR)) * Math.sin((2 * Math.PI * 150 * k) / SR);
    }
    for (let k = 0; k < 0.02 * SR && idx + k < n; k++) {
      pcm[idx + k] += 0.2 * Math.exp(-k / (0.005 * SR)) * (rand() * 2 - 1);
    }
  }
  return pcm;
}

let injectedPcm = null;
const downloads = [];
let clipboardText = '';
const rafQueue = [];

function makeCtx2d() {
  return new Proxy({}, { get: (t, p) => (p === 'canvas' ? {} : () => {}) });
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    hidden: false,
    textContent: '',
    value: '50',
    disabled: false,
    files: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) { force ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      event.preventDefault = event.preventDefault || (() => {});
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    click() { el.dispatch('click'); },
    getContext: () => makeCtx2d(),
    getBoundingClientRect: () => ({ width: 900, height: 220, left: 0, top: 0 }),
    parentElement: null,
    width: 0,
    height: 0,
  };
  el.parentElement = { getBoundingClientRect: () => ({ width: 900, height: 220 }) };
  return el;
}

const elIds = ['dropzone','fileInput','pickBtn','status','spinner','statusText','panel','infoName','infoSize',
  'infoDuration','infoBpm','infoBeats','infoTime','noBeatNotice','waveWrap','waveCanvas','overlayCanvas',
  'playBtn','timeLabel','sensitivity','sensValue','exportTxt','exportCsv','exportJson','copyBtn'];
const els = {};
for (const id of elIds) els[id] = makeEl(id);

class FakeAudioBuffer {
  constructor(opts) {
    this.numberOfChannels = opts.numberOfChannels;
    this.length = opts.length;
    this.sampleRate = opts.sampleRate;
    this.duration = opts.length / opts.sampleRate;
    this._data = [new Float32Array(opts.length)];
  }
  getChannelData() { return this._data[0]; }
  copyToChannel(src, ch) { this._data[ch].set(src); }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = 'running';
    this._startWall = Date.now();
    this._timer = setInterval(() => { this.currentTime += 0.05; }, 50);
    this._timer.unref();
  }
  resume() { return Promise.resolve(); }
  close() { clearInterval(this._timer); return Promise.resolve(); }
  decodeAudioData() {
    return Promise.resolve({
      duration: injectedPcm.length / SR,
      getChannelData: () => injectedPcm,
    });
  }
  createBufferSource() {
    const src = {
      buffer: null,
      onended: null,
      connect() {},
      start() { setTimeout(() => src.onended && src.onended(), 60000).unref?.(); },
      stop() {},
    };
    return src;
  }
  createBuffer(ch, len, rate) { return new FakeAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }); }
}

class FakeOfflineAudioContext {
  constructor(ch, len, rate) {
    this.length = len;
    this.sampleRate = rate;
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
  get destination() { return {}; }
  startRendering() {
    const buf = new FakeAudioBuffer({ numberOfChannels: 1, length: injectedPcm.length, sampleRate: SR });
    buf.copyToChannel(injectedPcm, 0);
    return Promise.resolve(buf);
  }
}

class FakeWorker {
  constructor(scriptPath) {
    const code = fs.readFileSync(path.join(__dirname, '..', scriptPath), 'utf8');
    const sandbox = { self: {}, performance, Float32Array, Math };
    sandbox.self.postMessage = (msg) => {
      setImmediate(() => this.onmessage && this.onmessage({ data: msg }));
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    this._sandbox = sandbox;
  }
  postMessage(data) { this._sandbox.self.onmessage({ data }); }
  terminate() {}
}

const sandbox = {
  console,
  performance,
  Float32Array,
  Math,
  JSON,
  Number,
  Infinity,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  setImmediate,
  Promise,
  Error,
  Worker: FakeWorker,
  AudioContext: FakeAudioContext,
  OfflineAudioContext: FakeOfflineAudioContext,
  AudioBuffer: FakeAudioBuffer,
  Blob: class {
    constructor(parts) { this.parts = parts; downloads.push(parts.join('')); }
  },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  navigator: { clipboard: { writeText: (t) => { clipboardText = t; return Promise.resolve(); } } },
  document: {
    getElementById: (id) => els[id],
    createElement: () => makeEl('dynamic'),
  },
  window: null,
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
};
sandbox.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  AudioContext: FakeAudioContext,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), sandbox);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}

async function waitDone() {
  for (let i = 0; i < 500; i++) {
    if (els.spinner.classList.contains('done')) return;
    await sleep(20);
  }
  throw new Error('等待处理完成超时');
}

async function main() {
  // 场景 1：120 BPM 节拍音频
  injectedPcm = makeClickPcm(120, 20);
  const file = { name: 'song.mp3', size: 100 * 1024 * 1024, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
  els.fileInput.files = [file];
  els.fileInput.dispatch('change');
  await waitDone();

  check('UI: 面板显示', els.panel.hidden === false);
  check('UI: BPM 显示正确', Math.abs(parseFloat(els.infoBpm.textContent) - 120) <= 4, `显示=${els.infoBpm.textContent}`);
  check('UI: 文件名/大小显示', els.infoName.textContent === 'song.mp3' && els.infoSize.textContent === '100.0 MB');
  check('UI: 检测耗时 < 5s', parseFloat(els.infoTime.textContent) < 5, els.infoTime.textContent);
  check('UI: 无节拍提示隐藏', els.noBeatNotice.hidden === true);
  const beatsAt50 = Number(els.infoBeats.textContent);
  check('UI: 节拍点数量合理', Math.abs(beatsAt50 - 40) <= 6, `beats=${beatsAt50}`);

  // 灵敏度单调性
  const counts = [];
  for (const s of [10, 30, 50, 70, 90]) {
    els.sensitivity.value = String(s);
    els.sensitivity.dispatch('input');
    counts.push(Number(els.infoBeats.textContent));
  }
  check('UI: 灵敏度与节拍数正相关', counts.every((c, i) => i === 0 || c >= counts[i - 1]), counts.join(' → '));
  check('UI: 灵敏度数值显示', els.sensValue.textContent === '90');

  // 播放 / 暂停
  els.playBtn.click();
  await sleep(300);
  check('UI: 播放状态', els.playBtn.textContent.includes('暂停'));
  els.playBtn.click();
  check('UI: 暂停状态', els.playBtn.textContent.includes('播放'));
  const offset = await vm.runInContext('state.startOffset', sandbox);
  check('UI: 暂停记录播放位置', offset > 0.1, `offset=${offset.toFixed(2)}s`);

  // 导出
  els.exportTxt.click();
  check('导出: TXT 含 BPM 与时间点', downloads[0].includes('# BPM: 119') && /\t\d+\.\d{3}\t/.test(downloads[0]));
  els.exportCsv.click();
  check('导出: CSV 格式正确', downloads[1].startsWith('index,time_seconds') && downloads[1].split('\n').length > 30);
  els.exportJson.click();
  const json = JSON.parse(downloads[2]);
  check('导出: JSON 含 bpm/beats', Math.abs(json.bpm - 120) <= 4 && json.beats.length === json.beatCount);
  els.copyBtn.click();
  await sleep(50);
  check('导出: 复制到剪贴板', clipboardText.split('\n').length > 30, `${clipboardText.split('\n').length} 行`);

  // 场景 2：无节拍音频（纯噪声）
  injectedPcm = new Float32Array(SR * 8);
  let seed = 1;
  for (let i = 0; i < injectedPcm.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    injectedPcm[i] = (seed / 0x7fffffff) * 0.6 - 0.3;
  }
  els.fileInput.files = [{ name: 'noise.wav', size: 1000, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }];
  els.fileInput.dispatch('change');
  await waitDone();
  check('UI: 无节拍提示显示', els.noBeatNotice.hidden === false);
  check('UI: 无节拍时 BPM 为 —', els.infoBpm.textContent === '—');
  check('UI: 无节拍时节拍数为 0', els.infoBeats.textContent === '0');

  console.log(failures === 0 ? '\nDOM 测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试运行失败:', e); process.exit(2); });
