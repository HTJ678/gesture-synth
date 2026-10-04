// gesture-synth — camera in, notes out.
//
// Two hands now:
//   right hand  : 1-5 fingers -> do re mi fa so   (fist = no note from this hand)
//   left hand   : 1-2 fingers -> la, si           (7-note scale only)
//   both fists  : silence
//   wrist height -> octave, wrist x -> volume
//
// Chord mode hands the whole job to the right hand: 1-5 fingers -> I IV V vi ii.
//
// Everything runs in the browser: MediaPipe Tasks Vision for hand landmarks,
// Web Audio for the sound. No server, no build step.

import {
  PENTATONIC,
  MAJOR_SCALE,
  KEYS,
  CHORD_DEGREES,
  CHORD_ROMANS,
  countExtendedFingers,
  extendedFingers,
  fingerMask,
  maskToFlags,
  BitStabilizer,
  matchGesture,
  fingerMidi,
  fingersToDegree,
  fingersToMidi,
  diatonicTriad,
  chordVoicing,
  chordSymbol,
  solfaName,
  scaleNote,
  midiToName,
  octaveFromY,
  volumeFromX,
  ema,
  Stabilizer,
} from "./logic.mjs?v=8";

const VISION_VERSION = "1.0.1";
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_URL = new URL("../models/hand_landmarker.task", import.meta.url).href;

// Fallback skeleton, in case the bundle does not expose HAND_CONNECTIONS.
const FALLBACK_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const FINGER_EMOJI = ["✊", "☝️", "✌️", "🤟", "🖖", "🖐"];
const FINGER_NAMES = ["拇指", "食指", "中指", "无名指", "小指"];
// Chord mode is gesture-based, not finger-count-based: comfortable, iconic
// shapes get the chords people actually play. Bit order: thumb..pinky.
// degrees: 0=I 1=ii 2=iii 3=IV 4=V 5=vi
const CHORD_GESTURES = [
  { mask: "01000", emoji: "☝️", name: "食指", degree: 0 },
  { mask: "01001", emoji: "🤘", name: "食指+小指（摇滚）", degree: 4 },
  { mask: "10001", emoji: "🤙", name: "拇指+小指（六）", degree: 5 },
  { mask: "01100", emoji: "✌️", name: "食指+中指", degree: 3 },
  { mask: "10000", emoji: "👍", name: "拇指", degree: 1 },
  { mask: "11111", emoji: "🖐", name: "五指全开", degree: 2 },
];
const EMPTY_MASK = "00000";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx2d = overlay.getContext("2d");
const keymap = $("keymap");
let keymapRows = [];

const els = {
  start: $("start"),
  reload: $("reload"),
  rebuild: $("rebuild"),
  test: $("test"),
  diag: $("diag"),
  diagOut: $("diagOut"),
  key: $("key"),
  scale: $("scale"),
  mode: $("mode"),
  cpu: $("cpu"),
  swap: $("swap"),
  thumb: $("thumb"),
  skeleton: $("skeleton"),
  note: $("note"),
  chord: $("chord"),
  pulse: $("pulse"),
  fingers: $("fingers"),
  octave: $("octave"),
  volume: $("volume"),
  fps: $("fps"),
  hand: $("hand"),
  err: $("err"),
  status: $("status"),
  debug: $("debug"),
};

// --- tuning knobs -----------------------------------------------------------
const FINGER_STABLE_MS = 140;
const OCTAVE_STABLE_MS = 260;
const VOLUME_SMOOTHING = 0.25;
const NO_HAND_HINT_AFTER_MS = 3000;

// --- state ------------------------------------------------------------------
let visionModule = null;
let landmarker = null;
let handConnections = FALLBACK_CONNECTIONS;
let voice = null;
let running = false;
let sampling = false;
let startedAt = 0;
let delegateInUse = "GPU";
let cpuRetryDone = false;

