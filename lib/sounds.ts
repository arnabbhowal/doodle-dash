// Client-side sound effects + music for DoodleDash.
//
// All playback is browser-only and guarded with `canPlay()`, so this module is
// safe to import from components that also render on the server. Volumes are
// plain constants so they're easy to tweak by ear.
//
// The click uses the Web Audio API (decoded once into a buffer, fired via a
// buffer-source node) so it plays with ~no latency and overlaps cleanly. Audio
// unlocks + preloads on the first pointer/key interaction. Everything else uses
// HTMLAudio: the lobby + while-drawing tracks loop; the countdown is a 5s clip
// scheduled to END exactly when the timer hits 0; confetti/trombone are one-shots.
//
// Source clips were trimmed to their meaningful region (see the *-trim work in
// public/sounds): countdown = final 5.0s, while-drawing = 138s seamless loop.

const SRC = {
  click: '/sounds/button-click-trim.m4a',
  join: '/sounds/player-join.m4a',
  countdown: '/sounds/countdown.m4a',   // 5.0s — scheduled to end at timer 0
  lobby: '/sounds/lobby-music.m4a',
  drawing: '/sounds/while-drawing.m4a', // looping ambient while a player draws
  confetti: '/sounds/end-confetti.m4a',
  trombone: '/sounds/sad-trombone.m4a',
};

const VOL = {
  click: 0.4,
  join: 0.6,
  countdown: 0.6,
  lobby: 0.25,
  drawing: 0.32,      // normal while-drawing volume
  drawingDuck: 0.1,   // ducked while the countdown plays
  confetti: 0.6,
  trombone: 0.75,
};

// The countdown clip is 5.0s; callers schedule it to start this long before the
// round deadline so it finishes exactly at 0.
export const COUNTDOWN_CLIP_MS = 5000;

const canPlay = () => typeof window !== 'undefined' && typeof Audio !== 'undefined';

// ── Low-latency click via Web Audio (decoded once, instant playback) ──────────
let audioCtx: AudioContext | null = null;
let clickBuffer: AudioBuffer | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
  }
  return audioCtx;
}

function preloadClick() {
  const ctx = getCtx();
  if (!ctx || clickBuffer) return;
  fetch(SRC.click)
    .then(r => r.arrayBuffer())
    .then(a => ctx.decodeAudioData(a))
    .then(buf => { clickBuffer = buf; })
    .catch(() => { /* fall back to HTMLAudio in playClick */ });
}

if (typeof window !== 'undefined') {
  const init = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    preloadClick();
  };
  window.addEventListener('pointerdown', init, { once: true, capture: true });
  window.addEventListener('keydown', init, { once: true, capture: true });
}

export function playClick() {
  const ctx = getCtx();
  if (ctx && clickBuffer) {
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const src = ctx.createBufferSource();
      src.buffer = clickBuffer;
      const gain = ctx.createGain();
      gain.gain.value = VOL.click;
      src.connect(gain).connect(ctx.destination);
      src.start();
      return;
    } catch { /* fall through to HTMLAudio */ }
  }
  if (ctx && !clickBuffer) preloadClick();
  if (!canPlay()) return;
  try {
    const a = new Audio(SRC.click);
    a.volume = VOL.click;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}

// ── Generic one-shots (latency not critical) ──────────────────────────────────
function oneShot(src: string, volume: number) {
  if (!canPlay()) return;
  try {
    const a = new Audio(src);
    a.volume = volume;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}
export const playJoin = () => oneShot(SRC.join, VOL.join);
export const playConfetti = () => oneShot(SRC.confetti, VOL.confetti);
export const playTrombone = () => oneShot(SRC.trombone, VOL.trombone);

// ── Looping singletons (lobby music, while-drawing ambient) ───────────────────
function makeLoop(src: string, volume: number): HTMLAudioElement | null {
  if (!canPlay()) return null;
  try {
    const a = new Audio(src);
    a.loop = true;
    a.volume = volume;
    void a.play().catch(() => {});
    return a;
  } catch {
    return null;
  }
}

let lobby: HTMLAudioElement | null = null;
export function startLobbyMusic() { if (!lobby) lobby = makeLoop(SRC.lobby, VOL.lobby); }
export function stopLobbyMusic() {
  if (lobby) { try { lobby.pause(); } catch { /* ignore */ } lobby = null; }
}

let drawing: HTMLAudioElement | null = null;
export function startDrawingMusic() { if (!drawing) drawing = makeLoop(SRC.drawing, VOL.drawing); }
export function stopDrawingMusic() {
  if (drawing) { try { drawing.pause(); } catch { /* ignore */ } drawing = null; }
}
// Duck the while-drawing ambient (e.g. while the countdown plays), then restore.
export function duckDrawingMusic(ducked: boolean) {
  if (drawing) drawing.volume = ducked ? VOL.drawingDuck : VOL.drawing;
}

// ── Countdown (one-shot, scheduled by the caller to end at the timer's 0) ──────
let countdown: HTMLAudioElement | null = null;
export function startCountdown() {
  if (!canPlay() || countdown) return;
  try {
    countdown = new Audio(SRC.countdown);
    countdown.volume = VOL.countdown;
    countdown.addEventListener('ended', () => { countdown = null; });
    void countdown.play().catch(() => {});
  } catch {
    /* ignore */
  }
}
export function stopCountdown() {
  if (countdown) { try { countdown.pause(); } catch { /* ignore */ } countdown = null; }
}
