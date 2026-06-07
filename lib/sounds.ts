// Client-side sound effects + music for DoodleDash.
//
// All playback is browser-only and guarded with `canPlay()`, so this module is
// safe to import from components that also render on the server. Volumes are
// plain constants so they're easy to tweak by ear.
//
// Clicks (normal + back) use the Web Audio API (decoded once into buffers, fired
// via buffer-source nodes) so they play with ~no latency and overlap cleanly.
// Audio unlocks + preloads on the first pointer/key interaction. The lobby +
// while-drawing tracks loop; the countdown is a 5s clip scheduled to END exactly
// when the timer hits 0; victory + confetti-gun are end-of-game one-shots.

const SRC = {
  click: '/sounds/button-click-trim.m4a',
  back: '/sounds/back-button-click.m4a',
  join: '/sounds/player-join.m4a',
  countdown: '/sounds/countdown.mp3',   // 5s countdown — scheduled to end at timer 0
  lobby: '/sounds/lobby-music.m4a',
  drawing: '/sounds/while-drawing.m4a', // looping ambient while a player draws
  victory: '/sounds/victory.m4a',
  confettiGun: '/sounds/confetti-gun.m4a',
};

const VOL = {
  click: 0.4,
  back: 0.5,
  join: 0.6,
  countdown: 0.85,
  lobby: 0.25,
  drawing: 0.3,
  victory: 0.8,
  confettiGun: 0.7,
};

// Countdown sync. countdown.mp3 is a clean 5s countdown (1 beep/second), so no
// time-stretch (rate 1). Scheduled to start COUNTDOWN_LEAD_MS before the deadline
// so the clip ends exactly at 0 (first beep ≈ 5s left).
export const COUNTDOWN_RATE = 1.0;
export const COUNTDOWN_LEAD_MS = 5060;

const canPlay = () => typeof window !== 'undefined' && typeof Audio !== 'undefined';

// ── Low-latency clicks via Web Audio (decoded once into buffers) ──────────────
type BufKey = 'click' | 'back';
let audioCtx: AudioContext | null = null;
const buffers: Partial<Record<BufKey, AudioBuffer>> = {};

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
  }
  return audioCtx;
}

function preloadBuffer(key: BufKey) {
  const ctx = getCtx();
  if (!ctx || buffers[key]) return;
  fetch(SRC[key])
    .then(r => r.arrayBuffer())
    .then(a => ctx.decodeAudioData(a))
    .then(buf => { buffers[key] = buf; })
    .catch(() => { /* fall back to HTMLAudio */ });
}

if (typeof window !== 'undefined') {
  const init = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    preloadBuffer('click');
    preloadBuffer('back');
  };
  window.addEventListener('pointerdown', init, { once: true, capture: true });
  window.addEventListener('keydown', init, { once: true, capture: true });
}

function playBuffered(key: BufKey, volume: number) {
  const ctx = getCtx();
  if (ctx && buffers[key]) {
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const src = ctx.createBufferSource();
      src.buffer = buffers[key]!;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain).connect(ctx.destination);
      src.start();
      return;
    } catch { /* fall through to HTMLAudio */ }
  }
  if (ctx && !buffers[key]) preloadBuffer(key);
  if (!canPlay()) return;
  try {
    const a = new Audio(SRC[key]);
    a.volume = volume;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}

export const playClick = () => playBuffered('click', VOL.click);
export const playBack = () => playBuffered('back', VOL.back);

// ── One-shots (latency not critical) ──────────────────────────────────────────
function oneShot(src: string, volume: number) {
  if (!canPlay()) return;
  try {
    const a = new Audio(src);
    a.volume = volume;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}
export const playJoin = () => oneShot(SRC.join, VOL.join);
export const playVictory = () => oneShot(SRC.victory, VOL.victory);
export const playConfettiGun = () => oneShot(SRC.confettiGun, VOL.confettiGun);

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

// ── Countdown (one-shot, scheduled by the caller to end at the timer's 0) ──────
let countdown: HTMLAudioElement | null = null;
export function startCountdown() {
  if (!canPlay() || countdown) return;
  try {
    countdown = new Audio(SRC.countdown);
    countdown.volume = VOL.countdown;
    countdown.preservesPitch = true;
    (countdown as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    countdown.playbackRate = COUNTDOWN_RATE;
    countdown.addEventListener('ended', () => { countdown = null; });
    void countdown.play().catch(() => {});
  } catch {
    /* ignore */
  }
}
export function stopCountdown() {
  if (countdown) { try { countdown.pause(); } catch { /* ignore */ } countdown = null; }
}
