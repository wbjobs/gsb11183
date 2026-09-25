"""生成验收测试用音频：
- beat_120bpm.wav  : 120 BPM 节拍声（底鼓+噪声 hi-hat），用于验证 BPM 与节拍点
- noise.wav        : 纯白噪声，用于验证"无节拍"提示
- sine_drone.wav   : 440Hz 长音，无节拍
- big_beat.wav     : 约 100MB 的 96 BPM 长音频，用于验证大文件不崩、检测 < 5s
"""
import math
import struct
import wave
import random
import os

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(OUT, exist_ok=True)


def write_wav(name, samples, sr=SR):
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples)
        w.writeframes(frames)
    print(f"{name}: {os.path.getsize(path)/1e6:.1f} MB, {len(samples)/sr:.1f}s")


def click_track(bpm, seconds, sr=SR, noise=0.0):
    n = int(seconds * sr)
    out = [0.0] * n
    beat = 60.0 / bpm
    t = 0.0
    rng = random.Random(42)
    while t < seconds:
        idx = int(t * sr)
        # 底鼓：150Hz 指数衰减正弦
        for k in range(int(0.12 * sr)):
            if idx + k < n:
                env = math.exp(-k / (0.02 * sr))
                out[idx + k] += 0.8 * env * math.sin(2 * math.pi * 150 * k / sr)
        # hi-hat：短噪声
        for k in range(int(0.03 * sr)):
            if idx + k < n:
                env = math.exp(-k / (0.005 * sr))
                out[idx + k] += 0.3 * env * (rng.random() * 2 - 1)
        t += beat
    if noise > 0:
        for i in range(n):
            out[i] += noise * (rng.random() * 2 - 1)
    return out


def pure_noise(seconds, sr=SR):
    rng = random.Random(7)
    return [(rng.random() * 2 - 1) * 0.5 for _ in range(int(seconds * sr))]


def sine_drone(seconds, sr=SR):
    n = int(seconds * sr)
    return [0.5 * math.sin(2 * math.pi * 440 * i / sr) for i in range(n)]


if __name__ == "__main__":
    write_wav("beat_120bpm.wav", click_track(120, 20))
    write_wav("beat_120bpm_noisy.wav", click_track(120, 20, noise=0.15))
    write_wav("noise.wav", pure_noise(10))
    write_wav("sine_drone.wav", sine_drone(10))
    # 大文件：44.1kHz 16bit 单声道约 5.3MB/min，20 分钟约 105MB
    write_wav("big_beat_96bpm.wav", click_track(96, 20 * 60))
