/* Node 测试：验证 beat-dsp.js 的核心验收标准 */
'use strict';
const BeatDSP = require('../js/beat-dsp.js');

const SR = 11025;
let failures = 0;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
}

/* 生成点击音轨：每拍一个短噪声脉冲 */
function makeClickTrack(bpm, seconds, noiseLevel) {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const interval = 60 / bpm;
  for (let t = 0; t < seconds; t += interval) {
    const start = Math.floor(t * SR);
    const len = Math.floor(0.02 * SR); // 20ms 脉冲
    for (let i = 0; i < len && start + i < n; i++) {
      out[start + i] = (Math.random() * 2 - 1) * Math.exp(-i / (0.003 * SR));
    }
  }
  if (noiseLevel > 0) {
    for (let i = 0; i < n; i++) out[i] += (Math.random() * 2 - 1) * noiseLevel;
  }
  return out;
}

/* ---------- 1. BPM 检测准确性（多个常见速度，要求精确无倍速误差） ---------- */
for (const bpm of [60, 80, 100, 120, 140, 174]) {
  const samples = makeClickTrack(bpm, 30, 0);
  const t0 = Date.now();
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm: detected, confidence } = BeatDSP.estimateTempo(envelope, fps);
  const ms = Date.now() - t0;
  const err = Math.abs(detected - bpm) / bpm;
  check(`BPM ${bpm} 检测`, confidence >= 0.2 && err < 0.03,
    `detected=${detected.toFixed(1)} conf=${confidence.toFixed(2)} ${ms}ms`);
}

/* ---------- 1b. 拟真音乐：底鼓四分 + 踩镲八分 + 噪声 ---------- */
{
  const bpm = 128, seconds = 30;
  const n = Math.floor(seconds * SR);
  const samples = new Float32Array(n);
  const beat = 60 / bpm;
  for (let t = 0; t < seconds; t += beat) { // 底鼓：每拍
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.1 * SR && s0 + i < n; i++) {
      samples[s0 + i] += Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / (0.02 * SR));
    }
  }
  for (let t = beat / 2; t < seconds; t += beat / 2) { // 踩镲：八分
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.03 * SR && s0 + i < n; i++) {
      samples[s0 + i] += (Math.random() * 2 - 1) * 0.4 * Math.exp(-i / (0.005 * SR));
    }
  }
  for (let i = 0; i < n; i++) samples[i] += (Math.random() * 2 - 1) * 0.02; // 底噪
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm: detected, confidence } = BeatDSP.estimateTempo(envelope, fps);
  const ratio = detected / bpm;
  check('拟真音乐 BPM 128', confidence >= 0.2 && [0.5, 1, 2].some(r => Math.abs(ratio - r) / r < 0.03),
    `detected=${detected.toFixed(1)} conf=${confidence.toFixed(2)}`);
}

/* ---------- 2. 噪声干扰下仍可检测 ---------- */
{
  const samples = makeClickTrack(120, 30, 0.15);
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm, confidence } = BeatDSP.estimateTempo(envelope, fps);
  const ratio = bpm / 120;
  check('噪声干扰下 BPM 120', confidence >= 0.2 && [0.5, 1, 2].some(r => Math.abs(ratio - r) / r < 0.03),
    `detected=${bpm.toFixed(1)} conf=${confidence.toFixed(2)}`);
}

/* ---------- 3. 无节拍音频（纯噪声）-> 低置信度 ---------- */
{
  const n = 20 * SR;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(noise, SR);
  const { confidence } = BeatDSP.estimateTempo(envelope, fps);
  check('纯噪声 -> 低置信度(触发提示)', confidence < 0.2, `conf=${confidence.toFixed(3)}`);
}

/* ---------- 4. 灵敏度与节拍点数量正相关 ---------- */
{
  const samples = makeClickTrack(120, 30, 0);
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm } = BeatDSP.estimateTempo(envelope, fps);
  const counts = [0.1, 0.5, 0.9].map(s => BeatDSP.pickBeats(envelope, fps, s, bpm).length);
  check('灵敏度↑ -> 节拍数↑', counts[0] <= counts[1] && counts[1] <= counts[2],
    `counts=${counts.join(',')}`);
}

/* ---------- 5. 节拍点时间准确（与点击位置对齐） ---------- */
{
  const bpm = 120, seconds = 20;
  const samples = makeClickTrack(bpm, seconds, 0);
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm: det } = BeatDSP.estimateTempo(envelope, fps);
  const beats = BeatDSP.pickBeats(envelope, fps, 0.5, det);
  let aligned = 0;
  for (const t of beats) {
    const phase = (t % 0.5) / 0.5; // 120bpm -> 0.5s 间隔
    if (Math.min(phase, 1 - phase) < 0.1) aligned++;
  }
  check('节拍点与真实节拍对齐', beats.length > 0 && aligned / beats.length > 0.9,
    `${aligned}/${beats.length}`);
}

/* ---------- 6. 性能：长音频（模拟 100MB 解码后长度）检测 < 5s ---------- */
{
  const seconds = 600; // 10 分钟 @11025Hz ≈ 100MB MP3 的典型解码量级
  const samples = makeClickTrack(128, seconds, 0.05);
  const t0 = Date.now();
  const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, SR);
  const { bpm, confidence } = BeatDSP.estimateTempo(envelope, fps);
  const beats = BeatDSP.pickBeats(envelope, fps, 0.5, bpm);
  const ms = Date.now() - t0;
  check('10 分钟音频检测 < 5s', ms < 5000, `${ms}ms bpm=${bpm.toFixed(1)} beats=${beats.length}`);
}

/* ---------- 7. 极低采样率输入不崩 ---------- */
{
  const lowSR = 4000;
  const n = 10 * lowSR;
  const samples = new Float32Array(n);
  const interval = 0.5; // 120bpm
  for (let t = 0; t < 10; t += interval) {
    const s = Math.floor(t * lowSR);
    for (let i = 0; i < 80 && s + i < n; i++) samples[s + i] = Math.exp(-i / 10);
  }
  let ok = true, bpm = 0;
  try {
    const { envelope, fps } = BeatDSP.computeOnsetEnvelope(samples, lowSR);
    bpm = BeatDSP.estimateTempo(envelope, fps).bpm;
  } catch (e) { ok = false; }
  check('低采样率(4kHz)不崩', ok && bpm > 0, `bpm=${bpm.toFixed(1)}`);
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