let frames = 0;
let fps = 0;
let lastFpsAt = 0;
let totalFrames = 0;
let framesWithHand = 0;
let detectErrors = 0;
let loopErrors = 0;
let lastError = null;
let lastHandSeenAt = 0;
let hintShown = false;
let volumeSmooth = null;
let lastPlayed = [];

// One debouncer per hand: they jitter independently and must not fight.
const FINGER_BIT_STABLE_MS = 110;
const CHORD_GRACE_MS = 350;
const PULSE_MS = 600; // 100 BPM re-attack when 节奏律动 is on
const rightHandBits = new BitStabilizer(FINGER_BIT_STABLE_MS);
const leftHandBits = new BitStabilizer(FINGER_BIT_STABLE_MS);
const octaveStabilizer = new Stabilizer(OCTAVE_STABLE_MS);
let lastGesture = null;
let lastGestureAt = 0;

// --- config -----------------------------------------------------------------
function currentConfig() {
  const key = KEYS[Number(els.key.value) || 0];
  const scale = els.scale.value === "major" ? MAJOR_SCALE : PENTATONIC;
  const chordMode = els.mode.value === "chord";
  const seventh = scale.length >= 7;
  return { rootMidi: key.root, keyLabel: key.label, scale, chordMode, seventh };
}

// --- deep links -------------------------------------------------------------
// ?mode=chord  -> open straight into the chord version
// ?scale=penta|major, ?key=0..6
function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  if (mode === "chord" || mode === "melody") els.mode.value = mode;
  const scale = params.get("scale");
  if (scale === "penta" || scale === "major") els.scale.value = scale;
  const key = Number(params.get("key"));
  if (Number.isInteger(key) && key >= 0 && key < KEYS.length) els.key.value = String(key);
}

function updateVersionLabel() {
  const el = $("version");
  if (!el) return;
  el.textContent =
    els.mode.value === "chord" ? "v0.2 · 和弦版（一个手势一个和弦）" : "v0.1 · 七声音阶版";
}

function setCheck(name, state, text) {  const li = document.querySelector(`[data-check="${name}"]`);
  if (!li) return;
  li.dataset.state = state;
  if (text) li.textContent = text;
}

function setStatus(text, failed = false) {
  els.status.textContent = text;
  els.status.dataset.state = failed ? "fail" : "ok";
}

function fail(label, err) {
  return `${label}：${err?.message || String(err)}`;
}

// --- left panel legend ------------------------------------------------------
function legendRow(hand, label, pitch, solfa, test) {
  const li = document.createElement("li");
  li.className = hand === "left" ? "left-hand" : "right-hand";
  const b = document.createElement("b");
  b.textContent = label;
  const p = document.createElement("span");
  p.className = "pitch";
  p.textContent = pitch;
  const s = document.createElement("span");
  s.className = "solfa";
  s.textContent = solfa;
  li.append(b, p, s);
  return { el: li, test };
}

