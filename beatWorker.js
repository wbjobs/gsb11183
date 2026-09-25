'use strict';

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

function buildOnsetEnvelope(pcm) {
  const numFrames = Math.max(0, Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const energies = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SIZE;
    let sum = 0;
    for (let j = 0; j < FRAME_SIZE; j++) {
      const s = pcm[start + j];
      sum += s * s;
    }
    energies[i] = Math.log1p(sum / FRAME_SIZE * 1e6);
  }
  const envelope = new Float32Array(numFrames);
  for (let i = 1; i < numFrames; i++) {
    const diff = energies[i] - energies[i - 1];
    envelope[i] = diff > 0 ? diff : 0;
  }
  let energyMean = 0;
  for (let i = 0; i < numFrames; i++) energyMean += energies[i];
  energyMean = numFrames > 0 ? energyMean / numFrames : 0;
  return { envelope, energyMean };
}

function estimateBpm(envelope, fps) {
  const n = envelope.length;
  const lagMin = Math.max(1, Math.floor(fps * 60 / MAX_BPM));
  const lagMax = Math.min(n - 1, Math.ceil(fps * 60 / MIN_BPM));
  if (lagMax <= lagMin) return { bpm: 0, confidence: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += envelope[i];
  mean /= n;
  const centered = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    centered[i] = envelope[i] - mean;
    energy += centered[i] * centered[i];
  }
  if (energy < 1e-9) return { bpm: 0, confidence: 0 };
  const variance = energy / n;

  const normCorrs = new Float32Array(lagMax + 1);
  let bestCorr = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let corr = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) corr += centered[i] * centered[i + lag];
    normCorrs[lag] = corr / limit / variance;
    if (normCorrs[lag] > bestCorr) bestCorr = normCorrs[lag];
  }
  const confidence = bestCorr;
  if (bestCorr <= 0) return { bpm: 0, confidence: 0 };

  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (normCorrs[lag] === bestCorr) {
      bestLag = lag;
      break;
    }
  }

  const halfLag = bestLag / 2;
  if (halfLag >= lagMin) {
    let halfBest = 0;
    let halfBestLag = 0;
    const lo = Math.max(lagMin, Math.floor(halfLag) - 1);
    const hi = Math.min(lagMax, Math.ceil(halfLag) + 1);
    for (let lag = lo; lag <= hi; lag++) {
      if (normCorrs[lag] > halfBest) {
        halfBest = normCorrs[lag];
        halfBestLag = lag;
      }
    }
    if (halfBest >= bestCorr * 0.45) bestLag = halfBestLag;
  }

  let refinedLag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = normCorrs[bestLag - 1];
    const y1 = normCorrs[bestLag];
    const y2 = normCorrs[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) {
      const delta = 0.5 * (y0 - y2) / denom;
      if (Math.abs(delta) <= 1) refinedLag = bestLag + delta;
    }
  }
  const bpm = 60 * fps / refinedLag;
  return { bpm, confidence };
}

function analyzeEnvelope(envelope) {
  let max = 0;
  let sum = 0;
  const sorted = new Float32Array(envelope);
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > max) max = envelope[i];
    sum += envelope[i];
    sorted[i] = envelope[i];
  }
  sorted.sort();
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const mean = envelope.length > 0 ? sum / envelope.length : 0;
  return { max, mean, median };
}

self.onmessage = (event) => {
  const { pcm, sampleRate } = event.data;
  const started = performance.now();

  const fps = sampleRate / HOP_SIZE;
  const { envelope, energyMean } = buildOnsetEnvelope(pcm);
  const stats = analyzeEnvelope(envelope);
  const { bpm, confidence } = estimateBpm(envelope, fps);

  const onsetRatio = energyMean > 1e-6 ? stats.max / energyMean : 0;
  const noBeat = bpm === 0 || confidence < 0.15 || onsetRatio < 0.03 || stats.max < 1e-4;

  const count = envelope.length;
  const times = new Float32Array(count);
  const strengths = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    times[i] = i / fps;
    strengths[i] = envelope[i];
  }

  const elapsedMs = performance.now() - started;
  self.postMessage(
    {
      type: 'result',
      bpm: noBeat ? 0 : Math.round(bpm * 10) / 10,
      rawBpm: bpm,
      confidence,
      onsetRatio,
      noBeat,
      elapsedMs,
      times,
      strengths,
    },
    [times.buffer, strengths.buffer]
  );
};
