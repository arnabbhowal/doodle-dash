// Client-side sound effects + music for DoodleDash.
//
// All playback is browser-only and guarded with `canPlay()`, so this module is
// safe to import from components that also render on the server. Volumes are
// plain constants so they're easy to tweak by ear.
//
// The click uses the Web Audio API (decoded once into a buffer, fired via a
// buffer-source node) so it plays with ~no latency and overlaps cleanly on rapid
// clicks. Audio is initialised on the first pointer/key interaction (which fires
// just before the click), so even the first click is instant; an HTMLAudio path
// is the fallback. Join is a one-shot HTMLAudio chime; the countdown plays in
// full synced to the timer; the lobby track loops.
//
// The source one-shots had leading silence / multiple takes, so button-click and
// player-join are pre-trimmed to a single clean hit (the *-trim.m4a files).

const SRC = {
  click: '/sounds/button-click-trim.m4a', // trimmed to one ~0.3s click
  join: '/sounds/player-join-trim.m4a',   // trimmed to the ~1s chime (no lead-in lag)
  countdown: '/sounds/countdown.mp3',
  lobby: '/sounds/lobby-music.m4a',        // AAC: plays on Safari + Chrome + Firefox
};

const VOL = { click: 0.4, join: 0.6, countdown: 0.55, lobby: 0.25 };

// The countdown clip is ~5.1s; start it when this many seconds remain so it
// finishes around 0. The host syncs the trigger to its round timer.
export const COUNTDOWN_LEAD_SECS = 5;

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

// Create + resume the context and decode the click buffer on the first user
// interaction (a pointerdown precedes the click), so playback is unlocked and
// the buffer is ready by the time the click fires. Avoids the autoplay warning.
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
  if (ctx && !clickBuffer) preloadClick(); // not decoded yet — ready for next time
  // Fallback for the very first click (buffer not ready) or if Web Audio is absent.
  if (!canPlay()) return;
  try {
    const a = new Audio(SRC.click);
    a.volume = VOL.click;
    void a.play().catch(() => {});
  } catch { /* ignore */ }
}

// ── Player-join chime (HTMLAudio one-shot) ────────────────────────────────────
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
  } catch {
    /* ignore */
  }
}
export function stopLobbyMusic() {
  if (lobby) {
    try { lobby.pause(); } catch { /* ignore */ }
    lobby = null;
  }
}

// ── Countdown (one-shot, synced to the timer's final seconds) ─────────────────
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
  if (countdown) {
    try { countdown.pause(); } catch { /* ignore */ }
    countdown = null;
  }
}