function renderLegend() {
  const { rootMidi, scale, chordMode } = currentConfig();
  const includeThumb = chordMode ? true : els.thumb.checked;
  const first = includeThumb ? 0 : 1;  const rows = [];

  if (chordMode) {
    rows.push(
      legendRow("right", "✊ 握拳", "—", "静音", (r) => r === EMPTY_MASK),
    );
    for (const g of CHORD_GESTURES) {
      const degree = g.degree;
      const pitches = diatonicTriad(degree, rootMidi);
      rows.push(
        legendRow(
          "right",
          `${g.emoji} ${g.name}`,
          chordSymbol(pitches),
          CHORD_ROMANS[degree],
          (r) => r === g.mask,
        ),
      );
    }
  } else {
    for (let f = first; f < 5; f++) {
      rows.push(
        legendRow(
          "right",
          `右手 ${FINGER_NAMES[f]}`,
          midiToName(fingerMidi(f, "right", 0, { scale, rootMidi })),
          `${solfaName(f, scale)} · ${f + 1}`,
          (r) => r[f] === "1",
        ),
      );
    }
    for (let f = first; f < 5; f++) {
      const degree = 5 + f;
      rows.push(
        legendRow(
          "left",
          `左手 ${FINGER_NAMES[f]}`,
          midiToName(fingerMidi(f, "left", 0, { scale, rootMidi })),
          `${solfaName(degree, scale)} · ${(degree % scale.length) + 1}`,
          (_r, l) => l[f] === "1",
        ),
      );
    }
  }

  keymap.replaceChildren(...rows.map((r) => r.el));
  keymapRows = rows;

  const hint = $("legendHint");
  if (hint) {
    if (chordMode) {
      const names = CHORD_GESTURES.map((g) => chordSymbol(diatonicTriad(g.degree, rootMidi)));
      hint.innerHTML = `和弦版：<em>一个手势 = 一个和弦</em>（${names.join(" · ")}）。手势要做得干净利落，多余的手指会算成别的手势。`;
    } else {
      hint.innerHTML =
        "固定手指：<em>哪根伸出来就响哪个音</em>，同时伸多根就是同时响几个音（音程/和弦）。右手往上走，左手接着往上走。";
    }
  }
}

function highlightLegend(rightMask, leftMask) {
  for (const row of keymapRows) {
    row.el.classList.toggle("on", row.test(rightMask, leftMask));
  }
}

// --- audio ------------------------------------------------------------------
// A small additive synth: four sine partials per note (warm, e-piano-ish),
// an attack/decay envelope per note, a touch of stereo reverb, and an optional
// pulse that re-attacks held chords so they can actually carry a song.
function makeImpulse(ctx, seconds = 2.2, decay = 2.4) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

const PARTIALS = [
  { mult: 1, gain: 1 },
  { mult: 2, gain: 0.3 },
  { mult: 3, gain: 0.11 },
  { mult: 4, gain: 0.045 },
];

function createVoice() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const master = ctx.createGain();
  master.gain.value = 0.62;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 3400;
  tone.Q.value = 0.4;

  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;

  tone.connect(dry);
  dry.connect(master);
  tone.connect(convolver);
  convolver.connect(wet);
  wet.connect(master);
  master.connect(ctx.destination);

  const active = new Map();
  const PER_NOTE_GAIN = 0.42;
  const ATTACK = 0.014;
  const DECAY = 0.9;

  function startNote(midi, level) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(tone);

    const oscs = PARTIALS.map(({ mult, gain: pg }) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      const partialGain = ctx.createGain();
      partialGain.gain.value = pg;
      osc.connect(partialGain);
      partialGain.connect(gain);
      osc.start();
      return osc;
    });

    const voice = { oscs, gain, level };
    active.set(midi, voice);
    attack(voice, level);
  }

  function attack(voice, level) {
    const t = ctx.currentTime;
    const peak = level * PER_NOTE_GAIN;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(peak, t + ATTACK);
    // settle to a sustain so a held chord is not a brick wall of level
    voice.sustain = peak * 0.72;
    voice.gain.gain.setTargetAtTime(voice.sustain, t + ATTACK, DECAY / 3);
  }

  function stopNote(midi) {
    const voice = active.get(midi);
    if (!voice) return;
    active.delete(midi);
    const t = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.setTargetAtTime(0, t, 0.11);
    setTimeout(() => {
      for (const osc of voice.oscs) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      }
    }, 420);
  }

  let lastPulseAt = 0;

  return {
    ctx,
    play(midis, level, { pulseMs = 0, now = performance.now() } = {}) {
      const want = new Set(midis);
      for (const midi of [...active.keys()]) if (!want.has(midi)) stopNote(midi);

      const share = level / Math.sqrt(Math.max(1, want.size));
      const sustain = share * PER_NOTE_GAIN * 0.72;
      for (const midi of want) {
        const voice = active.get(midi);
        if (!voice) {
          startNote(midi, share);
        } else if (Math.abs((voice.sustain ?? 0) - sustain) > 0.02) {
          // Only chase the level when it actually moved, otherwise the smooth
          // follow would flatten the pulse's attack away.
          voice.level = share;
          voice.sustain = sustain;
          voice.gain.gain.setTargetAtTime(sustain, ctx.currentTime, 0.05);
        }
      }

      // Rhythmic re-attack: turns a static pad into something you can sing over.
      if (pulseMs > 0 && want.size > 0) {
        if (now - lastPulseAt >= pulseMs) {
          lastPulseAt = now;
          for (const voice of active.values()) attack(voice, voice.level ?? share);
        }
      } else if (want.size === 0) {
        lastPulseAt = now;
      }
    },
    stopAll() {
      for (const midi of [...active.keys()]) stopNote(midi);
    },
  };
}

