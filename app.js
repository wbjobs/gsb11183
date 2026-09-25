'use strict';

const TARGET_SAMPLE_RATE = 22050;

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  pickBtn: document.getElementById('pickBtn'),
  status: document.getElementById('status'),
  spinner: document.getElementById('spinner'),
  statusText: document.getElementById('statusText'),
  panel: document.getElementById('panel'),
  infoName: document.getElementById('infoName'),
  infoSize: document.getElementById('infoSize'),
  infoDuration: document.getElementById('infoDuration'),
  infoBpm: document.getElementById('infoBpm'),
  infoBeats: document.getElementById('infoBeats'),
  infoTime: document.getElementById('infoTime'),
  noBeatNotice: document.getElementById('noBeatNotice'),
  waveWrap: document.getElementById('waveWrap'),
  waveCanvas: document.getElementById('waveCanvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  playBtn: document.getElementById('playBtn'),
  timeLabel: document.getElementById('timeLabel'),
  sensitivity: document.getElementById('sensitivity'),
  sensValue: document.getElementById('sensValue'),
  exportTxt: document.getElementById('exportTxt'),
  exportCsv: document.getElementById('exportCsv'),
  exportJson: document.getElementById('exportJson'),
  copyBtn: document.getElementById('copyBtn'),
};

const state = {
  audioCtx: null,
  playBuffer: null,
  pcm: null,
  sampleRate: TARGET_SAMPLE_RATE,
  duration: 0,
  onsetTimes: null,
  onsetStrengths: null,
  bpm: 0,
  noBeat: false,
  beats: [],
  playing: false,
  source: null,
  startedAt: 0,
  startOffset: 0,
  rafId: 0,
};

function setStatus(text, done) {
  els.status.hidden = false;
  els.statusText.textContent = text;
  els.spinner.classList.toggle('done', !!done);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function formatSize(bytes) {
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(1) + ' KB';
  return bytes + ' B';
}

async function decodeToMono(arrayBuffer) {
  const decodeCtx = new AudioContext();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }
  const duration = decoded.duration;
  const length = Math.max(1, Math.ceil(duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  decoded = null;
  return { pcm: rendered.getChannelData(0), duration };
}

function runDetection(pcm, sampleRate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('beatWorker.js');
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('检测超时'));
    }, 30000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(err);
    };
    const copy = pcm.slice();
    worker.postMessage({ pcm: copy, sampleRate }, [copy.buffer]);
  });
}

