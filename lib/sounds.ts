// Client-side sound effects + music for DoodleDash.
//
// All playback is browser-only and guarded with `canPlay()`, so this module is
// safe to import from components that also render on the server. Volumes and the
// one-shot caps are plain constants so they're easy to tweak by ear.
//
// On "trimming": the source one-shots (button-click ~6.8s, player-join ~5s) have
// long tails. Rather than re-encode them we just play the meaningful HEAD of the
// clip and pause at CAP_MS. If a sound's content isn't at the very start, bump
// the matching CAP_MS. The countdown (~5.1s) plays in full, synced to the timer;
// the lobby track loops.

type OneShot = 'click' | 'join';

const SRC = {
  click: '/sounds/button-click.mp3',
  join: '/sounds/player-join.mp3',
  countdown: '/sounds/countdown.mp3',
  lobby: '/sounds/lobby-music.m4a', // AAC: plays on Safari + Chrome + Firefox
};

const CAP_MS: Record<OneShot, number> = { click: 350, join: 1500 };
const VOL = { click: 0.35, join: 0.6, countdown: 0.5, lobby: 0.25 };

// The countdown clip is ~5.1s; start it when this many seconds remain so it
// finishes around 0. The host syncs the trigger to its round timer.
export const COUNTDOWN_LEAD_SECS = 5;

const canPlay = () => typeof window !== 'undefined' && typeof Audio !== 'undefined';

function playOneShot(key: OneShot) {
  if (!canPlay()) return;
  try {
    const a = new Audio(SRC[key]);
    a.volume = VOL[key];
    void a.play().catch(() => {}); // autoplay can reject before a user gesture
    const cap = CAP_MS[key];
    if (cap) window.setTimeout(() => { try { a.pause(); } catch {} }, cap);
  } catch {
    /* ignore */
  }
}

export const playClick = () => playOneShot('click');
export const playJoin = () => playOneShot('join');

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