// --- rendering --------------------------------------------------------------
function drawHand(landmarks) {
  if (!landmarks || !els.skeleton.checked) return;
  const W = overlay.width;
  const H = overlay.height;
  const pt = (i) => ({ x: landmarks[i].x * W, y: landmarks[i].y * H });

  ctx2d.lineWidth = 3;
  ctx2d.strokeStyle = "rgba(125, 211, 252, 0.9)";
  for (const [a, b] of handConnections) {
    const p1 = pt(a);
    const p2 = pt(b);
    ctx2d.beginPath();
    ctx2d.moveTo(p1.x, p1.y);
    ctx2d.lineTo(p2.x, p2.y);
    ctx2d.stroke();
  }

  ctx2d.fillStyle = "rgba(249, 168, 212, 0.95)";
  for (let i = 0; i < landmarks.length; i++) {
    const p = pt(i);
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx2d.fill();
  }
}

// --- model ------------------------------------------------------------------
async function buildLandmarker(delegate) {
  const { FilesetResolver, HandLandmarker } = visionModule;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const instance = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    // Deliberately loose: a missed hand is worse than a jittery one here,
    // and the Stabilizer layer already cleans up the noise.
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  handConnections = HandLandmarker?.HAND_CONNECTIONS ?? visionModule.HAND_CONNECTIONS ?? FALLBACK_CONNECTIONS;
  return instance;
}

async function sampleDetection(iterations = 60) {
  let maxHands = 0;
  let maxPoints = 0;
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 33));
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const n = res?.landmarks?.length ?? 0;
      maxHands = Math.max(maxHands, n);
      if (n) maxPoints = Math.max(maxPoints, res.landmarks[0].length);
    } catch (err) {
      errors++;
      lastError = err?.message || String(err);
    }
  }
  return { maxHands, maxPoints, errors };
}

async function runDetectTest() {
  if (!landmarker || !running) {
    setStatus("先点『开始』，跑起来再测。", true);
    return;
  }
  els.test.disabled = true;
  sampling = true;
  setStatus("正在测试识别（2 秒）—— 把手放进画面中间…");
  try {
    const { maxHands, maxPoints, errors } = await sampleDetection();
    setStatus(
      `测试结果：最多识别到 ${maxHands} 只手（关键点 ${maxPoints} 个）· 推理 ${delegateInUse} · 异常 ${errors} 次`,
      maxHands === 0,
    );
  } finally {
    sampling = false;
    els.test.disabled = false;
  }
}

