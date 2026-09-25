/*
 * main.js — UI、解码、播放、波形/节拍点渲染、导出。
 * 重计算全部在 beat-worker.js 中完成；主线程只做轻量峰值拾取与绘制。
 */
(function () {
  'use strict';

  var ANALYSIS_SAMPLE_RATE = 11025; // 低分析采样率：省内存、解码快，对节拍检测足够

  var fileInput = document.getElementById('fileInput');
  var dropZone = document.getElementById('dropZone');
  var statusEl = document.getElementById('status');
  var progressBar = document.getElementById('progressBar');
  var progressWrap = document.getElementById('progressWrap');
  var bpmValueEl = document.getElementById('bpmValue');
  var beatCountEl = document.getElementById('beatCount');
  var noBeatHintEl = document.getElementById('noBeatHint');
  var playBtn = document.getElementById('playBtn');
  var timeLabel = document.getElementById('timeLabel');
  var sensitivityInput = document.getElementById('sensitivity');
  var sensitivityLabel = document.getElementById('sensitivityLabel');
  var exportBtn = document.getElementById('exportBtn');
  var canvas = document.getElementById('waveCanvas');

  var state = {
    fileName: '',
    decodeCtx: null,
    playCtx: null,
    monoSamples: null,   // Float32Array @ ANALYSIS_SAMPLE_RATE，用于波形与播放
    sampleRate: ANALYSIS_SAMPLE_RATE,
    duration: 0,
    playBuffer: null,
    source: null,
    playing: false,
    startedAt: 0,
    offset: 0,
    envelope: null,      // Float32Array
    fps: 0,
    bpm: 0,
    confidence: 0,
    beats: new Float32Array(0),
    worker: null,
    rafId: 0
  };

  /* ---------- 状态提示 ---------- */
  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }
  function setProgress(ratio) {
    progressWrap.style.display = ratio == null ? 'none' : 'block';
    if (ratio != null) progressBar.style.width = Math.round(ratio * 100) + '%';
  }

  /* ---------- 文件加载与解码 ---------- */
  function handleFile(file) {
    if (!file) return;
    resetState();
    state.fileName = file.name;
    setStatus('读取文件：' + file.name + '（' + (file.size / 1048576).toFixed(1) + ' MB）…');
    setProgress(0.05);

    file.arrayBuffer().then(function (buf) {
      setStatus('解码音频…');
      setProgress(0.2);
      // 用低采样率上下文解码：100MB 文件解码后内存降低约 4 倍，避免崩溃
      try {
        state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: ANALYSIS_SAMPLE_RATE
        });
      } catch (err) {
        state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      return state.decodeCtx.decodeAudioData(buf);
    }).then(function (audioBuffer) {
      setStatus('混合为单声道…');
      setProgress(0.4);
      state.sampleRate = audioBuffer.sampleRate;
      state.duration = audioBuffer.duration;
      state.monoSamples = downmixToMono(audioBuffer);
      if (state.decodeCtx) state.decodeCtx.close();
      state.decodeCtx = null;
      startAnalysis();
    }).catch(function (err) {
      setStatus('无法解码该音频文件：' + (err && err.message || err), true);
      setProgress(null);
    });
  }

  function downmixToMono(buffer) {
    var len = buffer.length;
    var out = new Float32Array(len);
    var channels = buffer.numberOfChannels;
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += data[i];
    }
    if (channels > 1) {
      var inv = 1 / channels;
      for (var j = 0; j < len; j++) out[j] *= inv;
    }
    return out;
  }

  /* ---------- Worker 分析 ---------- */
  function startAnalysis() {
    setStatus('检测节拍中（后台线程）…');

    if (state.worker) state.worker.terminate();
    state.worker = new Worker('js/beat-worker.js');

    // 拷贝一份转移到 Worker，主线程保留 monoSamples 用于波形与播放
    var copy = state.monoSamples.slice();
    state.worker.postMessage(
      { type: 'analyze', buffer: copy.buffer, sampleRate: state.sampleRate },
      [copy.buffer]
    );

    state.worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        setProgress(0.4 + msg.ratio * 0.6);
        setStatus('检测节拍中：' + msg.phase + '…');
      } else if (msg.type === 'result') {
        setProgress(null);
        state.envelope = new Float32Array(msg.envelope);
        state.fps = msg.fps;
        state.bpm = msg.bpm;
        state.confidence = msg.confidence;
        onAnalysisDone();
      } else if (msg.type === 'error') {
        setProgress(null);
        setStatus('节拍检测失败：' + msg.message, true);
      }
    };
    state.worker.onerror = function (err) {
      setProgress(null);
      setStatus('节拍检测失败：' + err.message, true);
    };
  }

  function onAnalysisDone() {
    var hasBeat = state.confidence >= 0.2 && state.bpm > 0;
    bpmValueEl.textContent = hasBeat ? state.bpm.toFixed(1) : '—';
    noBeatHintEl.style.display = hasBeat ? 'none' : 'block';

    updateBeats();
    buildPlayBuffer();
    playBtn.disabled = false;
    exportBtn.disabled = state.beats.length === 0;
    setStatus('就绪：' + state.fileName + '（时长 ' + formatTime(state.duration) + '）');
    draw();
  }

  /* ---------- 灵敏度 -> 峰值拾取（主线程轻量计算） ---------- */
  function updateBeats() {
    if (!state.envelope) return;
    var s = Number(sensitivityInput.value) / 100;
    state.beats = BeatDSP.pickBeats(state.envelope, state.fps, s, state.bpm);
    beatCountEl.textContent = String(state.beats.length);
    exportBtn.disabled = state.beats.length === 0;
  }

  /* ---------- 播放 / 暂停 ---------- */
  function buildPlayBuffer() {
    if (!state.playCtx) {
      state.playCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    var buf = state.playCtx.createBuffer(1, state.monoSamples.length, state.sampleRate);
    buf.copyToChannel(state.monoSamples, 0);
    state.playBuffer = buf;
  }

  function play() {
    if (!state.playBuffer || state.playing) return;
    if (state.offset >= state.duration) state.offset = 0;
    state.playCtx.resume();
    var src = state.playCtx.createBufferSource();
    src.buffer = state.playBuffer;
    src.connect(state.playCtx.destination);
    src.start(0, state.offset);
    state.startedAt = state.playCtx.currentTime;
    state.source = src;
    state.playing = true;
    playBtn.textContent = '暂停';
    src.onended = function () {
      if (state.playing) { // 播放到结尾自然结束
        state.playing = false;
        state.offset = 0;
        playBtn.textContent = '播放';
      }
    };
    tick();
  }

  function pause() {
    if (!state.playing) return;
    state.offset += state.playCtx.currentTime - state.startedAt;
    state.offset = Math.min(state.offset, state.duration);
    state.source.onended = null;
    state.source.stop();
    state.source = null;
    state.playing = false;
    playBtn.textContent = '播放';
    cancelAnimationFrame(state.rafId);
    draw();
  }

  function currentTime() {
    if (!state.playing) return state.offset;
    return Math.min(state.offset + state.playCtx.currentTime - state.startedAt, state.duration);
  }

  playBtn.addEventListener('click', function () {
    if (state.playing) pause(); else play();
  });

  function tick() {
    timeLabel.textContent = formatTime(currentTime()) + ' / ' + formatTime(state.duration);
    draw();
    if (state.playing) state.rafId = requestAnimationFrame(tick);
  }

  /* ---------- Canvas 波形 + 节拍点 ---------- */
  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.monoSamples) return;

    // 波形（min/max 峰值列）
    var samples = state.monoSamples;
    var mid = h / 2;
    ctx.fillStyle = '#4a90d9';
    for (var x = 0; x < w; x++) {
      var start = Math.floor((x / w) * samples.length);
      var end = Math.max(start + 1, Math.floor(((x + 1) / w) * samples.length));
      var min = 1, max = -1;
      for (var i = start; i < end; i++) {
        var v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      var y1 = mid - max * mid * 0.9;
      var y2 = mid - min * mid * 0.9;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // 节拍点
    ctx.strokeStyle = '#ff8c42';
    ctx.lineWidth = 1;
    for (var b = 0; b < state.beats.length; b++) {
      var bx = (state.beats[b] / state.duration) * w;
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, h);
      ctx.stroke();
    }

    // 播放头
    var px = (currentTime() / state.duration) * w;
    ctx.strokeStyle = '#e33';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  canvas.addEventListener('click', function (e) {
    if (!state.playBuffer) return;
    var rect = canvas.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    var wasPlaying = state.playing;
    if (wasPlaying) pause();
    state.offset = ratio * state.duration;
    timeLabel.textContent = formatTime(state.offset) + ' / ' + formatTime(state.duration);
    draw();
    if (wasPlaying) play();
  });

  window.addEventListener('resize', draw);

  /* ---------- 灵敏度 ---------- */
  sensitivityInput.addEventListener('input', function () {
    sensitivityLabel.textContent = sensitivityInput.value;
    updateBeats();
    draw();
  });

  /* ---------- 导出 ---------- */
  exportBtn.addEventListener('click', function () {
    if (state.beats.length === 0) return;
    var lines = [
      '# file: ' + state.fileName,
      '# bpm: ' + (state.bpm > 0 ? state.bpm.toFixed(2) : 'n/a'),
      'index,time_seconds'
    ];
    for (var i = 0; i < state.beats.length; i++) {
      lines.push((i + 1) + ',' + state.beats[i].toFixed(3));
    }
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName.replace(/\.[^.]+$/, '') + '_beats.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------- 文件输入 / 拖拽 ---------- */
  fileInput.addEventListener('change', function () {
    handleFile(fileInput.files[0]);
  });
  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  /* ---------- 工具 ---------- */
  function formatTime(sec) {
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function resetState() {
    pause();
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    state.monoSamples = null;
    state.envelope = null;
    state.beats = new Float32Array(0);
    state.bpm = 0;
    state.confidence = 0;
    state.offset = 0;
    state.playBuffer = null;
    bpmValueEl.textContent = '—';
    beatCountEl.textContent = '0';
    noBeatHintEl.style.display = 'none';
    playBtn.disabled = true;
    exportBtn.disabled = true;
    playBtn.textContent = '播放';
    timeLabel.textContent = '0:00 / 0:00';
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
})();
