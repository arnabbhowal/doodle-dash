// Client-side sound effects + music for DoodleDash.
//
// All playback is browser-only and guarded with `canPlay()`, so this module is
// safe to import from components that also render on the server. Volumes are
// plain constants so they're easy to tweak by ear.
//
// The click uses the Web Audio API (decoded once into a buffer, fired via a
// buffer-source node) so it plays with ~no latency and overlaps cleanly. Audio
// unlocks + preloads on the first pointer/key interaction. The lobby track loops;
// the countdown is a 5s clip scheduled to END exactly when the timer hits 0.

const SRC = {
  click: '/sounds/button-click-trim.m4a',
  join: '/sounds/player-join.m4a',
  countdown: '/sounds/countdown.mp3',   // 5s countdown — scheduled to end at timer 0
  lobby: '/sounds/lobby-music.m4a',
};

const VOL = {
  click: 0.4,
  join: 0.6,
  countdown: 0.85,
  lobby: 0.25,
};

// Countdown sync. countdown.mp3 is a clean 5s countdown — beeps ~1s apart
// (5/4/3/2) and a final tone over the last second. It's already 1 beep/second, so
// no time-stretch (rate 1). Scheduled to start COUNTDOWN_LEAD_MS before the
// deadline so the clip ends exactly at 0 (first beep ≈ 5s left).
export const COUNTDOWN_RATE = 1.0;
export const COUNTDOWN_LEAD_MS = 5060;

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

// ── Player-join chime (one-shot) ──────────────────────────────────────────────
export function playJoin() {
  if (!canPlay()) return;
  try {
    const a = new Audio(SRC.join);
    a.volume = VOL.join;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}

// ── Lobby music (looping singleton) ───────────────────────────────────────────
let lobby: HTMLAudioElement | null = null;
export function startLobbyMusic() {
  if (!canPlay() || lobby) return;
  try {
    lobby = new Audio(SRC.lobby);
    lobby.loop = true;
    lobby.volume = VOL.lobby;
    void lobby.play().catch(() => {});
  } catch { /* ignore */ }
}
export function stopLobbyMusic() {
  if (lobby) { try { lobby.pause(); } catch { /* ignore */ } lobby = null; }
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
