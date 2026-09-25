# 节拍检测器

纯前端本地音频节拍检测工具：选择本地音频文件后检测 BPM，可视化波形与节拍点，支持播放/暂停、灵敏度调节和节拍时间点导出。所有处理均在本地完成，不上传任何数据。

## 功能

- 本地文件选择 / 拖拽上传（MP3 / WAV / OGG / FLAC / M4A）
- BPM 检测（能量通量 onset 检测 + 自相关 tempo 估计，含半速纠偏与抛物线插值）
- Canvas 波形渲染（min/max 分桶）+ 节拍点竖线 + 播放头，点击波形跳转
- 播放 / 暂停（Web Audio，记录偏移量实现暂停续播）
- 灵敏度滑块：实时调整峰值阈值，灵敏度越高节拍点越多（单调正相关）
- 无节拍音频（纯噪声、长音）自动提示
- 节拍时间点导出：TXT / CSV / JSON / 剪贴板

## 技术方案

- **Web Audio**：`decodeAudioData` 解码后，用 `OfflineAudioContext` 重采样到 22.05kHz 单声道，控制内存占用（100MB+ 文件可处理）
- **Web Worker**：`beatWorker.js` 在后台线程执行检测，主线程不卡；PCM 以 `Transferable` 传递零拷贝
- **Canvas**：波形层只画一次，节拍点/播放头画在叠加层，rAF 驱动
- **TypedArray**：全链路 `Float32Array`，onset 包络时间/强度数组传回主线程，灵敏度调节无需重跑 Worker

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 测试

```bash
python3 tools/gen_test_audio.py   # 生成测试音频（含 105MB 大文件）
node tools/test_detect.js         # 算法验证：BPM 准确性 / 无节拍提示 / 耗时 / 灵敏度单调性
node tools/test_app_dom.js        # UI 逻辑验证：播放暂停 / 导出 / 灵敏度 / 无节拍提示
```