async function runDiagnostics() {
  els.diag.disabled = true;
  sampling = true;
  const lines = [];
  try {
    lines.push(`页面      ${location.href}`);
    lines.push(`浏览器    ${navigator.userAgent}`);
    lines.push(`WebGL2    ${!!document.createElement("canvas").getContext("webgl2")}`);
    lines.push(
      `视频      ${video.videoWidth}x${video.videoHeight} ready=${video.readyState} paused=${video.paused}`,
    );
    lines.push(`模型      ${delegateInUse} · running=${running}`);
    lines.push(
      `主循环    帧=${totalFrames} 有手=${framesWithHand} detect异常=${detectErrors} 循环异常=${loopErrors}`,
    );
    const cfg = currentConfig();
    lines.push(`配置      调=${cfg.keyLabel} 音阶=${els.scale.value} 玩法=${els.mode.value} 拇指=${els.thumb.checked} 交换手=${els.swap.checked}`);
    lines.push(`最近错误  ${lastError ?? "无"}`);
    if (landmarker && running) {
      const { maxHands, maxPoints, errors } = await sampleDetection(45);
      lines.push(`采样1.5s  最多 ${maxHands} 只手 · 关键点 ${maxPoints} · 异常 ${errors}`);
    } else {
      lines.push("采样      未运行");
    }
  } catch (err) {
    lines.push(`诊断本身出错 ${err?.message || err}`);
  } finally {
    sampling = false;
    els.diag.disabled = false;
  }
  els.diagOut.textContent = lines.join("\n");
  els.diagOut.hidden = false;
}

// --- main loop --------------------------------------------------------------
/** Split the detected hands into a left one and a right one. */
function splitHands(result) {
  const out = { right: null, left: null };
  const lists = result?.landmarks ?? [];
  for (let i = 0; i < lists.length; i++) {
    const labelled =
      result?.handednesses?.[i]?.[0]?.categoryName ?? result?.handedness?.[i]?.[0]?.categoryName ?? "";
    let side = /left/i.test(labelled) ? "left" : "right";
    // MediaPipe labels assume a mirrored (selfie) input. Our frames are raw,
    // so the label is flipped unless the user tells us otherwise.
    if (els.swap.checked) side = side === "left" ? "right" : "left";
    if (!out[side]) out[side] = lists[i];
  }
  return out;
}

