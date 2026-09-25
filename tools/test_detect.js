'use strict';
// 在 Node 中加载 beatWorker.js 的算法并验证：BPM 准确性、无节拍提示、检测耗时、灵敏度单调性
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorker() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'beatWorker.js'), 'utf8');
  const sandbox = {
    self: {},
    performance,
    Float32Array,
    Math,
    postMessage: null,
  };
  sandbox.self.postMessage = (msg) => { sandbox.__result = msg; };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  let offset = 12;
  let dataOffset = 44;
  let dataSize = buf.length - 44;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
    offset += 8 + size;
  }
  const frames = Math.floor(dataSize / (bitsPerSample / 8) / numChannels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    pcm[i] = buf.readInt16LE(dataOffset + i * numChannels * 2) / 32768;
  }
  return { pcm, sampleRate };
}

// 简易降采样到 22050（模拟 OfflineAudioContext 的效果，取平均）
function downsample(pcm, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += pcm[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function detect(pcm, sampleRate) {
  const sandbox = loadWorker();
  const t0 = performance.now();
  sandbox.self.onmessage({ data: { pcm, sampleRate } });
  const ms = performance.now() - t0;
  return { ...sandbox.__result, totalMs: ms };
}

// 与 app.js 相同的峰值挑选逻辑
function pickBeats(times, strengths, bpm, noBeat, sensitivity) {
  if (noBeat) return [];
  let max = 0, sum = 0;
  for (let i = 0; i < strengths.length; i++) { if (strengths[i] > max) max = strengths[i]; sum += strengths[i]; }
  const mean = sum / strengths.length;
  const threshold = mean + (max - mean) * (1 - 0.92 * (sensitivity / 100));
  const refractory = bpm > 0 ? Math.max(0.08, (60 / bpm) * 0.35) : 0.1;
  const beats = [];
  let last = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const s = strengths[i];
    if (s < threshold) continue;
    let ok = true;
    for (let j = Math.max(0, i - 2); j <= Math.min(strengths.length - 1, i + 2); j++) {
      if (strengths[j] > s) { ok = false; break; }
    }
    if (!ok || times[i] - last < refractory) continue;
    beats.push(times[i]);
    last = times[i];
  }
  return beats;
}

const dir = path.join(__dirname, 'samples');
const TARGET = 22050;
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}

function run(file, expect) {
  const { pcm, sampleRate } = readWav(path.join(dir, file));
  const mono = downsample(pcm, sampleRate, TARGET);
  const r = detect(mono, TARGET);
  console.log(`\n== ${file} ==  bpm=${r.bpm} noBeat=${r.noBeat} confidence=${r.confidence.toFixed(2)} detect=${(r.totalMs / 1000).toFixed(2)}s`);
  if (expect.bpm) {
    check('BPM 合理', Math.abs(r.bpm - expect.bpm) <= expect.bpm * 0.03, `期望 ${expect.bpm}±3%，实际 ${r.bpm}`);
    check('未误报无节拍', !r.noBeat);
  }
  if (expect.noBeat) check('无节拍提示', r.noBeat === true);
  if (expect.maxSeconds) check('检测耗时', r.totalMs / 1000 < expect.maxSeconds, `${(r.totalMs / 1000).toFixed(2)}s < ${expect.maxSeconds}s`);

  if (!r.noBeat) {
    const counts = [10, 30, 50, 70, 90].map((s) => pickBeats(r.times, r.strengths, r.bpm, r.noBeat, s).length);
    check('灵敏度与节拍数正相关', counts.every((c, i) => i === 0 || c >= counts[i - 1]), `灵敏度 10→90: ${counts.join(' → ')}`);
    if (expect.beatCount) {
      const beats = pickBeats(r.times, r.strengths, r.bpm, r.noBeat, 50);
      check('节拍点数量合理', Math.abs(beats.length - expect.beatCount) <= expect.beatCount * 0.1, `期望≈${expect.beatCount}，实际 ${beats.length}`);
    }
  }
  return r;
}

run('beat_120bpm.wav', { bpm: 120, beatCount: 40, maxSeconds: 5 });
run('beat_120bpm_noisy.wav', { bpm: 120, maxSeconds: 5 });
run('noise.wav', { noBeat: true, maxSeconds: 5 });
run('sine_drone.wav', { noBeat: true, maxSeconds: 5 });
if (fs.existsSync(path.join(dir, 'big_beat_96bpm.wav'))) {
  run('big_beat_96bpm.wav', { bpm: 96, maxSeconds: 5 });
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
