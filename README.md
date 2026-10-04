# Gesture Synth 🎹🖐️

用摄像头当乐器：**伸出几根手指，就弹出五声音阶的第几个音**。

单页网页，纯浏览器运行 —— 没有服务器、没有构建步骤、没有安装包。MediaPipe 负责"看懂手"，Web Audio 负责出声。

> 直接双击 `index.html` **打不开摄像头**（浏览器的安全策略）。必须用 `localhost` 或 HTTPS 打开，见下面。

## 版本

- **v0.1.0 · 七声音阶版**（2026-10-04）—— 一根手指 = 一个音，两只手合起来覆盖整个七声音阶；可选调（C–B）；附带一个和弦模式（食指 I · 中指 IV · 无名指 V · 小指 vi · 拇指 ii）
- **v0.2（计划）** —— 和弦版：一个手势 = 一个具体的和弦（C / G / Am / F …）

---

## 玩法

| 你的动作 | 发生什么 |
| --- | --- |
| 伸出 1 / 2 / 3 / 4 / 5 根手指 | 五声音阶的 do re mi so la（C D E G A） |
| 握拳（0 根） | **静音** |
| 手抬高 | 升八度 |
| 手放低 | 降八度 |
| 手往右移 | 音量变大 |
| 手往左移 | 音量变小 |

手掌正对摄像头、手指朝上最稳。弱光下识别会飘，开个灯。

> 这套是**大调五声音阶**（do re mi so la = C D E G A），**没有 fa 和 si**。少这两个音，正是"随便伸都不难听"的原因。页面左侧有对应的贴纸说明，弹到哪个音哪一行会亮。

---

## 本地跑起来

需要先在项目目录下起一个静态服务器（任选一种，都不需要联网装东西）：

```bash
# 方式一（推荐，零依赖，已自带）
node dev-server.mjs            # -> http://localhost:8123

# 方式二
python -m http.server 8000     # -> http://localhost:8000

# 方式三
npx --yes serve .              # -> 终端会打出地址
```

然后把地址粘进浏览器，点 **开始 🎹**，允许摄像头权限。

页面上有三个自检灯：**音频引擎 / 手部模型 / 摄像头**。哪个红就是哪一步的问题，不用猜。

---

## 它是怎么工作的

```
摄像头帧  →  MediaPipe HandLandmarker  →  21 个手部关键点
          →  src/logic.mjs（纯函数：数手指 / 算音高 / 平滑）
          →  Web Audio 振荡器 → 声音
```

- **MediaPipe Tasks Vision 1.0.1**（jsDelivr CDN，含 wasm）
- 模型文件 `models/hand_landmarker.task` 已随仓库带上，离线也能跑（wasm/JS 仍需 CDN）
- **src/logic.mjs** 不碰 DOM、不碰音频，所以能用 `node --test` 直接测

抗抖动做了两层：关键点数值用**滑动平均**，手指数量用**去抖器**（连续稳定 140ms 才换音），换音时 12ms 的极短斜坡防止"咔哒"声。

---

## 文件

```
index.html              界面（内联 CSS，无依赖）
dev-server.mjs          零依赖静态服务器（只为满足摄像头要求）
src/app.js              摄像头 + 模型 + 音频 + 主循环
src/logic.mjs           纯逻辑：数手指、音阶映射、平滑、去抖
tests/logic.test.mjs    13 个单元测试
models/hand_landmarker.task   手部关键点模型（MediaPipe 官方 float16）
docs/plans/             设计文档与实现计划
```

## 测试

```bash
npm test        # 或 node --test "tests/**/*.test.mjs"
```

## 想自己调

| 想改什么 | 去哪里 |
| --- | --- |
| 音阶（现在是大调五声） | `src/logic.mjs` 的 `PENTATONIC` |
| 根音（现在是 C4） | `src/logic.mjs` 的 `ROOT_MIDI` |
| 换音的灵敏度 | `src/app.js` 的 `FINGER_STABLE_MS` |
| 八度切换的灵敏度 | `src/app.js` 的 `OCTAVE_STABLE_MS` |
| 音色 | `src/app.js` 的 `createVoice()` |
| 拇指识别太敏感/太钝 | `src/logic.mjs` 里拇指那条 `1.05` 系数，或直接关掉界面上的"含拇指" |

想只用四根手指（更稳）：取消勾选界面上的 **含拇指**，就变成 4 个音、拇指随便放。

## 路线图（v2 再说）

- 左手加和弦 / 伴奏层
- 手势方向 → 滑音、颤音
- 更好看的可视化和录音导出

## 致谢

灵感来自 Eric Wei 的 [Gesture Synth](https://indecisiveeric.com/gesture-synth)。这个版本走的是"手指数量 → 音阶级数"的极简映射，先把一件事做扎实。

## License

MIT