function frame(now) {
  frames++;
  if (now - lastFpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - lastFpsAt));
    frames = 0;
    lastFpsAt = now;
  }

  let result = null;
  totalFrames++;
  try {
    result = landmarker.detectForVideo(video, performance.now());
  } catch (err) {
    detectErrors++;
    lastError = err?.message || String(err);
    if (detectErrors === 3) fallbackToCpu();
  }

  const { right, left } = splitHands(result);
  const detectHands = (result?.landmarks?.length ?? 0);
  const anchor = right ?? left;

  if (anchor) {
    framesWithHand++;
    lastHandSeenAt = now;
    hintShown = false;
  } else if (!hintShown && detectErrors === 0 && now - (lastHandSeenAt || 0) > NO_HAND_HINT_AFTER_MS) {
    hintShown = true;
    setStatus("摄像头正常，但没看到手 —— 把手放进画面中间（离 40–80cm），背景别太乱、开个灯。");
  }

  const { rootMidi, scale, chordMode } = currentConfig();
  // Chord mode always watches the thumb: the gestures rely on it.
  const includeThumb = chordMode ? true : els.thumb.checked;

  const noFingers = [false, false, false, false, false];
  rightHandBits.update(right ? extendedFingers(right, { includeThumb }) : noFingers, now);
  leftHandBits.update(left ? extendedFingers(left, { includeThumb }) : noFingers, now);
  const rightMask = rightHandBits.mask;
  const leftMask = leftHandBits.mask;
  const octave = octaveStabilizer.update(anchor ? octaveFromY(anchor[0].y) : 0, now);
  const root = rootMidi + octave * 12;

  const allowed = (f) => includeThumb || f !== 0;
  const rightFlags = maskToFlags(rightMask).map((on, f) => on && allowed(f));
  const leftFlags = maskToFlags(leftMask).map((on, f) => on && allowed(f));

  // Which notes should be sounding?
  let midis = [];
  let chordTriad = [];
  let activeGesture = null;
  if (chordMode) {
    let gesture = rightMask === EMPTY_MASK ? null : matchGesture(rightMask, CHORD_GESTURES, 4);
    if (gesture) {
      lastGesture = gesture;
      lastGestureAt = now;
    } else if (lastGesture && now - lastGestureAt < CHORD_GRACE_MS) {
      gesture = lastGesture; // hold through a bad frame instead of stuttering
    }
    activeGesture = gesture;
    if (gesture) {
      chordTriad = diatonicTriad(gesture.degree, root);
      midis = chordVoicing(gesture.degree, root);
    }
  } else {
    rightFlags.forEach((on, f) => {
      if (on) midis.push(fingerMidi(f, "right", octave, { scale, rootMidi }));
    });
    leftFlags.forEach((on, f) => {
      if (on) midis.push(fingerMidi(f, "left", octave, { scale, rootMidi }));
    });
  }
  midis = [...new Set(midis)].sort((a, b) => a - b);

  const targetVolume = anchor ? volumeFromX(anchor[0].x) : 0;
  volumeSmooth = ema(volumeSmooth, targetVolume, VOLUME_SMOOTHING);
  if (voice) voice.play(midis, volumeSmooth, { pulseMs: els.pulse.checked ? PULSE_MS : 0, now });
  lastPlayed = midis;

  // Draw
  ctx2d.clearRect(0, 0, overlay.width, overlay.height);
  if (result?.landmarks) for (const lm of result.landmarks) drawHand(lm);

  highlightLegend(rightMask, leftMask);
  const seconds = ((now - startedAt) / 1000).toFixed(1);
  const label = chordMode
    ? (chordTriad.length ? chordSymbol(chordTriad) : "·")
    : (midis.length ? midiToName(midis[0]) : "·");
  els.note.textContent = label;
  els.chord.textContent = chordMode
    ? `${activeGesture ? `${activeGesture.emoji} ${activeGesture.name}` : "无匹配手势"} · ${midis.length ? midis.map((m) => midiToName(m)).join(" ") : "（静音）"}`
    : midis.length > 1
      ? midis.map((m) => midiToName(m)).join(" · ")
      : "";
  const rightOn = rightFlags.filter(Boolean).length;
  const leftOn = leftFlags.filter(Boolean).length;
  els.fingers.textContent = anchor
    ? chordMode
      ? `手势 ${rightMask}`
      : `右 ${rightOn} / 左 ${leftOn}`
    : "–";
  els.octave.textContent = anchor ? (octave > 0 ? "+1" : octave < 0 ? "-1" : "0") : "–";
  els.volume.textContent = anchor ? `${Math.round(volumeSmooth * 100)}%` : "–";
  els.fps.textContent = String(fps);
  els.hand.textContent = detectHands ? `${detectHands} 只` : "✘";
  els.hand.style.color = detectHands ? "#86efac" : "#fca5a5";
  els.err.textContent = String(detectErrors);
  els.debug.textContent =
    `t=${seconds}s · 帧 ${totalFrames} · 本帧手 ${detectHands} · 有手 ${framesWithHand}` +
    ` · 错误 ${detectErrors} · 循环异常 ${loopErrors} · 推理 ${delegateInUse}` +
    (lastError ? ` · 最近：${lastError}` : "");
}

// A single bad frame must never kill the loop. Ever.
function loop(now) {
  if (!running) return;
  if (!sampling) {
    try {
      frame(now);
    } catch (err) {
      loopErrors++;
      lastError = err?.message || String(err);
      els.debug.textContent = `⚠ 主循环异常第 ${loopErrors} 次：${lastError}`;
    }
  }
  requestAnimationFrame(loop);
}

async function fallbackToCpu() {
  if (cpuRetryDone) return false;
  cpuRetryDone = true;
  try {
    landmarker = await buildLandmarker("CPU");
    delegateInUse = "CPU";
    detectErrors = 0;
    lastError = null;
    setStatus("GPU 推理失败，已自动切到 CPU 模式，继续试～");
    return true;
  } catch (err) {
    setStatus(`CPU 模式也起不来：${err.message}`, true);
    return false;
  }
}

