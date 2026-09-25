/*
 * beat-worker.js — 在后台线程执行重计算（频谱包络 + BPM），
 * 输入/输出均通过 Transferable ArrayBuffer，主线程零拷贝、不卡顿。
 */
importScripts('beat-dsp.js');

self.onmessage = function (e) {
  var data = e.data;
  if (data.type !== 'analyze') return;

  var samples = new Float32Array(data.buffer);
  var sampleRate = data.sampleRate;

  try {
    self.postMessage({ type: 'progress', phase: '计算频谱包络', ratio: 0 });
    var envResult = BeatDSP.computeOnsetEnvelope(samples, sampleRate, function (r) {
      self.postMessage({ type: 'progress', phase: '计算频谱包络', ratio: r * 0.8 });
    });

    self.postMessage({ type: 'progress', phase: '估算 BPM', ratio: 0.85 });
    var tempo = BeatDSP.estimateTempo(envResult.envelope, envResult.fps);

    self.postMessage({ type: 'progress', phase: '完成', ratio: 1 });
    self.postMessage(
      {
        type: 'result',
        bpm: tempo.bpm,
        confidence: tempo.confidence,
        fps: envResult.fps,
        envelope: envResult.envelope.buffer
      },
      [envResult.envelope.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
