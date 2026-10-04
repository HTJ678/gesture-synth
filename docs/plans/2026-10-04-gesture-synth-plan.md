# Gesture Synth v1 实现计划

> 设计依据：`docs/plans/2026-10-04-gesture-synth-design.md`（已获批准）

**Goal:** 一个纯静态单页网页：摄像头认出手部关键点，手指数量映射到五声音阶，手的位置控制八度与音量。

**Architecture:** MediaPipe Tasks Vision 在浏览器里出 21 个手部关键点 → 纯函数层 `logic.mjs` 做判定/映射/平滑 → Web Audio 振荡器出声。无构建步骤。

**Tech Stack:** 原生 ESM、Web Audio API、`@mediapipe/tasks-vision@1.0.1`（jsDelivr）、Node 内置测试运行器。

---

## Task 1：纯逻辑层

**Files:**
- Create: `src/logic.mjs`
- Test: `tests/logic.test.mjs`

**Step 1** 写测试：音高换算（A4=440、C4≈261.63）、数手指（0/1/4/5 指、忽略拇指、脏输入不抛错）、音阶映射（0 指=静音、1–5 指=0–4 级、八度偏移）、三区八度、音量钳位、EMA、去抖器时序。

**Step 2** 跑测试看它失败：

```bash
node --test tests/logic.test.mjs
```
Expected: FAIL（模块不存在）

**Step 3** 实现 `logic.mjs`：`PENTATONIC`、`ROOT_MIDI`、`midiToFreq/Name`、`countExtendedFingers`、`fingersToDegree/Midi/Freq`、`octaveFromY`、`volumeFromX`、`ema`、`Stabilizer`。

**Step 4** 再跑：

```bash
node --test tests/logic.test.mjs
```
Expected: 13 pass / 0 fail

**Step 5** 提交（等 git 可用后统一处理）。

## Task 2：声音层

**Files:**
- Modify: `src/app.js` 的 `createVoice()`

**Step 1** 先手动验证目标行为：点"开始"后应有持续静音输出，切音无"咔"声。因为依赖真浏览器 + 音频设备，**不做自动化测试**，改为浏览器人工验证（见 Task 5）。

**Step 2** 实现：triangle 主振 + sine 低八度 + lowpass，`gain` 初始 0；`setNote(midi, gain)` 用 `setTargetAtTime` 做 12ms 频率斜坡 + 40ms 增益斜坡；`midi === null` 时增益归零。

**Step 3** 人工验证：静音时无底噪；换音听不到 click。

## Task 3：摄像头 + 模型

**Files:**
- Create: `index.html`、`src/app.js`

**Step 1** 实现自检三灯（音频 / 模型 / 摄像头），任一失败给出可读原因。

**Step 2** 模型加载：`FilesetResolver.forVisionTasks(jsDelivr wasm)` + `HandLandmarker.createFromOptions({ baseOptions: { modelAssetPath: './models/hand_landmarker.task' }, runningMode: 'VIDEO', numHands: 1 })`。

**Step 3** 摄像头：`getUserMedia` → `video` → 等 `readyState >= 2` → 对齐 canvas 尺寸。

**Step 4** 主循环：`detectForVideo(video, performance.now())`，取 `landmarks[0]`，走映射，更新 HUD，`requestAnimationFrame` 续帧。单帧异常不得终止循环。

## Task 4：界面与可视化

**Files:**
- Modify: `index.html`（布局 + 内联 CSS）、`src/app.js`（`drawHand`）

**Step 1** 镜像容器 `transform: scaleX(-1)` 包住 video + canvas，骨架用原始坐标画即可对齐。

**Step 2** HUD 显示：音名、手指数、八度、音量、fps。

**Step 3** 控件：开始按钮、"含拇指"开关、"显示骨架"开关。

## Task 5：验证

**Step 1** 单元测试：

```bash
npm test
```
Expected: 13 pass

**Step 2** 起本地服务器：

```bash
npx --yes serve .
```

**Step 3** 浏览器人工验收清单（必须真摄像头）：
- [ ] 三灯全绿
- [ ] 伸 1–5 指，音名分别是 C4 D4 E4 G4 A4
- [ ] 握拳静音
- [ ] 手抬高 → 变 C5 一档；压低 → C3 一档
- [ ] 手左右移动，音量条跟着变
- [ ] 快速抖动手，音不跳（去抖生效）
- [ ] 关掉"含拇指"后，只有 4 个音

## Task 6：发布到 GitHub（待定）

⚠️ 本机 **没有 git、没有 gh**。三条路，需要小侯选：
1. 装 Git + GitHub CLI（`winget install Git.Git; winget install GitHub.cli`），然后 `gh repo create` + push；
2. 不装工具，用 GitHub 网页版"上传文件"（不支持文件夹多级，稍麻烦）；
3. 用 GitHub REST API + Personal Access Token 直接建仓库并上传文件（我可以脚本化）。

选定后再开 Pages：Settings → Pages → Source = `main` / root。
