'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useReducer, useTable, useProcedure, useSpacetimeDB } from 'spacetimedb/react';
import { reducers, tables, procedures } from '../../../src/module_bindings';
import confetti from 'canvas-confetti';
import { uploadDrawing, uploadHijackCanvas } from '../../../lib/supabase';
import { BrutalButton } from '../../components/BrutalButton';
import { BrutalCard } from '../../components/BrutalCard';
import { CountUp } from '../../components/CountUp';
import { startDrawingMusic, stopDrawingMusic, duckDrawingMusic, startCountdown, stopCountdown, playConfetti, playTrombone, COUNTDOWN_CLIP_MS } from '../../../lib/sounds';

const COLORS = [
  '#000000','#6b7280','#ffffff','#8b5e34',          // black, gray, white, brown
  '#ef4444','#f97316','#f59e0b','#eab308','#84cc16', // red, orange, amber, yellow, lime
  '#22c55e','#14b8a6','#06b6d4','#3b82f6','#6366f1', // green, teal, cyan, blue, indigo
  '#8b5cf6','#d946ef','#ec4899','#f43f5e',           // violet, fuchsia, pink, rose
];
const BRUSH_SIZES = [4, 10, 20, 36];
const EFFECT_LABELS: Record<string, string> = {
  hijack: 'Board Hijacked',
};

// ── Board Hijack sabotage ───────────────────────────────────────────────────────
// The attacker controls the victim's canvas for HIJACK_MS. The attacker scribbles on
// a pad; batches of normalized points stream through the hijack_draw reducer; the
// victim replays them onto its canvas live. Both can draw at once — pure chaos.
const HIJACK_MS = 10000;
const HIJACK_SIZE_FRAC = 0.045;            // brush size as a fraction of the canvas short side
const HIJACK_COLORS = ['#000000', '#ef4444', '#3b82f6']; // attacker's vandal palette

// Render one streamed batch of hijack points onto a canvas. Points are [nx, ny, down]
// with nx/ny normalized 0..1 and down=1 marking the start of a new segment (pen-down).
// `last` carries the previous point across batches so segments connect. Used both by
// the victim (live, from a hijack_point row) and the attacker (local pad feedback).
function drawHijackBatch(
  canvas: HTMLCanvasElement | null,
  data: { pts: string; color: string; size: number },
  last: { current: { x: number; y: number } | null },
) {
  const ctx = canvas?.getContext('2d');
  if (!ctx || !canvas) return;
  const W = canvas.width, H = canvas.height;
  const lw = Math.max(1, data.size * Math.min(W, H));
  let pts: number[][];
  try { pts = JSON.parse(data.pts); } catch { return; }
  ctx.strokeStyle = data.color;
  ctx.fillStyle   = data.color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.globalAlpha = 1;
  for (const p of pts) {
    const x = p[0] * W, y = p[1] * H;
    if (p[2]) {                       // pen-down → dot + start a new segment
      ctx.beginPath();
      ctx.arc(x, y, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      last.current = { x, y };
    } else if (last.current) {        // continue the current segment
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      last.current = { x, y };
    } else {
      last.current = { x, y };
    }
  }
}

function getSecondsLeft(endsAt: { microsSinceUnixEpoch: bigint }) {
  const ms = Number(endsAt.microsSinceUnixEpoch / 1000n);
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

// Downscale to <=size on the long edge AND pad to a centered white SQUARE. The
// drawing canvas is aspect-correct (fills the screen, undistorted); squaring happens
// only here so the AI and the gallery always get a consistent, undistorted square.
function toSquarePng(canvas: HTMLCanvasElement, size = 512): string {
  const w = canvas.width, h = canvas.height;
  const side = Math.max(w, h);
  const scale = Math.min(1, size / side);
  const out = Math.max(1, Math.round(side * scale));
  const oc = document.createElement('canvas');
  oc.width = out; oc.height = out;
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out, out);
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  ctx.drawImage(canvas, 0, 0, w, h, Math.round((out - dw) / 2), Math.round((out - dh) / 2), dw, dh);
  return oc.toDataURL('image/png');
}

// Downscale preserving aspect ratio (NO squaring). Used for the hijack start snapshot:
// the attacker shows it stretched to fill the pad, in the SAME full-area normalized
// space as the streamed strokes, so scribbles line up with the victim's drawing.
function toScaledPng(canvas: HTMLCanvasElement, max = 512): string {
  const w = canvas.width, h = canvas.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
  const oc = document.createElement('canvas');
  oc.width = ow; oc.height = oh;
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ow, oh);
  ctx.drawImage(canvas, 0, 0, ow, oh);
  return oc.toDataURL('image/png');
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Scanline-free stack flood fill with a small tolerance (handles anti-aliased
// stroke edges). Fills the contiguous region under (startX,startY) with `hex`.
function floodFill(ctx: CanvasRenderingContext2D, startX: number, startY: number, hex: string) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const s = (sy * w + sx) * 4;
  const tr = data[s], tg = data[s + 1], tb = data[s + 2], ta = data[s + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  if (tr === fr && tg === fg && tb === fb && ta === 255) return; // already that color
  const tol = 48;
  const stack = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop()!;
    const i = p * 4;
    if (Math.abs(data[i] - tr) > tol || Math.abs(data[i + 1] - tg) > tol ||
        Math.abs(data[i + 2] - tb) > tol || Math.abs(data[i + 3] - ta) > tol) continue;
    data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p < w * (h - 1)) stack.push(p + w);
  }
  ctx.putImageData(img, 0, 0);
}