// --- boot -------------------------------------------------------------------
async function start() {
  els.start.disabled = true;

  try {
    voice = createVoice();
    await voice.ctx.resume();
    setCheck("audio", "ok", "音频引擎 ✅");
  } catch (err) {
    setCheck("audio", "fail", "音频引擎 ❌");
    setStatus(fail("音频初始化失败", err), true);
    els.start.disabled = false;
    return;
  }

  try {
    visionModule = await import(BUNDLE_URL);
    const preferred = els.cpu.checked ? "CPU" : "GPU";
    landmarker = await buildLandmarker(preferred);
    delegateInUse = preferred;
    setCheck("model", "ok", `手部模型 ✅ (${preferred})`);
  } catch (gpuErr) {
    try {
      landmarker = await buildLandmarker("CPU");
      delegateInUse = "CPU";
      cpuRetryDone = true;
      setCheck("model", "ok", "手部模型 ✅ (CPU)");
    } catch (cpuErr) {
      setCheck("model", "fail", "手部模型 ❌");
      setStatus(`${fail("GPU 加载失败", gpuErr)} / ${fail("CPU 加载失败", cpuErr)}`, true);
      els.start.disabled = false;
      return;
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        video.addEventListener("loadeddata", resolve, { once: true });
      });
    }
    setCheck("camera", "ok", `摄像头 ✅ ${video.videoWidth}×${video.videoHeight}`);
  } catch (err) {
    setCheck("camera", "fail", "摄像头 ❌");
    setStatus(`${fail("拿不到摄像头", err)}。必须用 localhost 或 HTTPS 打开，并允许权限。`, true);
    els.start.disabled = false;
    return;
  }

  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
  startedAt = performance.now();
  lastHandSeenAt = startedAt;
  setStatus("开始玩吧 —— 右手弹音，左手补 la / si，握拳静音。");
  running = true;
  requestAnimationFrame(loop);
}

// --- wiring -----------------------------------------------------------------
els.start.addEventListener("click", start);
els.reload.addEventListener("click", () => location.reload());
els.test.addEventListener("click", runDetectTest);
els.diag.addEventListener("click", runDiagnostics);
els.key.addEventListener("change", renderLegend);
els.scale.addEventListener("change", renderLegend);
els.mode.addEventListener("change", () => {
  renderLegend();
  updateVersionLabel();
  if (voice) voice.stopAll();
});
els.rebuild.addEventListener("click", async () => {
  if (!visionModule || !running) {
    setStatus("先点『开始』，跑起来才能换推理方式。", true);
    return;
  }
  els.rebuild.disabled = true;
  const delegate = els.cpu.checked ? "CPU" : "GPU";
  setStatus(`正在重新加载模型（${delegate}）…`);
  try {
    landmarker = await buildLandmarker(delegate);
    delegateInUse = delegate;
    detectErrors = 0;
    lastError = null;
    cpuRetryDone = true;
    setStatus(`模型已换成 ${delegate}，再试试伸手。`);
  } catch (err) {
    setStatus(fail(`${delegate} 加载失败`, err), true);
  } finally {
    els.rebuild.disabled = false;
  }
});
document.addEventListener("click", () => {
  if (voice && voice.ctx.state === "suspended") voice.ctx.resume();
});

applyUrlParams();
renderLegend();
updateVersionLabel();

// Small hook so the whole thing can be poked at from the console.
window.__gestureSynth = {
  get state() {
    return {
      running,
      fps,
      totalFrames,
      framesWithHand,
      detectErrors,
      loopErrors,
      lastError,
      delegateInUse,
      lastPlayed,
    };
  },
  get landmarker() {
    return landmarker;
  },
  async detectOnce() {
    const result = landmarker.detectForVideo(video, performance.now());
    return result?.landmarks?.length ?? 0;
  },
  start,
  runDiagnostics,
};
