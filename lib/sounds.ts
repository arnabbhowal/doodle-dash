// Client-side sound for DoodleDash — all via the Web Audio API.
//
// iOS Safari blocks `new Audio().play()` outside a user gesture, which made
// scheduled/auto sounds (countdown, join, victory, loops) fire unreliably. So
// EVERYTHING goes through a single AudioContext unlocked + preloaded on the first
// pointer/key interaction; after that, buffers play anytime (no per-play gesture).
// decodeAudioData handles m4a (AAC) and mp3 on all target browsers.

const SRC: Record<string, string> = {
  click: '/sounds/button-click-trim.m4a',
  back: '/sounds/back-button-click.m4a',
  join: '/sounds/player-join.m4a',
  countdown: '/sounds/countdown.mp3',
  lobby: '/sounds/lobby-music.m4a',
  drawing: '/sounds/while-drawing.m4a',
  victory: '/sounds/victory.m4a',
  confettiGun: '/sounds/confetti-gun.m4a',
};

const VOL: Record<string, number> = {
  click: 0.4, back: 0.5, join: 0.6, countdown: 0.85,
  lobby: 0.25, drawing: 0.3, victory: 0.8, confettiGun: 0.7,
};

export const COUNTDOWN_RATE = 1.0;
export const COUNTDOWN_LEAD_MS = 5060;

let ctx: AudioContext | null = null;
const buffers: Record<string, AudioBuffer | undefined> = {};
const loading: Record<string, boolean> = {};

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  return ctx;
}
function ensure(): AudioContext | null {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
  return c;
}
function load(key: string) {
  const c = getCtx();
  if (!c || buffers[key] || loading[key]) return;
  loading[key] = true;
  fetch(SRC[key])
    .then(r => r.arrayBuffer())
    .then(a => c.decodeAudioData(a))
    .then(b => { buffers[key] = b; })
    .catch(() => {})
    .finally(() => { loading[key] = false; });
}

if (typeof window !== 'undefined') {
  const init = () => { ensure(); Object.keys(SRC).forEach(load); };
  window.addEventListener('pointerdown', init, { once: true, capture: true });
  window.addEventListener('keydown', init, { once: true, capture: true });
}

function playOne(key: string) {
  const c = ensure();
  if (!c) return;
  const b = buffers[key];
  if (!b) { load(key); return; }
  try {
    const s = c.createBufferSource();
    s.buffer = b;
    const g = c.createGain();
    g.gain.value = VOL[key];
    s.connect(g).connect(c.destination);
    s.start();
  } catch { /* ignore */ }
}

export const playClick = () => playOne('click');
export const playBack = () => playOne('back');
export const playJoin = () => playOne('join');
export const playVictory = () => playOne('victory');
export const playConfettiGun = () => playOne('confettiGun');

// Looping track (lobby, while-drawing). Waits for the buffer to decode, and a
// stop() before then cancels the pending start.
function makeLooper(key: string) {
  let node: AudioBufferSourceNode | null = null;
  let wanted = false;
  const begin = () => {
    if (!wanted || node) return;
    const c = ensure();
    if (!c) return;
    const b = buffers[key];
    if (!b) { load(key); setTimeout(begin, 150); return; }
    try {
      const s = c.createBufferSource();
      s.buffer = b;
      s.loop = true;
      const g = c.createGain();
      g.gain.value = VOL[key];
      s.connect(g).connect(c.destination);
      s.start();
      node = s;
    } catch { /* ignore */ }
  };
  return {
    start() { wanted = true; begin(); },
    stop() { wanted = false; if (node) { try { node.stop(); } catch {} node = null; } },
  };
}
const lobby = makeLooper('lobby');
const drawing = makeLooper('drawing');
export const startLobbyMusic = lobby.start;
export const stopLobbyMusic = lobby.stop;
export const startDrawingMusic = drawing.start;
export const stopDrawingMusic = drawing.stop;

// Countdown — one-shot, scheduled by the caller to end at the timer's 0.
let cdNode: AudioBufferSourceNode | null = null;
export function startCountdown() {
  if (cdNode) return;
  const c = ensure();
  if (!c) return;
  const b = buffers.countdown;
  if (!b) { load('countdown'); return; }
  try {
    const s = c.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = COUNTDOWN_RATE;
    const g = c.createGain();
    g.gain.value = VOL.countdown;
    s.connect(g).connect(c.destination);
    s.onended = () => { cdNode = null; };
    s.start();
    cdNode = s;
  } catch { /* ignore */ }
}
export function stopCountdown() {
  if (cdNode) { try { cdNode.stop(); } catch {} cdNode = null; }
}