function pickBeats(sensitivity) {
  const times = state.onsetTimes;
  const strengths = state.onsetStrengths;
  if (!times || state.noBeat) {
    state.beats = [];
    return;
  }
  let max = 0;
  let sum = 0;
  for (let i = 0; i < strengths.length; i++) {
    if (strengths[i] > max) max = strengths[i];
    sum += strengths[i];
  }
  const mean = sum / strengths.length;
  const ratio = 1 - 0.92 * (sensitivity / 100);
  const threshold = mean + (max - mean) * ratio;

  const beatInterval = state.bpm > 0 ? 60 / state.bpm : 0;
  const refractory = beatInterval > 0 ? Math.max(0.08, beatInterval * 0.35) : 0.1;
  const windowFrames = 2;

  const beats = [];
  let lastTime = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const s = strengths[i];
    if (s < threshold) continue;
    const lo = Math.max(0, i - windowFrames);
    const hi = Math.min(strengths.length - 1, i + windowFrames);
    let isLocalMax = true;
    for (let j = lo; j <= hi; j++) {
      if (strengths[j] > s) { isLocalMax = false; break; }
    }
    if (!isLocalMax) continue;
    if (times[i] - lastTime < refractory) continue;
    beats.push(times[i]);
    lastTime = times[i];
  }
  state.beats = beats;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawWaveform() {
  const { ctx, w, h } = setupCanvas(els.waveCanvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a2338';
  ctx.fillRect(0, 0, w, h);
  const pcm = state.pcm;
  if (!pcm || pcm.length === 0) return;
  const buckets = Math.max(1, Math.floor(w));
  const perBucket = pcm.length / buckets;
  const mid = h / 2;
  ctx.fillStyle = '#4f8cff';
  for (let x = 0; x < buckets; x++) {
    const start = Math.floor(x * perBucket);
    const end = Math.min(pcm.length, Math.max(start + 1, Math.floor((x + 1) * perBucket)));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = pcm[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid - max * mid * 0.92;
    const y2 = mid - min * mid * 0.92;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

function drawOverlay(playheadSec) {
  const { ctx, w, h } = setupCanvas(els.overlayCanvas);
  ctx.clearRect(0, 0, w, h);
  if (state.duration <= 0) return;
  ctx.fillStyle = 'rgba(255, 180, 84, .85)';
  for (const t of state.beats) {
    const x = (t / state.duration) * w;
    ctx.fillRect(x - 0.5, 0, 1.5, h);
  }
  if (playheadSec != null) {
    const x = (playheadSec / state.duration) * w;
    ctx.fillStyle = '#ff5c7a';
    ctx.fillRect(x - 1, 0, 2, h);
  }
}

function currentPlayhead() {
  if (!state.playing) return state.startOffset;
  return Math.min(state.duration, state.startOffset + (state.audioCtx.currentTime - state.startedAt));
}

function tick() {
  const t = currentPlayhead();
  drawOverlay(t);
  els.timeLabel.textContent = `${formatTime(t)} / ${formatTime(state.duration)}`;
  if (state.playing && t >= state.duration) {
    stopPlayback();
    state.startOffset = 0;
  }
  state.rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (state.source) {
    try { state.source.onended = null; state.source.stop(); } catch (e) { /* already stopped */ }
    state.source = null;
  }
  state.playing = false;
  els.playBtn.textContent = '▶ 播放';
}

function play() {
  if (!state.playBuffer) return;
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  state.audioCtx.resume();
  const offset = state.startOffset >= state.duration ? 0 : state.startOffset;
  const source = state.audioCtx.createBufferSource();
  source.buffer = state.playBuffer;
  source.connect(state.audioCtx.destination);
  source.start(0, offset);
  source.onended = () => {
    if (state.playing && currentPlayhead() >= state.duration - 0.05) {
      stopPlayback();
      state.startOffset = 0;
    }
  };
  state.source = source;
  state.startedAt = state.audioCtx.currentTime;
  state.startOffset = offset;
  state.playing = true;
  els.playBtn.textContent = '⏸ 暂停';
}

function pause() {
  state.startOffset = currentPlayhead();
  stopPlayback();
}

function refreshBeats() {
  pickBeats(Number(els.sensitivity.value));
  els.infoBeats.textContent = state.noBeat ? '0' : String(state.beats.length);
}

async function handleFile(file) {
  try {
    stopPlayback();
    state.startOffset = 0;
    state.beats = [];
    state.onsetTimes = null;
    els.panel.hidden = true;
    els.playBtn.disabled = true;
    setStatus(`读取文件 ${file.name}（${formatSize(file.size)}）…`);

    const arrayBuffer = await file.arrayBuffer();
    setStatus('解码音频并降采样到 22.05kHz 单声道…');
    const { pcm, duration } = await decodeToMono(arrayBuffer);

    state.pcm = pcm;
    state.duration = duration;

    setStatus('检测节拍中（Web Worker 后台运行）…');
    const detectStart = performance.now();
    const result = await runDetection(pcm, TARGET_SAMPLE_RATE);
    const totalMs = performance.now() - detectStart;

    state.bpm = result.bpm;
    state.noBeat = result.noBeat;
    state.onsetTimes = result.times;
    state.onsetStrengths = result.strengths;

    state.playBuffer = new AudioBuffer({
      numberOfChannels: 1,
      length: pcm.length,
      sampleRate: TARGET_SAMPLE_RATE,
    });
    state.playBuffer.copyToChannel(pcm, 0);

    els.infoName.textContent = file.name;
    els.infoSize.textContent = formatSize(file.size);
    els.infoDuration.textContent = formatTime(duration);
    els.infoBpm.textContent = result.noBeat ? '—' : String(result.bpm);
    els.infoTime.textContent = (totalMs / 1000).toFixed(2) + ' s';
    els.noBeatNotice.hidden = !result.noBeat;
    els.panel.hidden = false;
    els.playBtn.disabled = false;

    refreshBeats();
    drawWaveform();
    drawOverlay(0);
    els.timeLabel.textContent = `00:00.0 / ${formatTime(duration)}`;
    setStatus(`完成：${result.noBeat ? '未检测到明显节拍' : `BPM ≈ ${result.bpm}`}，耗时 ${(totalMs / 1000).toFixed(2)}s`, true);
  } catch (err) {
    console.error(err);
    setStatus(`处理失败：${err.message || err}`, true);
  }
}

function buildExportRows() {
  return state.beats.map((t, i) => ({ index: i + 1, seconds: Number(t.toFixed(3)) }));
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBaseName() {
  const name = els.infoName.textContent || 'audio';
  return name.replace(/\.[^.]+$/, '') || 'audio';
}

els.pickBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});
els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('dragover');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

els.playBtn.addEventListener('click', () => {
  if (state.playing) pause();
  else play();
});

els.sensitivity.addEventListener('input', () => {
  els.sensValue.textContent = els.sensitivity.value;
  refreshBeats();
});

els.waveWrap.addEventListener('click', (e) => {
  if (!state.playBuffer || state.duration <= 0) return;
  const rect = els.waveWrap.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const wasPlaying = state.playing;
  if (wasPlaying) stopPlayback();
  state.startOffset = ratio * state.duration;
  if (wasPlaying) play();
});

els.exportTxt.addEventListener('click', () => {
  const rows = buildExportRows();
  const lines = [`# BPM: ${state.bpm || 'N/A'}`, '# index\ttime_seconds\ttime_mmss'];
  for (const r of rows) lines.push(`${r.index}\t${r.seconds.toFixed(3)}\t${formatTime(r.seconds)}`);
  download(`${exportBaseName()}_beats.txt`, lines.join('\n'), 'text/plain');
});
els.exportCsv.addEventListener('click', () => {
  const rows = buildExportRows();
  const lines = ['index,time_seconds'];
  for (const r of rows) lines.push(`${r.index},${r.seconds.toFixed(3)}`);
  download(`${exportBaseName()}_beats.csv`, lines.join('\n'), 'text/csv');
});
els.exportJson.addEventListener('click', () => {
  const payload = { bpm: state.bpm || null, beatCount: state.beats.length, beats: buildExportRows() };
  download(`${exportBaseName()}_beats.json`, JSON.stringify(payload, null, 2), 'application/json');
});
els.copyBtn.addEventListener('click', async () => {
  const text = buildExportRows().map((r) => r.seconds.toFixed(3)).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    els.copyBtn.textContent = '已复制 ✓';
    setTimeout(() => { els.copyBtn.textContent = '复制到剪贴板'; }, 1500);
  } catch (e) {
    setStatus('复制失败，请使用导出按钮', true);
  }
});

window.addEventListener('resize', () => {
  if (!state.pcm) return;
  drawWaveform();
});

state.rafId = requestAnimationFrame(tick);
