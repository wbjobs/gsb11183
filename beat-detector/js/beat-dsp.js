/*
 * beat-dsp.js — 纯 DSP 函数库（无 DOM / Worker 依赖）
 * 同时被 Web Worker (importScripts) 和 Node 测试 (require) 使用。
 * 全部基于 TypedArray，避免主线程无关的分配。
 */
(function (global) {
  'use strict';

  var FRAME_SIZE = 512;   // 分析帧长（采样点）
  var HOP_SIZE = 256;     // 帧移 -> 包络帧率 fps = sampleRate / HOP_SIZE
  var MIN_BPM = 40;
  var MAX_BPM = 240;

  /* ---------- FFT（迭代基-2，查找表缓存） ---------- */
  var fftCache = {};

  function getFFT(size) {
    if (fftCache[size]) return fftCache[size];

    var levels = Math.round(Math.log(size) / Math.LN2);
    if ((1 << levels) !== size) throw new Error('FFT size must be power of 2');

    var cosTable = new Float32Array(size / 2 + 1);
    var sinTable = new Float32Array(size / 2 + 1);
    for (var i = 0; i <= size / 2; i++) {
      cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    var rev = new Uint32Array(size);
    for (i = 0; i < size; i++) {
      var r = 0;
      for (var b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
      rev[i] = r;
    }

    var fft = function (re, im) {
      var n = re.length;
      var halfSize, phaseStepRe, phaseStepIm, currentRe, currentIm;
      var k, j, i2, off, tRe, tIm, eRe, eIm;
      for (i2 = 0; i2 < n; i2++) {
        j = rev[i2];
        if (j > i2) {
          tRe = re[i2]; re[i2] = re[j]; re[j] = tRe;
          tIm = im[i2]; im[i2] = im[j]; im[j] = tIm;
        }
      }
      halfSize = 1;
      while (halfSize < n) {
        var stepIdx = size / (2 * halfSize);
        phaseStepRe = cosTable[stepIdx];
        phaseStepIm = -sinTable[stepIdx];
        currentRe = 1;
        currentIm = 0;
        for (k = 0; k < halfSize; k++) {
          for (off = k; off < n; off += halfSize * 2) {
            j = off + halfSize;
            tRe = re[j] * currentRe - im[j] * currentIm;
            tIm = re[j] * currentIm + im[j] * currentRe;
            eRe = re[off]; eIm = im[off];
            re[off] = eRe + tRe; im[off] = eIm + tIm;
            re[j] = eRe - tRe;   im[j] = eIm - tIm;
          }
          tRe = currentRe * phaseStepRe - currentIm * phaseStepIm;
          currentIm = currentRe * phaseStepIm + currentIm * phaseStepRe;
          currentRe = tRe;
        }
        halfSize *= 2;
      }
    };

    fftCache[size] = fft;
    return fft;
  }

  /* ---------- 起始包络：对数谱通量 (spectral flux) ---------- */
  function computeOnsetEnvelope(samples, sampleRate, onProgress) {
    var frameSize = FRAME_SIZE;
    var hop = HOP_SIZE;
    var fps = sampleRate / hop;
    var numFrames = samples.length > frameSize
      ? Math.floor((samples.length - frameSize) / hop) + 1
      : 0;
    var envelope = new Float32Array(numFrames);
    if (numFrames === 0) return { envelope: envelope, fps: fps };

    var fft = getFFT(frameSize);
    var hann = new Float32Array(frameSize);
    for (var i = 0; i < frameSize; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
    }

    var re = new Float32Array(frameSize);
    var im = new Float32Array(frameSize);
    var prevMag = new Float32Array(frameSize / 2);
    var halfBins = frameSize / 2;

    for (var f = 0; f < numFrames; f++) {
      var offset = f * hop;
      for (i = 0; i < frameSize; i++) {
        re[i] = samples[offset + i] * hann[i];
        im[i] = 0;
      }
      fft(re, im);

      var flux = 0;
      for (var bin = 0; bin < halfBins; bin++) {
        var mag = Math.log1p(100 * Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]));
        var diff = mag - prevMag[bin];
        if (diff > 0) flux += diff;
        prevMag[bin] = mag;
      }
      envelope[f] = flux;

      if (onProgress && (f & 4095) === 0) onProgress(f / numFrames);
    }

    // 自适应白化：减去滑动均值并除以滑动标准差（约 1s 窗），
    // 抑制平稳噪声底及其波动，突出局部瞬态
    var win = Math.max(1, Math.round(fps));
    var prefix = new Float64Array(numFrames + 1);
    var prefix2 = new Float64Array(numFrames + 1);
    for (i = 0; i < numFrames; i++) {
      prefix[i + 1] = prefix[i] + envelope[i];
      prefix2[i + 1] = prefix2[i] + envelope[i] * envelope[i];
    }
    for (i = 0; i < numFrames; i++) {
      var a = i - win > 0 ? i - win : 0;
      var b = i + win < numFrames ? i + win : numFrames;
      var cnt = b - a;
      var localMean = (prefix[b] - prefix[a]) / cnt;
      var localSq = (prefix2[b] - prefix2[a]) / cnt;
      var localStd = Math.sqrt(Math.max(0, localSq - localMean * localMean));
      var v = (envelope[i] - localMean) / (localStd + 1e-6);
      // 峰值强调：平方抑制噪声底的小波动，突出真实瞬态
      envelope[i] = v > 0 ? v * v : 0;
    }

    return { envelope: envelope, fps: fps };
  }

  /* ---------- BPM 估计：包络自相关 + 轻微速度先验 ---------- */
  function estimateTempo(envelope, fps) {
    var n = envelope.length;
    if (n < fps * 4) return { bpm: 0, confidence: 0 };

    var mean = 0, i;
    for (i = 0; i < n; i++) mean += envelope[i];
    mean /= n;

    // 轻度平滑（[1,2,1]/4 两次，σ≈1 帧）：降低帧量化抖动对自相关的干扰
    var x = new Float32Array(n);
    for (i = 0; i < n; i++) x[i] = envelope[i] - mean;
    var tmp = new Float32Array(n);
    var pass, prev, cur, next;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < n; i++) {
        prev = i > 0 ? x[i - 1] : x[i];
        next = i < n - 1 ? x[i + 1] : x[i];
        tmp[i] = (prev + 2 * x[i] + next) * 0.25;
      }
      var swap = x; x = tmp; tmp = swap;
    }

    var energy = 0;
    for (i = 0; i < n; i++) energy += x[i] * x[i];
    if (energy < 1e-9) return { bpm: 0, confidence: 0 };
    var norm = energy / n;

    var minLag = Math.max(2, Math.round((fps * 60) / MAX_BPM));
    var maxLag = Math.min(n >> 1, Math.round((fps * 60) / MIN_BPM));
    if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

    // 先算所有整数 lag 的归一化自相关
    var corrs = new Float32Array(maxLag + 1);
    for (var lag = minLag; lag <= maxLag; lag++) {
      var sum = 0;
      for (i = 0; i + lag < n; i++) sum += x[i] * x[i + lag];
      corrs[lag] = sum / (n - lag) / norm; // 归一化到 [-1, 1]
    }

    // 分数 lag 自相关（线性插值）：消除帧量化导致的基频相关损失
    function corrAt(fracLag) {
      var k = Math.floor(fracLag);
      var f = fracLag - k;
      var sum = 0, cnt = 0;
      for (var i2 = 0; i2 + k + 1 < n; i2++) {
        sum += x[i2] * (x[i2 + k] * (1 - f) + x[i2 + k + 1] * f);
        cnt++;
      }
      return cnt > 0 ? sum / cnt / norm : 0;
    }

    // 取整数 lag 局部极大值作为候选（最多 6 个）
    var candidates = [];
    for (lag = minLag + 1; lag < maxLag; lag++) {
      if (corrs[lag] >= corrs[lag - 1] && corrs[lag] >= corrs[lag + 1] && corrs[lag] > 0) {
        candidates.push(lag);
      }
    }
    candidates.sort(function (a, b) { return corrs[b] - corrs[a]; });
    if (candidates.length > 6) candidates.length = 6;
    if (candidates.length === 0) return { bpm: 0, confidence: 0 };

    // 候选逐一做分数 lag 精化（±1 帧，步长 0.1）
    var refinedLags = [], refinedCorrs = [];
    for (var c = 0; c < candidates.length; c++) {
      var base = candidates[c];
      var bestFl = base, bestRc = -Infinity;
      for (var fl = base - 1; fl <= base + 1.001; fl += 0.1) {
        if (fl < minLag || fl > maxLag) continue;
        var rc = corrAt(fl);
        if (rc > bestRc) {
          bestRc = rc;
          bestFl = fl;
        }
      }
      refinedLags.push(bestFl);
      refinedCorrs.push(bestRc);
    }

    function tempoPrior(bpm) {
      // 非对称对数高斯先验（中心 120BPM）：慢速侧衰减更快，
      // 符合真实音乐速度分布，用于倍速/半速仲裁
      var d = Math.log2(bpm / 120);
      var sigma = d < 0 ? 1.0 : 2.0;
      return Math.exp(-0.5 * Math.pow(d / sigma, 2));
    }

    // 谐波聚类：lag 成 2/3/4 整数倍关系（容差 3%）的候选归为一簇。
    // 帧量化会让谐波 lag 的相关性虚高于基频，因此簇内不用相关性、
    // 而用速度先验选出代表 BPM。
    var numC = refinedLags.length;
    var parent = [];
    for (var pi = 0; pi < numC; pi++) parent[pi] = pi;
    function findRoot(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    for (var ca = 0; ca < numC; ca++) {
      for (var cb = ca + 1; cb < numC; cb++) {
        var hi = Math.max(refinedLags[ca], refinedLags[cb]);
        var lo = Math.min(refinedLags[ca], refinedLags[cb]);
        var ratio = hi / lo;
        var nearest = Math.round(ratio);
        if (nearest >= 2 && nearest <= 4 && Math.abs(ratio - nearest) / nearest < 0.03) {
          parent[findRoot(ca)] = findRoot(cb);
        }
      }
    }

    var bestBpm = 0, bestScore = -Infinity, bestConf = 0;
    var seen = {};
    for (var ci = 0; ci < numC; ci++) {
      var root = findRoot(ci);
      if (seen[root]) continue;
      seen[root] = true;
      // 收集簇成员
      var clusterCorr = 0, repBpm = 0, repPrior = -Infinity;
      for (var cj = 0; cj < numC; cj++) {
        if (findRoot(cj) !== root) continue;
        if (refinedCorrs[cj] > clusterCorr) clusterCorr = refinedCorrs[cj];
        var bpmJ = (60 * fps) / refinedLags[cj];
        var wJ = tempoPrior(bpmJ);
        if (wJ > repPrior) {
          repPrior = wJ;
          repBpm = bpmJ;
        }
      }
      var score = clusterCorr * (0.7 + 0.3 * repPrior);
      if (score > bestScore) {
        bestScore = score;
        bestBpm = repBpm;
        bestConf = clusterCorr;
      }
    }

    var bpmOut = bestBpm;
    var bestRaw = bestConf;
    var confidence = bestRaw > 0 ? (bestRaw > 1 ? 1 : bestRaw) : 0;
    return { bpm: bpmOut, confidence: confidence };
  }

  /* ---------- 峰值拾取：灵敏度越高 -> 阈值越低 -> 节拍点越多 ---------- */
  function pickBeats(envelope, fps, sensitivity, bpm) {
    var n = envelope.length;
    if (n < 3) return new Float32Array(0);

    var mean = 0, i;
    for (i = 0; i < n; i++) mean += envelope[i];
    mean /= n;
    var variance = 0;
    for (i = 0; i < n; i++) {
      var d = envelope[i] - mean;
      variance += d * d;
    }
    var std = Math.sqrt(variance / n);
    if (std < 1e-9) return new Float32Array(0); // 包络平坦：无节拍

    var s = sensitivity < 0 ? 0 : sensitivity > 1 ? 1 : sensitivity;
    var k = 2.6 - 2.4 * s; // s=0 -> 2.6（少）, s=1 -> 0.2（多）
    var threshold = mean + k * std;

    var minInterval = 0.12;
    if (bpm > 0) minInterval = Math.max(0.08, (60 / bpm) * 0.45);

    var times = [];
    var lastFrame = -1e9;
    for (i = 1; i < n - 1; i++) {
      var v = envelope[i];
      if (v >= threshold && v >= envelope[i - 1] && v >= envelope[i + 1]) {
        if ((i - lastFrame) / fps >= minInterval) {
          times.push(i / fps);
          lastFrame = i;
        }
      }
    }
    return Float32Array.from(times);
  }

  var BeatDSP = {
    FRAME_SIZE: FRAME_SIZE,
    HOP_SIZE: HOP_SIZE,
    MIN_BPM: MIN_BPM,
    MAX_BPM: MAX_BPM,
    computeOnsetEnvelope: computeOnsetEnvelope,
    estimateTempo: estimateTempo,
    pickBeats: pickBeats
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BeatDSP;
  else global.BeatDSP = BeatDSP;
})(typeof self !== 'undefined' ? self : globalThis);