export default function PlayPage() {
  const { code } = useParams<{ code: string }>();
  const { getConnection, isActive } = useSpacetimeDB();

  // ── Connection resilience (mobile Safari drops/suspends WebSockets) ───────────
  // The SDK does not always auto-resync after iOS suspends or a network blip drops
  // the socket, which leaves a phone frozen on stale data — e.g. it submitted but
  // never receives its own scored drawing / the reveal. We recover by reloading
  // (which reconnects with the persisted token → same identity → fresh snapshot).
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const wasActiveRef = useRef(false);
  useEffect(() => { if (isActive) wasActiveRef.current = true; }, [isActive]);

  // (a) On tab refocus / wake, if the socket is dead, reload to resync.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setTimeout(() => {
        const conn = getConnection();
        if (!isActiveRef.current && !conn?.isActive) window.location.reload();
      }, 1500);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [getConnection]);

  // (b) If the connection DROPS after having been connected (network blip / iOS),
  // give it a few seconds to recover on its own, then reload. Guarded by
  // wasActiveRef so the initial pre-connect window never triggers it.
  useEffect(() => {
    if (isActive || !wasActiveRef.current) return;
    const t = setTimeout(() => {
      const conn = getConnection();
      if (!isActiveRef.current && !conn?.isActive) window.location.reload();
    }, 4000);
    return () => clearTimeout(t);
  }, [isActive, getConnection]);

  // ── Reducers / Procedures ─────────────────────────────────────────────────
  const submitDrawingReducer = useReducer(reducers.submitDrawing);
  const useSabotage           = useReducer(reducers.useSabotage);
  const hijackDraw            = useReducer(reducers.hijackDraw);
  const setHijackCanvas       = useReducer(reducers.setHijackCanvas);
  const peekDraw              = useReducer(reducers.peekDraw);
  const roastInProgress       = useProcedure(procedures.roastInProgress);
  // Scoring is host-driven now (the host screen scores every drawing and reveals).
  // Players just submit and watch their drawing row update via subscription.

  // ── Subscriptions ─────────────────────────────────────────────────────────
  const [rooms]    = useTable(tables.room.where(r => r.code.eq(code)));
  const room       = rooms[0];
  const roomId     = room?.roomId;

  // useTable returns [rows, isReady]. We MUST gate on isReady: rendering before a
  // subscription finishes its initial sync makes `drawings`/`players` momentarily
  // empty, which otherwise paints "No drawing submitted" / a half-empty finished
  // screen (the iOS flakiness — slower sync under weak signal / Low Power Mode).
  const [players, playersReady]   = useTable(tables.player.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [rounds, roundsReady]     = useTable(tables.round.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [drawings, drawingsReady] = useTable(tables.drawing.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  // True once every per-room subscription has completed its initial sync.
  const subsReady = !!roomId && playersReady && roundsReady && drawingsReady;

  // My own identity → my player row
  const conn         = getConnection();
  const myIdentity   = conn?.identity;
  const myPlayer     = players.find(p => myIdentity && p.identity.isEqual(myIdentity));
  const myPlayerId   = myPlayer?.playerId;

  // My active sabotages — time-limited to the fixed hijack window (HIJACK_MS)
  const [mySabotages] = useTable(
    tables.sabotage.where(r => r.toPlayerId.eq(myPlayerId ?? 0n)),
    { enabled: !!myPlayerId }
  );

  // Incoming hijack strokes for a shared board. A board can have many drawers (the
  // victim + N attackers), so we track a SEPARATE last-point per source (from_player_id)
  // — otherwise one drawer's stroke would connect to another's. Replayed by the handler
  // ref (assigned below) through a ref so the closure always sees the latest round.
  const lastBySrcRef    = useRef<Map<string, { x: number; y: number } | null>>(new Map());
  const hijackRenderRef = useRef<((row: { roundId: bigint; fromPlayerId: bigint; pts: string; color: string; size: number }) => void) | null>(null);
  // I subscribe to MY board (to == me): relevant when I'm the victim being hijacked.
  useTable(
    tables.hijack_point.where(r => r.toPlayerId.eq(myPlayerId ?? 0n)),
    { enabled: !!myPlayerId, onInsert: (row) => hijackRenderRef.current?.(row) }
  );

  // Self-grade bonus — the player's guess of their own AI score for this round.
  const submitGuess = useReducer(reducers.submitGuess);
  const [myGuesses] = useTable(tables.guess.where(r => r.playerId.eq(myPlayerId ?? 0n)), { enabled: !!myPlayerId });
  const myGuessRow = myGuesses[0];
  const [guessValue, setGuessValue] = useState(50);
  const guessValueRef = useRef(guessValue); // latest slider value for the auto-lock
  guessValueRef.current = guessValue;

  // Host "Peek" — when active, publish periodic snapshots of my in-progress canvas.
  const [spectateRows] = useTable(tables.spectate.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const spectateActive = spectateRows[0]?.active ?? false;

  // Play Again
  const [replays] = useTable(tables.replay.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const replayOffer = replays[0];
  const [myReplayVotes] = useTable(tables.replay_vote.where(r => r.playerId.eq(myPlayerId ?? 0n)), { enabled: !!myPlayerId });
  const myReplayVote = myReplayVotes[0];
  const voteReplay = useReducer(reducers.voteReplay);
  // Track that we WERE a player this session, so when a replay drops us (room resets
  // to lobby without our row) we can show a "thanks for playing" screen instead of a
  // confusing empty lobby. (A never-joined visitor keeps this false.)
  const wasPlayerRef = useRef(false);
  useEffect(() => { if (myPlayerId != null) wasPlayerRef.current = true; }, [myPlayerId]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const sabotageLifetimeMs = HIJACK_MS; // hijack lasts a fixed 10s
  const activeSabotages = mySabotages.filter(s => {
    if (!s.active) return false;
    const createdMs = Number(s.createdAt.microsSinceUnixEpoch / 1000n);
    return nowMs < createdMs + sabotageLifetimeMs;
  });
  const latestSabotage   = activeSabotages.length > 0
    ? activeSabotages.reduce((a, b) => a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch ? a : b)
    : null;
  const sabotageAttacker = latestSabotage ? players.find(p => p.playerId === latestSabotage.fromPlayerId) : null;
  // Distinct people hijacking me right now — show the name for one, a count for many.
  const attackerCount = new Set(activeSabotages.map(s => s.fromPlayerId.toString())).size;
  const sabotageExpiresMs = latestSabotage
    ? Number(latestSabotage.createdAt.microsSinceUnixEpoch / 1000n) + sabotageLifetimeMs
    : 0;
  const sabotageSecsLeft = Math.max(0, Math.ceil((sabotageExpiresMs - nowMs) / 1000));
  // Am I currently being hijacked? (used to gate the live stream render onto my canvas)
  const hijackOnMe   = activeSabotages.find(s => s.effect === 'hijack');
  const hijackSabId  = hijackOnMe?.sabotageId;

  // ── Current round ─────────────────────────────────────────────────────────
  const currentRound = rounds.find(r => r.roundNumber === room?.currentRound);
  const myDrawing    = drawings.find(d =>
    currentRound != null && myPlayerId != null &&
    d.roundId.toString() === currentRound.roundId.toString() &&
    d.playerId.toString() === myPlayerId.toString()
  );
  // Self-grade bonus state. Guessed this round? (the guess row is per-player, so we
  // match round_id.) Bonus landed when the stored AI score exceeds 100 (only possible
  // when bonused — see record_score_for). aiBase strips the +100 for display.
  const hasGuessedThisRound = !!myGuessRow && currentRound != null &&
    myGuessRow.roundId.toString() === currentRound.roundId.toString();
  const gotBonus = !!myDrawing && myDrawing.aiScore > 100;
  const aiBase   = myDrawing ? (gotBonus ? myDrawing.aiScore - 100 : myDrawing.aiScore) : 0;

  // Auto-lock the self-grade: if you don't tap "Lock in" before the grade window
  // closes, whatever the slider currently shows is submitted for you — so you never
  // miss the bonus just for not tapping. Fires ~1.2s before the deadline so it lands
  // before the host starts AI-scoring. (ends_at is the grade deadline during scoring.)
  useEffect(() => {
    if (room?.status !== 'scoring' || !currentRound || hasGuessedThisRound) return;
    if (myDrawing?.scored && myDrawing.aiScore >= 0) return; // already scored — too late
    const deadlineMs = Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n);
    const delay = Math.max(0, deadlineMs - 1200 - Date.now());
    const t = setTimeout(() => {
      submitGuess({ roundId: currentRound.roundId, value: guessValueRef.current });
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.status, currentRound?.roundId, hasGuessedThisRound]);

  // Confetti on the finished screen (matches the host's celebration).
  useEffect(() => {
    if (room?.status !== 'finished') return;
    playConfetti();
    const end = Date.now() + 2000;
    const colors = ['#FF2E88', '#FFD60A', '#00E08A', '#19D3FF'];
    const frame = () => {
      confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0 }, colors });
      confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, [room?.status]);

  // A celebratory burst the moment YOUR self-grade bonus lands.
  const bonusCelebratedRef = useRef(false);
  useEffect(() => {
    if (gotBonus && !bonusCelebratedRef.current) {
      bonusCelebratedRef.current = true;
      confetti({ particleCount: 130, spread: 90, startVelocity: 45, origin: { y: 0.55 }, colors: ['#00E08A', '#FFD60A', '#FF2E88', '#19D3FF'] });
    } else if (!gotBonus) {
      bonusCelebratedRef.current = false; // re-arm for the next round
    }
  }, [gotBonus]);

  // ── Canvas refs & state ───────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const isDrawing   = useRef(false);
  const lastPos     = useRef<{ x: number; y: number } | null>(null);
  const lastMidPos  = useRef<{ x: number; y: number } | null>(null);

  const [brushColor,    setBrushColor]    = useState('#000000');
  const [brushSize,     setBrushSize]     = useState(1);    // index into BRUSH_SIZES
  const [hasSubmitted,  setHasSubmitted]  = useState(false);
  const [submitting,    setSubmitting]    = useState(false);
  const [countdown,     setCountdown]     = useState(30);
  const [roastText,     setRoastText]     = useState('');
  const [hasRoasted,    setHasRoasted]    = useState(false);
  const [showSabotage,  setShowSabotage]  = useState(false);
  const [sabotageUsed,  setSabotageUsed]  = useState(false); // optimistic hide
  const [sabotageTarget, setSabotageTarget] = useState<bigint | null>(null);

  // ── Attacker hijack state ─────────────────────────────────────────────────
  // While hijackActive, the attacker scribbles on hijackPadRef; points accumulate in
  // hijackBufRef and a flush interval streams them to the victim via hijackDraw.
  const [hijackActive,   setHijackActive]   = useState(false);
  const [hijackVictimId, setHijackVictimId] = useState<bigint | null>(null);
  const [hijackUntil,    setHijackUntil]    = useState(0); // ms epoch the hijack ends
  const [hijackColor,    setHijackColor]    = useState('#000000');
  const hijackColorRef   = useRef(hijackColor);  hijackColorRef.current = hijackColor;
  const hijackPadRef     = useRef<HTMLCanvasElement>(null);
  const hijackPadDrawing = useRef(false);
  const hijackBufRef     = useRef<number[][]>([]); // pending [nx,ny,down] points to flush
  const hijackSeqRef     = useRef(0);
  const hijackPadLastPt  = useRef<{ x: number; y: number } | null>(null);
  const baselineSnapRef  = useRef<string | null>(null); // victim: which hijack we've baselined
  const snapUploadedRef  = useRef<string | null>(null); // victim: which hijack we've snapshotted
  // Victim → attacker: while hijacked, the victim's own strokes also stream back so the
  // attacker sees them draw live (the shared board). Separate buffer/seq from the
  // attacker path. color/size refs carry the victim's current brush at flush time.
  const victimBufRef     = useRef<number[][]>([]);
  const victimSeqRef     = useRef(0);
  const victimColorRef   = useRef('#000000'); // assigned below, once `tool` is in scope
  const victimSizeRef    = useRef(0);
  // Host "Peek": stream my strokes (read-only) so the host can watch me draw live.
  const peekBufRef       = useRef<number[][]>([]);
  const peekSeqRef       = useRef(0);

  // Attacker: the victim's start-of-hijack canvas snapshot (their drawing-so-far),
  // shown as the pad background so the attacker scribbles on the real drawing.
  const [hijackCanvasRows] = useTable(
    tables.hijack_canvas.where(r => r.playerId.eq(hijackVictimId ?? 0n)),
    { enabled: hijackActive && hijackVictimId != null }
  );
  const victimCanvasRow = hijackCanvasRows[0];

  // When I'm an attacker, subscribe to the VICTIM's board (to == victim) so I see the
  // victim's strokes AND every other attacker's — the same shared surface everyone draws
  // on. (A late-joining attacker even replays the strokes already on the board.)
  useTable(
    tables.hijack_point.where(r => r.toPlayerId.eq(hijackVictimId ?? 0n)),
    { enabled: hijackActive && hijackVictimId != null, onInsert: (row) => hijackRenderRef.current?.(row) }
  );

  // Drawing tools
  const [tool, setTool] = useState<'brush' | 'eraser' | 'fill'>('brush');
  // Keep the victim's hijack-stream brush in sync with the current tool/color/size.
  victimColorRef.current = tool === 'eraser' ? '#ffffff' : brushColor;
  victimSizeRef.current  = BRUSH_SIZES[brushSize];
  const undoStack = useRef<ImageData[]>([]);   // snapshots taken BEFORE each action
  const [canUndo, setCanUndo] = useState(false);

  // The canvas FILLS its area (no white margins). To avoid the old aspect-ratio
  // squish, the buffer is sized to the area's ASPECT RATIO at round start (short
  // side = 800 to keep resolution / brush proportions), so what's drawn maps 1:1 to
  // the buffer on every device — no distortion. We only square it up (white padding,
  // centered) at SUBMIT time, so the AI + gallery get a consistent square image
  // without ever showing dead white space while drawing. See the sizing effect below.
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  // "Have I submitted this round?" = our optimistic local flag OR the server's
  // truth (`myDrawing.submitted`). Deriving from the server row means a reload
  // mid-round (a resync, or any watchdog) can NEVER re-show the blank canvas to a
  // player who already submitted — the local-only `hasSubmitted` is lost on reload,
  // which is exactly what made an early submitter see the canvas again. Per-round
  // reset still works: `myDrawing` is scoped to `currentRound`, so a fresh round has
  // no drawing yet → false.
  const alreadySubmitted = hasSubmitted || (myDrawing?.submitted ?? false);

  // ── Sabotage targets ──────────────────────────────────────────────────────
  // Only players who haven't submitted THIS round are valid victims. As each
  // player submits, they drop out of everyone's menu in real time (drawings is a
  // live subscription, so this recomputes on every update). Compare via
  // .toString() to stay consistent with the bigint-comparison rule.
  const submittedPlayerIds = new Set(
    drawings
      .filter(d => currentRound != null && d.roundId.toString() === currentRound.roundId.toString() && d.submitted)
      .map(d => d.playerId.toString())
  );
  const sabotageTargets = players.filter(p =>
    myPlayerId != null &&
    p.playerId.toString() !== myPlayerId.toString() &&
    !submittedPlayerIds.has(p.playerId.toString())
  );
  // If the victim you picked submits before you hit Launch, drop the stale
  // selection so you can never sabotage someone who's already done.
  const submittedKey = [...submittedPlayerIds].sort().join(',');
  useEffect(() => {
    if (sabotageTarget != null && submittedPlayerIds.has(sabotageTarget.toString())) {
      setSabotageTarget(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedKey, sabotageTarget]);

  // Reset per round (UI state only — the canvas buffer is owned by the sizing effect)
  useEffect(() => {
    if (!currentRound) return;
    setHasSubmitted(false);
    setSubmitting(false);
    setRoastText('');
    setHasRoasted(false);
    setShowSabotage(false);
    setTool('brush');
    setGuessValue(50);
    // sabotageUsed intentionally NOT reset — once used it's gone for the whole game
    setHijackActive(false);
    setHijackVictimId(null);
    hijackBufRef.current = [];
    hijackSeqRef.current = 0;
    hijackPadLastPt.current = null;
    lastBySrcRef.current.clear();
    baselineSnapRef.current = null;
    snapUploadedRef.current = null;
    victimBufRef.current = [];
    victimSeqRef.current = 0;
    peekBufRef.current = [];
    peekSeqRef.current = 0;
    lastPos.current = null;
    lastMidPos.current = null;
  }, [currentRound?.roundId]);

  // Size the canvas buffer to the drawing area's ASPECT RATIO (short side = 800),
  // then fill white + clear undo. Runs once per round when in_round mounts — NOT on
  // every reflow, so the sabotage banner appearing/disappearing won't wipe the
  // drawing (the display just stretches a touch while the banner is up). Setting
  // canvas.width/height is what clears the buffer, so we own the white fill here.
  useEffect(() => {
    if (room?.status !== 'in_round' || !currentRound) return;
    const area = canvasAreaRef.current;
    const canvas = canvasRef.current;
    if (!area || !canvas) return;
    const r = area.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const BASE = 800;
    const ratio = Math.max(r.width, r.height) / Math.min(r.width, r.height);
    canvas.width  = r.width >= r.height ? Math.round(BASE * ratio) : BASE;
    canvas.height = r.width >= r.height ? BASE : Math.round(BASE * ratio);
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    undoStack.current = [];
    setCanUndo(false);
  }, [room?.status, currentRound?.roundId]);

  // (c) Post-submit watchdog: once we've submitted, our own drawing should reach a
  // real score within a few seconds (host scores → server reveals; backstop ≤45s).
  // If it hasn't after a generous window, the socket has almost certainly gone stale
  // (the classic iOS "submitted but stuck on scoring / no score" case) — reload to
  // resync. Cleared the moment our score lands, so a healthy phone never reloads.
  useEffect(() => {
    if (!alreadySubmitted) return;
    // Only watch ONCE THE ROUND HAS ENDED (scoring/reveal). While it's still
    // in_round, an early submitter legitimately waits for the others — sometimes for
    // the full round duration — so a not-yet-scored drawing is NOT a stale socket.
    // (This effect used to reload early submitters ~25s in, losing local state and
    // re-showing the blank canvas — the bug this guard fixes.)
    if (room?.status === 'in_round') return;
    if (myDrawing?.scored && myDrawing.aiScore >= 0) return; // already have our score
    // Row missing → a subscription update was likely dropped; resync sooner. Row
    // present but unscored → legit scoring in progress, give it longer.
    const delay = myDrawing ? 25000 : 7000;
    const t = setTimeout(() => {
      if (!(myDrawing?.scored && myDrawing.aiScore >= 0)) window.location.reload();
    }, delay);
    return () => clearTimeout(t);
  }, [alreadySubmitted, room?.status, myDrawing?.drawingId, myDrawing?.scored, myDrawing?.aiScore]);

  // Countdown — freeze when submitted
  useEffect(() => {
    if (!currentRound || room?.status !== 'in_round' || alreadySubmitted) return;
    const tick = () => setCountdown(getSecondsLeft(currentRound.endsAt));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [currentRound?.roundId, room?.status, alreadySubmitted]);

  // ── Sound: while-drawing ambient loop during the round (until you submit) ─────
  useEffect(() => {
    if (room?.status === 'in_round' && currentRound && !alreadySubmitted) {
      startDrawingMusic();
      return () => stopDrawingMusic();
    }
  }, [room?.status, currentRound?.roundId, alreadySubmitted]);

  // ── Sound: countdown (final 5s) scheduled to end at 0, ducking the ambient ────
  useEffect(() => {
    stopCountdown();
    duckDrawingMusic(false);
    if (room?.status !== 'in_round' || !currentRound || alreadySubmitted) return;
    const endsMs = Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n);
    const delay = endsMs - COUNTDOWN_CLIP_MS - Date.now();
    if (delay <= -COUNTDOWN_CLIP_MS) return; // already past the countdown window
    const t = setTimeout(() => { startCountdown(); duckDrawingMusic(true); }, Math.max(0, delay));
    return () => { clearTimeout(t); stopCountdown(); duckDrawingMusic(false); };
  }, [room?.status, currentRound?.roundId, alreadySubmitted]);

  // ── Sound: sad trombone when the Hall of Shame scrolls into view (finished) ───
  const hallRef = useRef<HTMLDivElement>(null);
  const trombonePlayed = useRef(false);
  useEffect(() => {
    if (room?.status !== 'finished') { trombonePlayed.current = false; return; }
    const el = hallRef.current;
    if (!el || trombonePlayed.current) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !trombonePlayed.current) {
          trombonePlayed.current = true;
          playTrombone();
          obs.disconnect();
        }
      }
    }, { threshold: 0.25 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [room?.status, drawings]);


  // Auto-submit when time is nearly up. Fire at <=1s (NOT exactly 0): at 0 the round
  // can flip to 'scoring' and unmount the canvas before handleSubmit grabs it, losing
  // the drawing. At 1s we're still in_round (canvas mounted) so the capture is
  // reliable; the upload finishes a beat later and the server's grace window
  // (end_round leaves a pending placeholder) accepts the late landing and AI-scores it.
  useEffect(() => {
    if (countdown <= 1 && !alreadySubmitted && currentRound && myPlayer && room?.status === 'in_round') {
      handleSubmit();
    }
  }, [countdown]);

  // Mid-round roast at ~15s
  useEffect(() => {
    if (!currentRound || hasRoasted) return;
    const endsAtMs   = Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n);
    const startedAtMs = Number(currentRound.startedAt.microsSinceUnixEpoch / 1000n);
    const roastAtMs  = startedAtMs + (endsAtMs - startedAtMs) / 2;
    const delay      = Math.max(0, roastAtMs - Date.now());
    const timer = setTimeout(async () => {
      if (alreadySubmitted) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dataUrl = toSquarePng(canvas);
      const b64 = dataUrl.split(',')[1];
      const line = await roastInProgress({ imageBase64: b64, word: currentRound.word }).catch(() => '');
      if (line) { setRoastText(line); setTimeout(() => setRoastText(''), 6000); }
      setHasRoasted(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [currentRound?.roundId, hasRoasted]);

  // ── Submit flow ───────────────────────────────────────────────────────────
  // Upload the drawing + record the submission. Scoring is handled by the host
  // (it scores every drawing and reveals); this client just watches myDrawing.
  const handleSubmit = useCallback(async () => {
    if (hasSubmitted || submitting || !currentRound || !myPlayer) return;
    setSubmitting(true);
    setHasSubmitted(true);

    const canvas = canvasRef.current;
    if (!canvas) { setSubmitting(false); return; }

    const dataUrl  = toSquarePng(canvas);
    const secsLeft = getSecondsLeft(currentRound.endsAt);

    // Upload with retries — iOS Safari (esp. Low Power Mode / weak signal) drops the
    // Supabase HTTP upload, which used to silently submit imageUrl='' → "score with
    // no drawing". Retry a few times before giving up.
    let imageUrl = '';
    try {
      const blob = await (await fetch(dataUrl)).blob();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          imageUrl = await uploadDrawing(code, currentRound.roundId.toString(), myPlayer.playerId.toString(), blob);
          break;
        } catch (e) {
          console.warn(`[submit] upload attempt ${attempt + 1} failed`, e);
          if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        }
      }
    } catch (e) {
      console.warn('[submit] could not build/upload image', e);
    }

    submitDrawingReducer({ roundId: currentRound.roundId, imageUrl, secondsLeft: secsLeft });
    setSubmitting(false);
  }, [hasSubmitted, submitting, currentRound, myPlayer, code, submitDrawingReducer]);

  // ── Undo ──────────────────────────────────────────────────────────────────
  // Snapshot the canvas BEFORE each action (stroke / fill / clear); undo restores
  // the most recent snapshot. ImageData is synchronous and reliable; capped so the
  // stack can't blow up phone memory.
  const snapshot = useCallback(() => {
    const c = canvasRef.current; const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    try {
      undoStack.current.push(ctx.getImageData(0, 0, c.width, c.height));
      if (undoStack.current.length > 12) undoStack.current.shift();
      setCanUndo(true);
    } catch { /* getImageData can throw if tainted — never for our own draws */ }
  }, []);

  const undo = useCallback(() => {
    const c = canvasRef.current; const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const prev = undoStack.current.pop();
    if (prev) ctx.putImageData(prev, 0, 0);
    setCanUndo(undoStack.current.length > 0);
  }, []);

  // ── Hijack: live-render incoming strokes (shared board) ─────────────────────
  // Replay each incoming batch as it arrives. Roles are mutually exclusive (you must
  // have submitted to attack, and a victim hasn't submitted), so: if I'm attacking,
  // incoming = my victim's strokes → draw on the pad; otherwise I'm a victim and
  // incoming = the attacker's scribbles → draw on my canvas. Gated on the current
  // round + in_round. Reassigned every render so the closure sees the latest state.
  hijackRenderRef.current = (row) => {
    if (room?.status !== 'in_round' || !currentRound) return;
    if (row.roundId.toString() !== currentRound.roundId.toString()) return;
    // Skip my own strokes echoed back from the board — I already drew them locally.
    if (myPlayerId != null && row.fromPlayerId.toString() === myPlayerId.toString()) return;
    const target = hijackActive ? hijackPadRef.current : canvasRef.current;
    const key = row.fromPlayerId.toString();
    const holder = { current: lastBySrcRef.current.get(key) ?? null };
    drawHijackBatch(target, row, holder);
    lastBySrcRef.current.set(key, holder.current);
  };

  // The first time a hijack lands on me, snapshot the canvas so a single Undo can wipe
  // the vandalism (the scribbles are otherwise permanent marks on the canvas).
  useEffect(() => {
    if (!hijackSabId) return;
    const key = hijackSabId.toString();
    if (baselineSnapRef.current === key) return;
    baselineSnapRef.current = key;
    snapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hijackSabId]);

  // Victim: when a hijack lands, upload ONE snapshot of my current drawing so the
  // attacker can scribble on top of the real thing (it's their pad background). The
  // live evolution after this is covered by the victim→attacker stroke stream below.
  useEffect(() => {
    if (!hijackSabId || !currentRound || !myPlayer) return;
    const key = hijackSabId.toString();
    if (snapUploadedRef.current === key) return;
    snapUploadedRef.current = key;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = toScaledPng(canvas);
    const roundId = currentRound.roundId;
    const playerId = myPlayer.playerId.toString();
    (async () => {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        const url = await uploadHijackCanvas(code, roundId.toString(), playerId, blob);
        setHijackCanvas({ roundId, imageUrl: url });
      } catch (e) { console.warn('[hijack] snapshot upload failed', e); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hijackSabId]);

  // Victim: stream my own strokes to MY board (to == me) ~11x/sec so every attacker on
  // it sees me draw live. Stops when the hijack ends or I submit (buffer empties).
  useEffect(() => {
    if (!hijackOnMe || !currentRound || myPlayerId == null) return;
    const boardId = myPlayerId;
    const roundId = currentRound.roundId;
    const send = () => {
      const canvas = canvasRef.current;
      if (!canvas || victimBufRef.current.length === 0) return;
      const batch = victimBufRef.current; victimBufRef.current = [];
      victimSeqRef.current += 1;
      hijackDraw({
        roundId, toPlayerId: boardId, seq: victimSeqRef.current,
        pts: JSON.stringify(batch), color: victimColorRef.current,
        size: victimSizeRef.current / Math.min(canvas.width, canvas.height),
      });
    };
    const id = setInterval(send, 90);
    return () => { send(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hijackOnMe?.sabotageId, currentRound?.roundId, myPlayerId]);

  // ── Hijack: attacker pad (draw locally + stream batches to the victim) ──────
  const hijackNorm = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = hijackPadRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const onHijackPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = hijackPadRef.current; if (!el) return;
    el.setPointerCapture(e.pointerId);
    hijackPadDrawing.current = true;
    const [nx, ny] = hijackNorm(e);
    hijackBufRef.current.push([nx, ny, 1]);
    drawHijackBatch(el, { pts: JSON.stringify([[nx, ny, 1]]), color: hijackColorRef.current, size: HIJACK_SIZE_FRAC }, hijackPadLastPt);
  };
  const onHijackPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hijackPadDrawing.current) return;
    const el = hijackPadRef.current; if (!el) return;
    const [nx, ny] = hijackNorm(e);
    hijackBufRef.current.push([nx, ny, 0]);
    drawHijackBatch(el, { pts: JSON.stringify([[nx, ny, 0]]), color: hijackColorRef.current, size: HIJACK_SIZE_FRAC }, hijackPadLastPt);
  };
  const onHijackPointerUp = () => { hijackPadDrawing.current = false; hijackPadLastPt.current = null; };

  // While hijacking, flush buffered points to the victim ~11x/sec and auto-end at
  // HIJACK_MS. The reducer rejects anything outside the server's 10s window.
  useEffect(() => {
    if (!hijackActive || hijackVictimId == null || !currentRound) return;
    const roundId = currentRound.roundId;
    const send = () => {
      if (hijackBufRef.current.length === 0) return;
      const batch = hijackBufRef.current; hijackBufRef.current = [];
      hijackSeqRef.current += 1;
      hijackDraw({ roundId, toPlayerId: hijackVictimId, seq: hijackSeqRef.current, pts: JSON.stringify(batch), color: hijackColorRef.current, size: HIJACK_SIZE_FRAC });
    };
    const flushId = setInterval(send, 90);
    const endId = setTimeout(() => { send(); setHijackActive(false); }, HIJACK_MS);
    return () => { clearInterval(flushId); clearTimeout(endId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hijackActive, hijackVictimId, currentRound?.roundId]);

  // Attacker: end the hijack the instant the victim submits — no point drawing on a
  // locked-in canvas (the server stops accepting strokes too).
  useEffect(() => {
    if (!hijackActive || hijackVictimId == null || !currentRound) return;
    const victimSubmitted = drawings.some(d =>
      d.roundId.toString() === currentRound.roundId.toString() &&
      d.playerId.toString() === hijackVictimId.toString() && d.submitted
    );
    if (victimSubmitted) setHijackActive(false);
  }, [hijackActive, hijackVictimId, drawings, currentRound?.roundId]);

  // Host "Peek": while the host is peeking and I'm still drawing, stream my strokes
  // (read-only) ~8x/sec so the host can watch me draw live — same mechanism as hijack,
  // not snapshots. Runs only when the host toggled peek on (spectateActive).
  useEffect(() => {
    if (!spectateActive || room?.status !== 'in_round' || !currentRound || alreadySubmitted || myPlayerId == null) return;
    const roundId = currentRound.roundId;
    const send = () => {
      const canvas = canvasRef.current;
      if (!canvas || peekBufRef.current.length === 0) return;
      const batch = peekBufRef.current; peekBufRef.current = [];
      peekSeqRef.current += 1;
      peekDraw({
        roundId, seq: peekSeqRef.current,
        pts: JSON.stringify(batch), color: victimColorRef.current,
        size: victimSizeRef.current / Math.min(canvas.width, canvas.height),
      });
    };
    const id = setInterval(send, 120);
    return () => { send(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spectateActive, room?.status, currentRound?.roundId, alreadySubmitted, myPlayerId]);

  // Stream a non-stroke op (Clear / Fill) to the host's live Peek, in order: flush any
  // pending stroke points first so the op lands after them in the replay. '!clear' wipes
  // the canvas; '!fill:<hex>' flood-fills. (Eraser & color changes already ride the
  // normal stroke batches.) No-op when the host isn't peeking.
  const peekSendOp = (color: string, pts: string) => {
    if (!spectateActive || !currentRound || myPlayerId == null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (peekBufRef.current.length) {
      const batch = peekBufRef.current; peekBufRef.current = [];
      peekSeqRef.current += 1;
      peekDraw({ roundId: currentRound.roundId, seq: peekSeqRef.current, pts: JSON.stringify(batch), color: victimColorRef.current, size: victimSizeRef.current / Math.min(canvas.width, canvas.height) });
    }
    peekSeqRef.current += 1;
    peekDraw({ roundId: currentRound.roundId, seq: peekSeqRef.current, pts, color, size: 0 });
  };

  // ── Canvas drawing ────────────────────────────────────────────────────────
  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvasRef.current!.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvasRef.current!.height / rect.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (alreadySubmitted) return;
    const pos = getPos(e);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    // Fill bucket: a tap floods the region under it; no stroke.
    if (tool === 'fill') {
      snapshot();
      floodFill(ctx, pos.x, pos.y, brushColor);
      if (spectateActive) {
        const c = canvasRef.current!;
        peekSendOp('!fill:' + brushColor, JSON.stringify([[pos.x / c.width, pos.y / c.height]]));
      }
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawing.current = true;
    snapshot();                       // capture pre-stroke state for undo
    lastPos.current = pos;
    lastMidPos.current = pos;
    // Draw a dot at the touch point so single taps register
    const size  = BRUSH_SIZES[brushSize];
    const color = tool === 'eraser' ? '#ffffff' : brushColor;
    ctx.fillStyle   = color;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    // Stream this stroke to anyone watching: the hijack board (if I'm hijacked) and/or
    // the host's live Peek (if the host is peeking). Both use normalized coords.
    if (hijackOnMe || spectateActive) {
      const c = canvasRef.current!;
      const nx = pos.x / c.width, ny = pos.y / c.height;
      if (hijackOnMe) victimBufRef.current.push([nx, ny, 1]);
      if (spectateActive) peekBufRef.current.push([nx, ny, 1]);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || alreadySubmitted) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !lastPos.current || !lastMidPos.current) return;

    const pos   = getPos(e);
    const size  = BRUSH_SIZES[brushSize];
    const color = tool === 'eraser' ? '#ffffff' : brushColor;
    const mid   = { x: (lastPos.current.x + pos.x) / 2, y: (lastPos.current.y + pos.y) / 2 };

    ctx.strokeStyle = color;
    ctx.lineWidth   = size;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.moveTo(lastMidPos.current.x, lastMidPos.current.y);
    ctx.quadraticCurveTo(lastPos.current.x, lastPos.current.y, mid.x, mid.y);
    ctx.stroke();

    if (hijackOnMe || spectateActive) {
      const c = canvasRef.current!;
      const nx = pos.x / c.width, ny = pos.y / c.height;
      if (hijackOnMe) victimBufRef.current.push([nx, ny, 0]);
      if (spectateActive) peekBufRef.current.push([nx, ny, 0]);
    }

    lastMidPos.current = mid;
    lastPos.current    = pos;
  };

  const onPointerUp = () => {
    isDrawing.current  = false;
    lastPos.current    = null;
    lastMidPos.current = null;
  };

  const clearCanvas = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !canvasRef.current) return;
    snapshot();                       // clear is undoable
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    if (spectateActive) peekSendOp('!clear', '[]');  // mirror the wipe on the host Peek
  };

  // ── Self-grade bonus panel (shown after submit, until locked or scored) ─────
  const guessPanel = currentRound ? (
    hasGuessedThisRound ? (
      <div className="flex flex-col items-center gap-0.5">
        <p className="font-display font-bold uppercase text-xs tracking-wide text-white/60">Your guess is locked</p>
        <p className="font-display font-black text-4xl text-[var(--cyan)] leading-none">{myGuessRow!.value}</p>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 w-full max-w-[280px] bg-[var(--surface)]/90 border-4 border-black rounded-2xl px-4 py-3 shadow-[6px_6px_0_0_#000]">
        <p className="font-display font-black uppercase text-base text-[var(--yellow)] text-center leading-tight">Guess your AI score</p>
        <p className="font-display font-black text-6xl text-white leading-none tabular-nums">{guessValue}</p>
        <input type="range" min={0} max={100} value={guessValue}
          onChange={e => setGuessValue(Number(e.target.value))}
          className="w-full accent-[var(--magenta)]" />
        <BrutalButton color="yellow" size="md" className="w-full" onClick={() => submitGuess({ roundId: currentRound.roundId, value: guessValue })}>
          Lock in
        </BrutalButton>
        <p className="text-[11px] text-white/55 font-display text-center leading-tight">Nail it within ±5 (AI ≥ 20) for a <span className="text-[var(--green)] font-bold">+100 BONUS</span></p>
      </div>
    )
  ) : null;

  // ── Render: Loading ───────────────────────────────────────────────────────
  if (!room) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center flex flex-col items-center gap-4">
          <div className="spinner" style={{ margin: 0 }} />
          <p className="font-display uppercase tracking-widest text-[var(--cyan)]">Connecting…</p>
        </div>
      </div>
    );
  }

  // Don't render any game screen until the room's subscriptions have synced —
  // otherwise a slow (iOS) initial sync paints wrong states off empty data
  // ("No drawing submitted", half-empty finished screen). The lobby is exempt:
  // there are no drawings/rounds yet and players stream in live.
  if (room.status !== 'lobby' && !subsReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center flex flex-col items-center gap-4">
          <div className="spinner" style={{ margin: 0 }} />
          <p className="font-display uppercase tracking-widest text-[var(--cyan)]">Syncing…</p>
        </div>
      </div>
    );
  }

  // ── LOBBY ─────────────────────────────────────────────────────────────────
  if (room.status === 'lobby') {
    // Dropped by a Play Again (we were a player, but our row is gone) → don't show a
    // confusing empty lobby; offer to rejoin.
    if (!myPlayer && wasPlayerRef.current) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6 text-center">
          <h1 className="font-display font-black uppercase tracking-wide text-3xl text-white">Thanks for playing!</h1>
          <p className="font-display text-white/60 max-w-xs">The next game is starting without you — jump back in if you changed your mind.</p>
          <BrutalButton color="magenta" size="lg" onClick={() => { window.location.href = `/join/${code}`; }}>
            Rejoin
          </BrutalButton>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
        <h1 className="font-display font-black uppercase tracking-[0.12em] text-5xl text-[var(--magenta)] leading-none">{code}</h1>
        <BrutalCard
          color="cyan"
          shadowColor="#007594"
          className="!py-3 !px-5"
          animate={{ rotate: [-1.5, 1.5, -1.5] }}
          transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
        >
          <p className="font-display font-bold uppercase tracking-wide text-[#0E0E16]">Waiting for the host to start…</p>
        </BrutalCard>
        <div className="flex flex-col gap-2.5 w-full max-w-[360px]">
          {players.map((p, i) => (
            <BrutalCard
              key={p.playerId.toString()}
              color="surface"
              className="!p-3 flex items-center gap-3 !rounded-2xl"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20, delay: i * 0.04 }}
            >
              <div className="w-4 h-4 rounded-full border-2 border-black flex-none" style={{ background: p.avatarColor }} />
              <span className="flex-1 font-display font-bold text-white">{p.nickname}</span>
              {p.isHost && <span className="badge">host</span>}
              {!!myIdentity && p.identity.isEqual(myIdentity) && <span className="text-xs font-display uppercase text-[var(--yellow)]">(you)</span>}
            </BrutalCard>
          ))}
        </div>
      </div>
    );
  }

  // ── DRAWING ───────────────────────────────────────────────────────────────
  if (room.status === 'in_round' && currentRound) {
    const countColor = alreadySubmitted ? 'text-[var(--green)]' : countdown <= 5 ? 'text-[var(--red)]' : countdown <= 10 ? 'text-[var(--yellow)]' : 'text-white';
    const hijackVictim = hijackVictimId != null ? players.find(p => p.playerId.toString() === hijackVictimId.toString()) : null;
    const hijackSecsLeft = Math.max(0, Math.ceil((hijackUntil - nowMs) / 1000));

    return (
      <div className="w-full flex flex-col bg-[var(--canvas)]" style={{ height: '100svh', overflow: 'hidden', userSelect: 'none' }}>
        {/* Top bar */}
        <div className="flex items-center gap-4 px-5 py-4 bg-[var(--surface)] border-b-4 border-black flex-none">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-display uppercase tracking-widest text-[var(--cyan)]">Draw:</p>
            <p className="text-3xl font-display font-black uppercase tracking-wide text-white truncate">{currentRound.word}</p>
          </div>
          <div className={`text-5xl font-display font-black leading-none min-w-[64px] text-right transition-colors ${countColor}`}>
            {alreadySubmitted ? 'IN' : countdown}
          </div>
        </div>

        {/* Sabotage banner — shows who hit you, what effect, and countdown */}
        {latestSabotage && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 flex-none bg-[var(--red)] border-b-4 border-[#8A0000] text-white font-display font-bold text-sm">
            <span>{attackerCount > 1
              ? `${attackerCount} people are hijacking your board!`
              : `${sabotageAttacker?.nickname ?? 'Someone'} hit you — ${EFFECT_LABELS[latestSabotage.effect] ?? 'Sabotage'}!`}</span>
            <span className="bg-black/30 rounded-full px-2.5 py-0.5 tabular-nums flex-none border-2 border-black">
              {sabotageSecsLeft}s
            </span>
          </div>
        )}

        {/* Canvas area — canvas FILLS this box; buffer aspect matches it (see sizing effect) */}
        <div ref={canvasAreaRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#fff', display: 'flex', alignItems: 'flex-start' }}>
          <canvas
            ref={canvasRef}
            width={800}
            height={800}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ width: '100%', height: '100%', touchAction: 'none', cursor: alreadySubmitted ? 'default' : tool === 'fill' ? 'cell' : 'crosshair', display: 'block' }}
          />

          {/* Attacker hijack pad — fills the canvas area while you control a victim's board */}
          {hijackActive && (
            <div className="absolute inset-0 z-20 flex flex-col bg-[var(--canvas)]">
              <div className="flex items-center justify-between gap-3 px-4 py-2 flex-none bg-[var(--red)] border-b-4 border-[#8A0000] text-white font-display font-black uppercase text-sm">
                <span>Hijacking {hijackVictim?.nickname ?? 'their'} board — scribble!</span>
                <span className="bg-black/30 rounded-full px-2.5 py-0.5 tabular-nums flex-none border-2 border-black">{hijackSecsLeft}s</span>
              </div>
              <div className="flex-1 relative bg-white overflow-hidden">
                {/* The victim's drawing-so-far (start snapshot), stretched to fill the
                    pad in the same normalized space the strokes use → things line up. */}
                {victimCanvasRow?.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${victimCanvasRow.imageUrl}?t=${victimCanvasRow.updatedAt.microsSinceUnixEpoch.toString()}`}
                    alt=""
                    className="absolute inset-0 w-full h-full pointer-events-none select-none"
                    style={{ objectFit: 'fill' }}
                  />
                )}
                <canvas
                  ref={hijackPadRef}
                  width={600}
                  height={800}
                  onPointerDown={onHijackPointerDown}
                  onPointerMove={onHijackPointerMove}
                  onPointerUp={onHijackPointerUp}
                  onPointerLeave={onHijackPointerUp}
                  className="relative z-10"
                  style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair', display: 'block' }}
                />
              </div>
              <div className="flex gap-2 px-3 py-2 flex-none bg-[var(--surface)] border-t-4 border-black justify-center items-center">
                {HIJACK_COLORS.map(c => (
                  <button key={c} onClick={() => setHijackColor(c)} style={{ background: c }}
                    className={`w-9 h-9 rounded-full flex-none border-[3px] shadow-[2px_2px_0_0_#000] transition-transform ${
                      hijackColor === c ? 'border-white scale-110' : 'border-black'
                    }`} />
                ))}
              </div>
            </div>
          )}

          {/* Roast strip */}
          {roastText && (
            <div className="absolute bottom-3 left-3 right-3 bg-[var(--cyan)] text-[#0E0E16] border-4 border-black rounded-2xl px-4 py-2 text-sm font-display font-bold italic text-center shadow-[4px_4px_0_0_#007594]">
              {roastText}
            </div>
          )}

          {/* Submitted overlay */}
          {alreadySubmitted && (() => {
            const roundDrawings = drawings.filter(d => d.roundId === currentRound.roundId && d.submitted);
            const waitingFor = players.length - roundDrawings.length;
            return (
              <div className="absolute inset-0 bg-[var(--canvas)]/85 flex items-center justify-center z-[5] p-4 overflow-y-auto">
                <div className="text-center flex flex-col items-center gap-3 my-auto">
                  <p className="font-display font-black uppercase text-2xl text-[var(--green)] leading-none">Submitted!</p>
                  {guessPanel}
                  {waitingFor > 0 && (
                    <p className="text-sm text-white/70 font-display">
                      Waiting for {waitingFor} more player{waitingFor > 1 ? 's' : ''}…
                    </p>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Bottom tools */}
        <div className="bg-[var(--surface)] border-t-4 border-black flex-none">
          {!alreadySubmitted ? (
            <div className="max-w-[900px] mx-auto w-full">
              {/* Colors — compact so there's more room to draw on phones. Picking a
                  color keeps Fill selected (color is a modifier); only Eraser flips
                  back to Pen, since the eraser ignores color. */}
              <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-0.5 justify-center">
                {COLORS.map(c => (
                  <button key={c} onClick={() => { setBrushColor(c); setTool(t => t === 'eraser' ? 'brush' : t); }}
                    style={{ background: c }}
                    className={`w-7 h-7 rounded-full flex-none transition-transform border-[3px] shadow-[2px_2px_0_0_#000] ${
                      brushColor === c && tool !== 'eraser' ? 'border-white scale-110' : 'border-black'
                    }`} />
                ))}
              </div>
              {/* Brush sizes + tools */}
              <div className="flex flex-wrap gap-2 px-3 pt-1.5 pb-1 items-center">
                {BRUSH_SIZES.map((_, i) => (
                  <button key={i} onClick={() => setBrushSize(i)}
                    className={`w-10 h-10 rounded-xl border-[3px] border-black shadow-[2px_2px_0_0_#000] flex items-center justify-center transition-colors ${
                      brushSize === i ? 'bg-[var(--cyan)]' : 'bg-[var(--surface)]'
                    }`}>
                    <div className="rounded-full" style={{ width: 5 + i * 5, height: 5 + i * 5, background: brushSize === i ? '#0E0E16' : '#fff' }} />
                  </button>
                ))}
                {/* Tools: pen / eraser / fill / undo */}
                <div className="w-px h-7 bg-black/30 mx-0.5" />
                {([['brush','Pen'],['eraser','Erase'],['fill','Fill']] as const).map(([t, label]) => (
                  <button key={t} onClick={() => setTool(t)}
                    className={`h-10 px-3 rounded-xl border-[3px] border-black shadow-[2px_2px_0_0_#000] flex items-center justify-center font-display font-black uppercase text-sm transition-colors ${
                      tool === t ? 'bg-[var(--cyan)] text-[#0E0E16]' : 'bg-[var(--surface)] text-white'
                    }`}>
                    {label}
                  </button>
                ))}
                <button onClick={undo} disabled={!canUndo}
                  className={`h-10 px-3 rounded-xl border-[3px] border-black shadow-[2px_2px_0_0_#000] flex items-center justify-center font-display font-black uppercase text-sm bg-[var(--surface)] text-white transition-opacity ${
                    canUndo ? '' : 'opacity-35'
                  }`}>
                  Undo
                </button>
              </div>
              {/* Actions */}
              <div className="flex gap-3 px-4 pt-1.5 pb-3 items-center justify-end">
                <BrutalButton color="surface" size="md" onClick={clearCanvas}>Clear</BrutalButton>
                <BrutalButton color="magenta" size="md" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? '…' : 'Submit'}
                </BrutalButton>
              </div>
            </div>
          ) : (
            // Sabotage section — Board Hijack: seize a not-yet-submitted player's canvas
            <div className="p-5 max-w-[900px] mx-auto w-full">
              {myPlayer?.sabotageAvailable && !sabotageUsed && !showSabotage && (
                <BrutalButton color="red" size="lg" onClick={() => setShowSabotage(true)} className="w-full">
                  Hijack a Board
                </BrutalButton>
              )}
              {showSabotage && (
                <div className="flex flex-col gap-4">
                  <p className="font-display font-black uppercase tracking-wide text-base text-[var(--red)]">Hijack whose board?</p>
                  <p className="text-sm text-white/55 font-display -mt-2">Seize their canvas and scribble on it for 10 seconds.</p>
                  <div className="flex gap-3 flex-wrap">
                    {(() => {
                      if (sabotageTargets.length === 0) return <p className="text-base text-white/50 font-display">Everyone already submitted — no targets!</p>;
                      return sabotageTargets.map(p => (
                        <button key={p.playerId.toString()} onClick={() => setSabotageTarget(p.playerId)}
                          className={`flex items-center gap-2 px-5 py-3 rounded-full font-display font-bold uppercase text-base border-[3px] border-black shadow-[3px_3px_0_0_#000] transition-transform hover:scale-105 active:scale-95 ${
                            sabotageTarget === p.playerId ? 'bg-[var(--red)] text-white' : 'bg-[var(--surface)] text-white'
                          }`}>
                          <span className="inline-block w-3 h-3 rounded-full border-2 border-black" style={{ background: p.avatarColor }} />
                          {p.nickname}
                        </button>
                      ));
                    })()}
                  </div>
                  <div className="flex gap-3 mt-1">
                    <BrutalButton color="red" size="lg" disabled={!sabotageTarget || sabotageUsed} className="flex-1"
                      onClick={() => {
                        if (!sabotageTarget || !currentRound || sabotageUsed) return;
                        // Guard: never fire at a player who has since submitted.
                        if (!sabotageTargets.some(p => p.playerId.toString() === sabotageTarget.toString())) return;
                        setSabotageUsed(true);      // optimistic: hide immediately, block double-fire
                        setShowSabotage(false);
                        // Open the local hijack pad immediately + spend the sabotage; the
                        // stream/flush effect starts sending strokes to the victim.
                        setHijackVictimId(sabotageTarget);
                        setHijackUntil(Date.now() + HIJACK_MS);
                        setHijackActive(true);
                        useSabotage({ roundId: currentRound.roundId, targetPlayerId: sabotageTarget, effect: 'hijack' });
                      }}>
                      Hijack Board
                    </BrutalButton>
                    <BrutalButton color="surface" size="lg" onClick={() => setShowSabotage(false)} className="flex-1">Cancel</BrutalButton>
                  </div>
                </div>
              )}
              {!myPlayer?.sabotageAvailable && !hijackActive && (
                <p className="text-base text-white/50 text-center py-2 font-display uppercase">Sabotage already used</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── SCORING ───────────────────────────────────────────────────────────────
  if (room.status === 'scoring') {
    const scored = !!myDrawing?.scored && myDrawing.aiScore >= 0;
    // During the grade window, ends_at is the grade deadline.
    const gradeSecsLeft = currentRound
      ? Math.max(0, Math.ceil((Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n) - nowMs) / 1000))
      : 0;
    const grading = !scored && gradeSecsLeft > 0;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        {scored ? (
          <BrutalCard
            color={gotBonus ? 'green' : 'surface'}
            className="text-center flex flex-col items-center gap-1"
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 240, damping: 14 }}
          >
            {gotBonus && <p className="font-display font-black uppercase text-lg text-[#0E0E16] animate-pulse">BONUS! +100</p>}
            <p className={`text-sm font-display uppercase tracking-wide ${gotBonus ? 'text-[#0E0E16]/70' : 'text-white/60'}`}>Your score</p>
            <p className="font-display font-black text-5xl text-[var(--yellow)]"><CountUp value={myDrawing!.roundScore} /></p>
            <p className={`text-sm font-display ${gotBonus ? 'text-[#0E0E16]/80' : 'text-white/60'}`}>
              AI: <strong className={gotBonus ? 'text-[#0E0E16]' : 'text-white'}>{aiBase}</strong>{gotBonus && <strong className="text-[var(--magenta)]"> +100</strong>}{' + '}Speed: <strong className={gotBonus ? 'text-[#0E0E16]' : 'text-white'}>{myDrawing!.roundScore - myDrawing!.aiScore}</strong>
            </p>
            {myDrawing!.aiGuess && <p className={`text-sm mt-1 font-display ${gotBonus ? 'text-[#0E0E16]' : 'text-[var(--cyan)]'}`}>AI guessed: “{myDrawing!.aiGuess}”</p>}
            {myDrawing!.aiRoast && <p className={`italic text-sm mt-1 ${gotBonus ? 'text-[#0E0E16]/80' : 'text-white/70'}`}>“{myDrawing!.aiRoast}”</p>}
          </BrutalCard>
        ) : grading ? (
          <>
            <p className="font-display font-black uppercase tracking-widest text-xl text-[var(--yellow)] text-center">How did you do?</p>
            <p className="font-display font-black text-2xl text-white tabular-nums">{gradeSecsLeft}s to lock in</p>
            {guessPanel}
          </>
        ) : (
          <>
            <div className="spinner" style={{ margin: 0 }} />
            <p className="font-display font-black uppercase tracking-widest text-xl text-[var(--cyan)] text-center">The AI is judging your masterpiece…</p>
            {hasGuessedThisRound && guessPanel}
          </>
        )}
      </div>
    );
  }

  // ── REVEAL ────────────────────────────────────────────────────────────────
  if (room.status === 'reveal') {
    const rank = [...players].sort((a, b) => b.totalScore - a.totalScore).findIndex(p => p.playerId === myPlayerId) + 1;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 p-6 text-center">
        <h2 className="font-display font-black uppercase tracking-widest text-2xl text-white">Round {room.currentRound} Results</h2>
        {!myPlayerId ? (
          <div className="flex flex-col items-center gap-3">
            <div className="spinner" style={{ margin: 0 }} />
            <p className="text-white/50 font-display uppercase tracking-wide">Loading your results…</p>
          </div>
        ) : myDrawing && myDrawing.aiScore < 0 ? (
          <div className="flex flex-col items-center gap-3">
            <div className="spinner" style={{ margin: 0 }} />
            <p className="text-[var(--cyan)] font-display uppercase tracking-wide">Finalizing your score…</p>
          </div>
        ) : myDrawing ? (
          <BrutalCard
            color={gotBonus ? 'green' : 'surface'}
            className="max-w-[340px] w-full flex flex-col gap-3 items-center"
            initial={{ opacity: 0, y: 24, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 240, damping: 16 }}
          >
            {gotBonus && <p className="font-display font-black uppercase text-xl text-[#0E0E16] animate-pulse">BONUS! +100</p>}
            {myDrawing.imageUrl && <img src={myDrawing.imageUrl} alt="your drawing" className="w-full rounded-xl max-h-[200px] object-contain bg-white border-4 border-black" />}
            <p className="font-display font-black text-5xl text-[var(--yellow)]"><CountUp value={myDrawing.roundScore} /> pts</p>
            <p className={`text-sm font-display ${gotBonus ? 'text-[#0E0E16]/80' : 'text-white/60'}`}>
              AI: <strong className={gotBonus ? 'text-[#0E0E16]' : 'text-white'}>{aiBase}</strong>{gotBonus && <strong className="text-[var(--magenta)]"> +100</strong>}{' + '}Speed: <strong className={gotBonus ? 'text-[#0E0E16]' : 'text-white'}>{myDrawing.roundScore - myDrawing.aiScore}</strong>
            </p>
            {myDrawing.aiGuess && (
              <div className="bg-[var(--cyan)] text-[#0E0E16] border-2 border-black rounded-2xl px-3 py-1 text-sm font-display font-bold shadow-[3px_3px_0_0_#007594]">
                “{myDrawing.aiGuess}”
              </div>
            )}
            {myDrawing.aiRoast && <p className={`italic text-sm ${gotBonus ? 'text-[#0E0E16]/80' : 'text-white/70'}`}>“{myDrawing.aiRoast}”</p>}
            <p className={`font-display uppercase text-sm ${gotBonus ? 'text-[#0E0E16]/70' : 'text-white/60'}`}>Current rank: <strong className={`text-base ${gotBonus ? 'text-[#0E0E16]' : 'text-[var(--yellow)]'}`}>#{rank}</strong></p>
          </BrutalCard>
        ) : (
          <p className="text-white/50 font-display">No drawing submitted this round</p>
        )}
        <p className="text-sm text-[var(--cyan)] font-display uppercase tracking-wide">Waiting for host to advance…</p>
      </div>
    );
  }

  // ── FINISHED ──────────────────────────────────────────────────────────────
  if (room.status === 'finished') {
    const sortedPlayers = [...players].sort((a, b) => b.totalScore - a.totalScore);
    const winner = sortedPlayers[0];
    return (
      <div className="min-h-screen flex flex-col gap-8 p-6 pt-10 text-center items-center overflow-y-auto">
        {/* Champion */}
        {winner && (
          <BrutalCard
            color="yellow"
            shadowColor="#997B00"
            className="flex flex-col items-center w-full max-w-[420px] !rounded-[36px] !px-8 !py-9 !border-[6px]"
            initial={{ scale: 0, rotate: -6 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', bounce: 0.5 }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#0E0E16" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-20 h-20">
              <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z" />
              <path d="M5 21h14" />
            </svg>
            <p className="font-display font-bold uppercase tracking-[0.22em] text-[#0E0E16]/60 text-sm mt-3 mb-2">Champion</p>
            <div className="flex items-center justify-center gap-2.5 mb-5">
              <div className="w-7 h-7 rounded-full border-[3px] border-black" style={{ background: winner.avatarColor }} />
              <h1 className="font-display font-black uppercase text-[#0E0E16] leading-none tracking-tight" style={{ fontSize: 'clamp(2.2rem, 9vw, 3.5rem)' }}>{winner.nickname}</h1>
            </div>
            <div className="bg-[#0E0E16] text-white font-display font-black text-3xl px-8 py-3 rounded-2xl border-4 border-black -rotate-3 shadow-[6px_6px_0_0_var(--magenta)]">
              <CountUp value={winner.totalScore} /> PTS
            </div>
          </BrutalCard>
        )}

        {/* Full standings */}
        <div className="w-full max-w-[400px]">
          <h2 className="font-display font-black uppercase tracking-widest mb-3 text-lg text-white">Final Standings</h2>
          <div className="flex flex-col gap-2.5">
            {sortedPlayers.map((p, i) => (
              <BrutalCard
                key={p.playerId.toString()}
                color="surface"
                shadowColor={i === 0 ? '#997B00' : '#000000'}
                className={`!p-3 flex items-center gap-3 !rounded-2xl ${i === 0 ? '!border-[var(--yellow)]' : p.playerId === myPlayerId ? '!border-[var(--magenta)]' : ''}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
              >
                <span className={`font-display font-black w-6 text-center ${i === 0 ? 'text-[var(--yellow)]' : 'text-white/50'}`}>#{i + 1}</span>
                <div className="w-3 h-3 rounded-full border border-black flex-none" style={{ background: p.avatarColor }} />
                <span className="flex-1 font-display font-bold text-left text-white">{p.nickname}</span>
                {p.playerId === myPlayerId && <span className="text-xs font-display uppercase text-[var(--magenta)]">you</span>}
                <span className="font-display font-black text-[var(--yellow)]"><CountUp value={p.totalScore} /></span>
              </BrutalCard>
            ))}
          </div>
        </div>

        {/* Hall of Shame */}
        {(() => {
          const allScored = drawings.filter(d => d.submitted && d.scored && d.imageUrl);
          const shame = [...allScored].sort((a, b) => a.roundScore - b.roundScore).slice(0, 3);
          const playerMap: Record<string, typeof players[0]> = {};
          players.forEach(p => { playerMap[p.playerId.toString()] = p; });
          if (shame.length === 0) return null;
          return (
            <div ref={hallRef} className="w-full max-w-[400px]">
              <h2 className="font-display font-black uppercase tracking-widest text-[var(--red)] text-xl mb-1">Hall of Shame</h2>
              <p className="text-xs text-white/60 mb-3 font-display uppercase tracking-wide">Drawings the AI understood least</p>
              <div className="flex flex-col gap-3">
                {shame.map((d, i) => {
                  const p = playerMap[d.playerId.toString()];
                  const r = rounds.find(r => r.roundId === d.roundId);
                  return (
                    <BrutalCard
                      key={d.drawingId.toString()}
                      color="surface"
                      shadowColor="#8A0000"
                      className="!p-0 overflow-hidden !border-[var(--red)] text-left"
                      initial={{ opacity: 0, y: 20, rotate: i % 2 ? 1.5 : -1.5 }}
                      animate={{ opacity: 1, y: 0, rotate: 0 }}
                      transition={{ type: 'spring', stiffness: 240, damping: 18, delay: i * 0.08 }}
                    >
                      <img src={d.imageUrl} alt="drawing" className="w-full aspect-square object-cover block bg-white border-b-4 border-black" />
                      <div className="p-4 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          {p && <div className="w-4 h-4 rounded-full border-2 border-black" style={{ background: p.avatarColor }} />}
                          <span className="font-display font-black uppercase text-base text-white">{p?.nickname ?? '?'}</span>
                          <span className="text-sm text-white/50 font-display">· {r?.word}</span>
                        </div>
                        {d.aiGuess && <p className="text-sm text-[var(--cyan)] font-display font-bold">AI thought: “{d.aiGuess}”</p>}
                        {d.aiRoast && <p className="text-sm italic text-[var(--red)] leading-snug">“{d.aiRoast}”</p>}
                        <p className="font-display font-black text-[var(--red)] text-2xl mt-0.5">{d.roundScore} pts</p>
                      </div>
                    </BrutalCard>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Play Again offer */}
        {replayOffer && myPlayer && (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6">
            <BrutalCard color="surface" className="w-full max-w-sm flex flex-col items-center gap-4 text-center !py-8">
              {!myReplayVote ? (
                <>
                  <h2 className="font-display font-black uppercase text-2xl text-white">Play again?</h2>
                  <p className="font-display font-black text-6xl text-[var(--yellow)] tabular-nums leading-none">
                    {Math.max(0, Math.ceil((Number(replayOffer.deadline.microsSinceUnixEpoch / 1000n) - nowMs) / 1000))}s
                  </p>
                  <div className="flex gap-3 w-full mt-1">
                    <BrutalButton color="green" size="lg" className="flex-1" onClick={() => room && voteReplay({ roomId: room.roomId, accept: true })}>Yes!</BrutalButton>
                    <BrutalButton color="surface" size="lg" className="flex-1" onClick={() => room && voteReplay({ roomId: room.roomId, accept: false })}>No thanks</BrutalButton>
                  </div>
                </>
              ) : myReplayVote.accept ? (
                <>
                  <h2 className="font-display font-black uppercase text-xl text-[var(--green)]">You&apos;re in!</h2>
                  <p className="font-display text-white/60">Waiting for the host to start the next game…</p>
                </>
              ) : (
                <>
                  <h2 className="font-display font-black uppercase text-xl text-white">Maybe next time!</h2>
                  <p className="font-display text-white/60">You&apos;ll be dropped when the next game starts.</p>
                </>
              )}
            </BrutalCard>
          </div>
        )}
      </div>
    );
  }

  return null;
}
