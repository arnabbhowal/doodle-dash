'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useReducer, useTable, useProcedure } from 'spacetimedb/react';
import { motion } from 'motion/react';
import confetti from 'canvas-confetti';
import { QRCodeSVG } from 'qrcode.react';
import { reducers, tables, procedures } from '../../../src/module_bindings';
import type { Drawing, Player } from '../../../src/module_bindings/types';
import { selectPending, roundFullyScored } from '../../../lib/scoring';
import { startLobbyMusic, stopLobbyMusic, playJoin, startCountdown, stopCountdown, playVictory, playConfettiGun, COUNTDOWN_LEAD_MS } from '../../../lib/sounds';
import { BrutalButton } from '../../components/BrutalButton';
import { BrutalCard } from '../../components/BrutalCard';
import { CountUp } from '../../components/CountUp';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

function getSecondsLeft(endsAtMs: number) {
  return Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Fetch a (public Supabase) image URL and return base64 with no data: prefix.
async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// Run fn over items with bounded parallelism (multithreaded, but we await ALL of
// them before returning). Keeps us from hammering Gemini with N simultaneous
// calls (the old thundering-herd that caused the 429 → silent-0 bug).
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Flood fill on the host's replay canvas (mirrors the player's Fill tool). Tolerant of
// anti-aliased edges, like the player-side fill.
function hostFloodFill(ctx: CanvasRenderingContext2D, sx: number, sy: number, hex: string) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const s = (sy * w + sx) * 4;
  const tr = data[s], tg = data[s + 1], tb = data[s + 2], ta = data[s + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  if (tr === fr && tg === fg && tb === fb && ta === 255) return;
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

// Replay a player's streamed Peek ops onto the host's canvas. Most ops are stroke
// batches ([nx,ny,down] points, down=1 starting a segment). Two sentinels mirror the
// non-stroke tools: color '!clear' wipes the canvas, '!fill:<hex>' flood-fills at the
// point. Replaying the full ordered list reconstructs erases/fills/clears correctly.
function renderPeekStrokes(
  canvas: HTMLCanvasElement,
  strokes: { seq: number; pts: string; color: string; size: number }[],
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height, minD = Math.min(W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  let last: { x: number; y: number } | null = null;
  for (const s of strokes) {
    if (s.color === '!clear') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); last = null; continue; }
    if (s.color.startsWith('!fill:')) {
      let fp: number[][];
      try { fp = JSON.parse(s.pts); } catch { continue; }
      if (fp[0]) hostFloodFill(ctx, Math.floor(fp[0][0] * W), Math.floor(fp[0][1] * H), s.color.slice(6));
      last = null;
      continue;
    }
    const lw = Math.max(1, s.size * minD);
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let pts: number[][];
    try { pts = JSON.parse(s.pts); } catch { continue; }
    for (const p of pts) {
      const x = p[0] * W, y = p[1] * H;
      if (p[2]) { ctx.beginPath(); ctx.arc(x, y, lw / 2, 0, Math.PI * 2); ctx.fill(); last = { x, y }; }
      else if (last) { ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(x, y); ctx.stroke(); last = { x, y }; }
      else last = { x, y };
    }
  }
}

export default function HostPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  // ── Reducers ──────────────────────────────────────────────────────────────
  const startGame      = useReducer(reducers.startGame);
  const kickPlayer     = useReducer(reducers.kickPlayer);
  const nextRound      = useReducer(reducers.nextRound);
  const scoreDrawing   = useProcedure(procedures.scoreDrawing);
  const recordScoreFor = useReducer(reducers.recordScoreFor);

  // ── Subscriptions ─────────────────────────────────────────────────────────
  const [rooms]     = useTable(tables.room.where(r => r.code.eq(code)));
  const room        = rooms[0];
  const roomId      = room?.roomId;

  const [players]   = useTable(tables.player.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [rounds]    = useTable(tables.round.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [drawings]  = useTable(tables.drawing.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [guesses]   = useTable(tables.guess);
  // Host "Peek": spectate players drawing live via streamed strokes (read-only).
  const [spectateRows] = useTable(tables.spectate.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const spectateActive = spectateRows[0]?.active ?? false;
  const [peekStrokes]  = useTable(tables.peek_stroke.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId && spectateActive });
  const setSpectate    = useReducer(reducers.setSpectate);
  const [peekIdx, setPeekIdx] = useState(0);
  const peekCanvasRef  = useRef<HTMLCanvasElement>(null);
  const closeGrading = useReducer(reducers.closeGrading);
  const [replays]   = useTable(tables.replay.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const [replayVotes] = useTable(tables.replay_vote.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
  const offerReplay   = useReducer(reducers.offerReplay);
  const resolveReplay = useReducer(reducers.resolveReplay);
  const replayOffer   = replays[0];

  // Play Again: tick a countdown while an offer is open, and resolve it (host-driven)
  // once everyone has voted OR the 10s window elapses. resolve_replay is idempotent.
  const [replayNow, setReplayNow] = useState(Date.now());
  useEffect(() => {
    if (!replayOffer) return;
    const id = setInterval(() => setReplayNow(Date.now()), 300);
    return () => clearInterval(id);
  }, [replayOffer?.roomId]);
  const replaySecsLeft = replayOffer
    ? Math.max(0, Math.ceil((Number(replayOffer.deadline.microsSinceUnixEpoch / 1000n) - replayNow) / 1000))
    : 0;
  const replayYes = replayVotes.filter(v => v.accept).length;
  useEffect(() => {
    if (!replayOffer || !room) return;
    const allVoted = players.length > 0 && replayVotes.length >= players.length;
    const deadlineMs = Number(replayOffer.deadline.microsSinceUnixEpoch / 1000n);
    if (allVoted) { resolveReplay({ roomId: room.roomId }); return; }
    const t = setTimeout(() => resolveReplay({ roomId: room.roomId }), Math.max(0, deadlineMs - Date.now()) + 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayOffer?.roomId, replayVotes.length, players.length]);

  // ── Host config state ─────────────────────────────────────────────────────
  const [totalRounds,   setTotalRounds]   = useState(3);
  const [roundDuration, setRoundDuration] = useState(60);
  const [wordSource,    setWordSource]    = useState<'preset' | 'custom'>('preset');
  const [customWords,   setCustomWords]   = useState('');

  // ── Countdown ─────────────────────────────────────────────────────────────
  const [secondsLeft, setSecondsLeft] = useState(30);
  const currentRound = rounds.find(r => r.roundNumber === room?.currentRound);

  useEffect(() => {
    if (!currentRound || room?.status !== 'in_round') return;
    const endsAtMs = Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n);
    const tick = () => setSecondsLeft(getSecondsLeft(endsAtMs));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [currentRound?.roundId, room?.status]);

  // Peek: auto-shuffle to the next player every ~3.5s while spectating.
  useEffect(() => {
    if (!spectateActive || room?.status !== 'in_round') return;
    const id = setInterval(() => setPeekIdx(i => i + 1), 3500);
    return () => clearInterval(id);
  }, [spectateActive, room?.status]);

  // Which player we're currently peeking at (top-level so the redraw effect can use it).
  const peekSafeIdx = players.length ? ((peekIdx % players.length) + players.length) % players.length : 0;
  const peekPlayer  = players.length ? players[peekSafeIdx] : null;
  const peekPlayerHasStrokes = peekPlayer ? peekStrokes.some(s => s.playerId === peekPlayer.playerId) : false;

  // Replay the viewed player's streamed strokes onto the peek canvas, live. Re-runs as
  // new strokes arrive (peekStrokes changes) and when we shuffle to another player.
  useEffect(() => {
    const canvas = peekCanvasRef.current;
    if (!canvas || !spectateActive || room?.status !== 'in_round' || !peekPlayer) return;
    const strokes = peekStrokes
      .filter(s => s.playerId === peekPlayer.playerId)
      .sort((a, b) => a.seq - b.seq)
      .map(s => ({ seq: s.seq, pts: s.pts, color: s.color, size: s.size }));
    try { renderPeekStrokes(canvas, strokes); } catch (e) { console.warn('[peek] render failed', e); }
  }, [spectateActive, room?.status, peekPlayer?.playerId, peekStrokes]);

  // Self-grade window countdown (ends_at is repurposed as the grade deadline during
  // 'scoring'); the host holds AI scoring until it elapses.
  const [scoringNow, setScoringNow] = useState(Date.now());
  useEffect(() => {
    if (room?.status !== 'scoring') return;
    const id = setInterval(() => setScoringNow(Date.now()), 300);
    return () => clearInterval(id);
  }, [room?.status]);
  const gradeSecsLeft = currentRound && room?.status === 'scoring'
    ? Math.max(0, Math.ceil((Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n) - scoringNow) / 1000))
    : 0;

  // Confetti celebration when the game finishes (presentation only)
  useEffect(() => {
    if (room?.status !== 'finished') return;
    playVictory();
    playConfettiGun();
    const end = Date.now() + 2500;
    const colors = ['#FF2E88', '#FFD60A', '#00E08A', '#19D3FF'];
    const frame = () => {
      confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors });
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, [room?.status]);

  // ── Sound: lobby music while the lobby is open ───────────────────────────────
  useEffect(() => {
    if (room?.status === 'lobby') {
      startLobbyMusic();
      return () => stopLobbyMusic();
    }
  }, [room?.status]);

  // ── Sound: player-join chime when someone NEW joins the lobby ────────────────
  // Seed the known set on the first lobby render so pre-existing players (e.g.
  // after a host refresh) don't all chime; only genuine joins after that play.
  const knownPlayerIds = useRef<Set<string>>(new Set());
  const lobbyJoinSeeded = useRef(false);
  useEffect(() => {
    if (room?.status !== 'lobby') { lobbyJoinSeeded.current = false; return; }
    const ids = new Set(players.map(p => p.playerId.toString()));
    if (!lobbyJoinSeeded.current) { knownPlayerIds.current = ids; lobbyJoinSeeded.current = true; return; }
    let joined = false;
    for (const id of ids) if (!knownPlayerIds.current.has(id)) { joined = true; break; }
    knownPlayerIds.current = ids;
    if (joined) playJoin();
  }, [players, room?.status]);

  // ── Sound: countdown scheduled to END exactly when the round timer hits 0 ─────
  // Schedule the 5s clip to start COUNTDOWN_CLIP_MS before the deadline so it
  // finishes on 0. Cleanup cancels it on round change or an early end (→ scoring).
  useEffect(() => {
    stopCountdown();
    if (room?.status !== 'in_round' || !currentRound) return;
    const endsMs = Number(currentRound.endsAt.microsSinceUnixEpoch / 1000n);
    const delay = endsMs - COUNTDOWN_LEAD_MS - Date.now();
    if (delay <= -COUNTDOWN_LEAD_MS) return; // already past the countdown window
    const t = setTimeout(() => startCountdown(), Math.max(0, delay));
    return () => { clearTimeout(t); stopCountdown(); };
  }, [room?.status, currentRound?.roundId]);

  // ── Host-driven scoring (reactive; the SERVER reveals) ────────────────────────
  // The host is the single coordinator. While the round is in 'scoring' it scores
  // EVERY drawing (bounded-parallel Gemini calls, with a speed-only fallback) and
  // records each via record_score_for. It does NOT reveal — the server flips to
  // 'reveal' atomically once the last drawing is scored, so nothing can race ahead
  // of a score and the finalize_round backstop can never be defeated by an early
  // reveal. The loop reads LIVE table data every iteration (via refs), so late
  // submissions, host refreshes, and slow-to-replicate rows are always picked up
  // instead of being missed by a one-time snapshot. The backstop only matters now
  // if the host browser dies mid-scoring.
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const currentRoundRef = useRef(currentRound);
  currentRoundRef.current = currentRound;
  const guessesRef = useRef(guesses);
  guessesRef.current = guesses;

  const scoringRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (room?.status !== 'scoring' || !currentRound) return;
    const roundKey = currentRound.roundId.toString();
    if (scoringRoundRef.current === roundKey) return; // a loop is already running for this round
    scoringRoundRef.current = roundKey;

    let cancelled = false;
    const dispatched = new Set<string>(); // drawingIds already handed to the scorer

    // Score one drawing: AI with retry/backoff on a non-ok (rate-limited) result,
    // falling back to a speed-only score so a player is NEVER left unscored.
    const scoreOne = async (d: Drawing, word: string): Promise<{ score: number; guess: string; roast: string }> => {
      if (!d.imageUrl) return { score: 0, guess: '', roast: 'The AI never got a drawing to judge.' };
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        if (attempt > 0) await sleep(800 * attempt);
        try {
          const b64 = await urlToBase64(d.imageUrl);
          const json = await scoreDrawing({ imageBase64: b64, word });
          const parsed = JSON.parse(json as string) as { ok?: boolean; score?: number; guess?: string; roast?: string };
          if (parsed.ok) return { score: parsed.score ?? 0, guess: parsed.guess ?? '', roast: parsed.roast ?? '' };
        } catch (e) {
          console.warn('[host scoring] attempt failed', e);
        }
      }
      return { score: 0, guess: '', roast: "The AI couldn't make sense of it. That's on you." };
    };

    (async () => {
      // Self-grade window: the round's ends_at was set to ~10s out when it entered
      // scoring. Hold AI scoring until it elapses so every player (esp. the last to
      // submit) can lock their guess — BUT cut it short the moment every submitter has
      // locked in (no point waiting the rest). Synced via the server clock.
      while (!cancelled) {
        const r = currentRoundRef.current;
        if (!r || r.roundId.toString() !== roundKey) return;
        if (Number(r.endsAt.microsSinceUnixEpoch / 1000n) - Date.now() <= 0) break;
        const submitters = drawingsRef.current.filter(d => d.roundId.toString() === roundKey && d.submitted);
        const gs = guessesRef.current;
        const allLocked = submitters.length > 0 &&
          submitters.every(d => gs.some(g => g.playerId === d.playerId && g.roundId.toString() === roundKey));
        if (allLocked) { closeGrading({ roundId: r.roundId }); break; }
        await sleep(300);
      }
      if (cancelled) return;

      let waits = 0;
      const MAX_WAITS = 150; // ~60s safety cap; the server backstop covers true host death
      while (!cancelled) {
        const live = drawingsRef.current;
        const round = currentRoundRef.current;
        if (!round || round.roundId.toString() !== roundKey) return; // round advanced / unmounted

        const pending = selectPending(live, roundKey, dispatched);
        if (pending.length === 0) {
          // Nothing new to score. Either the whole round is scored (server has, or is
          // about to, reveal — we're done) or our in-flight records / the drawing
          // subscription haven't caught up yet, so wait and re-check live data.
          if (roundFullyScored(live, roundKey)) return;
          if (++waits > MAX_WAITS) return;
          await sleep(400);
          continue;
        }

        for (const d of pending) dispatched.add(d.drawingId.toString());
        const word = round.word;
        await mapWithConcurrency(pending, 4, async (d) => {
          const result = await scoreOne(d, word);
          if (cancelled) return;
          recordScoreFor({ roundId: round.roundId, playerId: d.playerId, score: result.score, guess: result.guess, roast: result.roast });
        });
        // Loop again — pick up anything that arrived or was reset while we scored.
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.status, currentRound?.roundId]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const roundDrawings = drawings.filter(d => d.roundId === currentRound?.roundId);
  const topDrawings   = [...roundDrawings].sort((a, b) => b.roundScore - a.roundScore).slice(0, 3);
  const leaderboard   = [...players].sort((a, b) => b.totalScore - a.totalScore);

  // Hall of Shame: lowest round_score drawings across all rounds
  const allSubmitted  = drawings.filter(d => d.submitted && d.scored && d.imageUrl);
  const hallOfShame   = [...allSubmitted].sort((a, b) => a.roundScore - b.roundScore).slice(0, 3);

  const playerMap: Record<string, Player> = {};
  players.forEach(p => { playerMap[p.playerId.toString()] = p; });

  function getWordForDrawing(drawing: Drawing): string {
    const r = rounds.find(r => r.roundId === drawing.roundId);
    return r?.word ?? '?';
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  const joinUrl = `${APP_URL}/join/${code}`;

  if (!room) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center flex flex-col items-center gap-4">
          <div className="spinner" style={{ margin: 0 }} />
          <p className="font-display uppercase tracking-widest text-[var(--cyan)]">Connecting to room {code}…</p>
        </div>
      </div>
    );
  }

  // ── LOBBY ─────────────────────────────────────────────────────────────────
  if (room.status === 'lobby') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 sm:p-8 pt-20 sm:pt-8 relative">
       <BrutalButton color="surface" size="sm" sound="back" onClick={() => router.push('/')} className="absolute top-4 left-4 sm:top-6 sm:left-6 z-10">
         Back
       </BrutalButton>
       <div className="w-full max-w-7xl grid grid-cols-1 lg:grid-cols-[360px_1fr_400px] gap-6 lg:gap-12 items-start">
        {/* Left: QR + code */}
        <div className="flex-none flex flex-col gap-6 items-center mx-auto w-full max-w-[360px]">
          <BrutalCard color="yellow" shadowColor="#997B00" className="flex flex-col items-center gap-5 w-full !p-8">
            <div className="bg-white rounded-2xl p-4 border-4 border-black">
              <QRCodeSVG value={joinUrl} size={240} bgColor="#ffffff" fgColor="#0E0E16" marginSize={2} level="M" />
            </div>
            <p className="font-display font-black uppercase text-[#0E0E16] text-center text-sm tracking-wide break-all leading-snug">{joinUrl}</p>
            <CopyButton text={joinUrl} label="Copy link" dark />
          </BrutalCard>
          <div className="bg-[var(--surface)] border-4 border-black rounded-[24px] p-6 text-center shadow-[10px_10px_0_0_#000] w-full overflow-hidden flex flex-col items-center">
            <p className="text-[var(--cyan)] font-display font-bold uppercase tracking-widest text-base mb-2">Room Code</p>
            <p className="font-display font-black tracking-tight text-white text-6xl leading-none whitespace-nowrap">{code}</p>
            <div className="mt-3"><CopyButton text={code} label="Copy code" /></div>
          </div>
        </div>

        {/* Center: Players */}
        <div className="min-w-0 flex flex-col gap-5 sm:gap-8 pt-2">
          <h2 className="font-display font-black uppercase tracking-widest text-4xl sm:text-5xl lg:text-6xl text-white">
            Players <span className="text-[var(--magenta)]">({players.length})</span>
          </h2>
          <div className="flex flex-wrap gap-3 sm:gap-5 content-start">
            {players.map((p, i) => (
              <motion.div
                key={p.playerId.toString()}
                initial={{ scale: 0, rotate: -10 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', bounce: 0.55, delay: i * 0.06 }}
                className="flex items-center gap-3 sm:gap-4 rounded-full border-4 border-black px-5 py-3 sm:px-8 sm:py-4 font-display font-black uppercase text-xl sm:text-3xl text-[#0E0E16] shadow-[5px_5px_0_0_#000]"
                style={{ background: p.avatarColor }}
              >
                <span>{p.nickname}</span>
                {p.isHost && <span className="text-xs sm:text-sm bg-black/25 rounded-full px-2.5 py-0.5 sm:px-3 sm:py-1">host</span>}
                {!p.isHost && (
                  <button
                    onClick={() => kickPlayer({ targetPlayerId: p.playerId })}
                    className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-black/25 hover:bg-black/45 transition-colors flex items-center justify-center text-sm sm:text-base font-black leading-none"
                    aria-label="Kick player"
                  >
                    X
                  </button>
                )}
              </motion.div>
            ))}
            {players.length === 0 && <p className="font-display uppercase tracking-wide text-white/50 text-lg sm:text-2xl">Waiting for players to join…</p>}
          </div>
        </div>

        {/* Right: Config */}
        <div className="flex-none w-full lg:w-[400px] flex flex-col gap-5">
          <h2 className="font-display font-black uppercase tracking-widest text-3xl sm:text-4xl text-white">Game Setup</h2>
          <BrutalCard color="surface" className="flex flex-col gap-5 !p-7">
            <div>
              <label className="block text-base font-display uppercase tracking-wide text-white/60 mb-2.5">Rounds</label>
              <div className="flex gap-3">
                {[3, 5, 8].map(n => (
                  <BrutalButton key={n} size="md" color={totalRounds === n ? 'cyan' : 'surface'} onClick={() => setTotalRounds(n)} className="flex-1">
                    {n}
                  </BrutalButton>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-base font-display uppercase tracking-wide text-white/60 mb-2.5">Draw time</label>
              <div className="flex flex-wrap gap-3">
                {[30, 60, 90, 120].map(s => (
                  <BrutalButton key={s} size="md" color={roundDuration === s ? 'cyan' : 'surface'} onClick={() => setRoundDuration(s)} className="flex-1 min-w-[60px] !px-3">
                    {s}s
                  </BrutalButton>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-base font-display uppercase tracking-wide text-white/60 mb-2.5">Words</label>
              <div className="flex gap-3">
                {(['preset', 'custom'] as const).map(s => (
                  <BrutalButton key={s} size="md" color={wordSource === s ? 'cyan' : 'surface'} onClick={() => setWordSource(s)} className="flex-1 capitalize">
                    {s}
                  </BrutalButton>
                ))}
              </div>
            </div>
            {wordSource === 'custom' && (
              <textarea
                placeholder="One word per line or comma-separated"
                value={customWords}
                onChange={e => setCustomWords(e.target.value)}
                rows={4}
                className="w-full border-4 border-black bg-[var(--surface)] rounded-2xl p-3 text-sm font-display text-white shadow-[4px_4px_0_0_#000] resize-y focus:outline-none focus:border-[var(--magenta)]"
              />
            )}
            <BrutalButton
              color="magenta"
              size="lg"
              disabled={players.length < 2}
              onClick={() => room && startGame({ roomId: room.roomId, totalRounds, wordSource, customWords, roundDuration })}
              className="w-full whitespace-normal leading-tight text-center !py-5 mt-1"
            >
              {players.length < 2 ? `Need ${2 - players.length} more player…` : '▶ Start Game'}
            </BrutalButton>
          </BrutalCard>
        </div>
       </div>
      </div>
    );
  }

  // ── IN ROUND ──────────────────────────────────────────────────────────────
  if (room.status === 'in_round' && currentRound) {
    const submittedSet = new Set(roundDrawings.filter(d => d.submitted).map(d => d.playerId.toString()));
    const countColor = secondsLeft <= 5 ? 'text-[var(--red)]' : secondsLeft <= 10 ? 'text-[var(--yellow)]' : 'text-white';
    const doneCount = submittedSet.size;

    // Peek viewer — show the submitted drawing if done, else replay their live strokes.
    const peekDrawing = peekPlayer ? roundDrawings.find(d => d.playerId === peekPlayer.playerId && d.submitted) : null;
    const peekStatusLabel = peekDrawing ? 'Submitted' : peekPlayerHasStrokes ? 'Drawing live…' : 'Warming up…';

    const playerChips = (
      <div className="flex flex-wrap gap-2 sm:gap-3 justify-center max-w-[640px]">
        {players.map(p => {
          const done = submittedSet.has(p.playerId.toString());
          return (
            <BrutalCard
              key={p.playerId.toString()}
              color={done ? 'green' : 'surface'}
              shadowColor={done ? '#00663E' : '#000000'}
              className="!p-1.5 !px-3 sm:!p-2 sm:!px-4 !rounded-full flex items-center gap-2"
              animate={{ scale: done ? [1, 1.12, 1] : 1 }}
              transition={{ duration: 0.3 }}
            >
              <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full border border-black" style={{ background: p.avatarColor }} />
              <span className={`font-display font-bold text-xs sm:text-sm ${done ? 'text-[#0E0E16]' : 'text-white'}`}>{p.nickname}</span>
              {done && <span className="text-[#0E0E16] font-black text-[10px] sm:text-xs uppercase tracking-wide">Done</span>}
            </BrutalCard>
          );
        })}
      </div>
    );

    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 sm:gap-8 p-4 sm:p-8">
        <div className="text-center">
          <p className="font-display uppercase tracking-widest text-[var(--cyan)] mb-1 sm:mb-2 text-sm sm:text-base">Round {room.currentRound} / {room.totalRounds}</p>
          <h1 className="font-display font-black uppercase tracking-[0.05em] text-white leading-none" style={{ fontSize: 'clamp(2rem, 8vw, 5rem)' }}>
            {currentRound.word}
          </h1>
        </div>

        {!spectateActive ? (
          <>
            <div className={`font-display font-black leading-none transition-colors ${countColor}`} style={{ fontSize: 'clamp(3.5rem, 12vw, 8rem)' }}>
              {secondsLeft}
            </div>
            {playerChips}
            <BrutalButton color="cyan" size="lg" onClick={() => room && setSpectate({ roomId: room.roomId, active: true })}>
              Peek at drawings
            </BrutalButton>
          </>
        ) : (
          <div className="w-full max-w-[480px] flex flex-col items-center gap-4">
            <div className="flex items-center justify-center gap-4">
              <span className="font-display uppercase tracking-widest text-[var(--cyan)] text-sm">{doneCount}/{players.length} done</span>
              <span className={`font-display font-black tabular-nums ${countColor}`} style={{ fontSize: 'clamp(2rem, 7vw, 3rem)' }}>{secondsLeft}s</span>
            </div>
            <div className="flex items-center justify-between w-full gap-3">
              <BrutalButton size="sm" color="surface" onClick={() => setPeekIdx(i => i - 1)}>Prev</BrutalButton>
              <div className="flex items-center gap-2 min-w-0">
                {peekPlayer && <div className="w-4 h-4 rounded-full border-2 border-black flex-none" style={{ background: peekPlayer.avatarColor }} />}
                <span className="font-display font-black uppercase text-white truncate text-lg sm:text-xl">{peekPlayer?.nickname ?? '—'}</span>
              </div>
              <BrutalButton size="sm" color="surface" onClick={() => setPeekIdx(i => i + 1)}>Next</BrutalButton>
            </div>
            <BrutalCard color={peekDrawing ? 'green' : 'surface'} className="!p-3 w-full flex flex-col gap-2">
              <div className="aspect-[3/4] w-full bg-white rounded-xl border-4 border-black overflow-hidden flex items-center justify-center relative">
                {peekDrawing?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={peekDrawing.imageUrl} alt="" className="w-full h-full object-contain" />
                ) : (
                  <>
                    <canvas ref={peekCanvasRef} width={600} height={800} className="w-full h-full" style={{ display: 'block' }} />
                    {!peekPlayerHasStrokes && (
                      <span className="absolute font-display uppercase tracking-wide text-black/30">Warming up…</span>
                    )}
                  </>
                )}
              </div>
              <p className={`font-display font-black uppercase tracking-wide text-center text-sm ${peekDrawing ? 'text-[#0E0E16]' : 'text-[var(--cyan)]'}`}>{peekStatusLabel}</p>
            </BrutalCard>
            <div className="flex flex-wrap gap-2 justify-center w-full">
              {players.map((p, i) => {
                const done = submittedSet.has(p.playerId.toString());
                return (
                  <button key={p.playerId.toString()} onClick={() => setPeekIdx(i)}
                    className={`w-4 h-4 rounded-full border-2 transition-transform ${i === peekSafeIdx ? 'border-white scale-125' : 'border-black'} ${done ? 'ring-2 ring-[var(--green)]' : ''}`}
                    style={{ background: p.avatarColor }} aria-label={p.nickname} />
                );
              })}
            </div>
            <BrutalButton color="magenta" size="md" onClick={() => room && setSpectate({ roomId: room.roomId, active: false })}>
              Stop peeking
            </BrutalButton>
          </div>
        )}
      </div>
    );
  }

  // ── SCORING ───────────────────────────────────────────────────────────────
  if (room.status === 'scoring') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
        <BrutalCard
          color="cyan"
          shadowColor="#007594"
          className="flex flex-col items-center gap-4 text-center"
          animate={{ rotate: [-1.5, 1.5, -1.5] }}
          transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}
        >
          <BouncyDots />
          {gradeSecsLeft > 0 ? (
            <>
              <h2 className="font-display font-black uppercase tracking-widest text-3xl text-[#0E0E16]">Lock in your guesses!</h2>
              <p className="font-display font-black text-6xl text-[#0E0E16] tabular-nums">{gradeSecsLeft}s</p>
              <p className="font-display font-bold text-[#0E0E16]/70">Players are guessing their own scores for a bonus…</p>
            </>
          ) : (
            <>
              <h2 className="font-display font-black uppercase tracking-widest text-3xl text-[#0E0E16]">The AI is judging…</h2>
              <p className="font-display font-bold text-[#0E0E16]/70">{roundDrawings.filter(d => d.submitted && d.aiScore < 0).length} drawings still being scored</p>
            </>
          )}
        </BrutalCard>
      </div>
    );
  }

  // ── REVEAL ────────────────────────────────────────────────────────────────
  if (room.status === 'reveal' && currentRound) {
    const showTop = topDrawings; // always show all top drawings (up to 3)

    return (
      <div className="min-h-screen flex items-center justify-center p-4 sm:p-6">
       <div className="w-full max-w-7xl flex flex-col lg:flex-row gap-5 lg:gap-8 items-stretch">
        {/* Gallery */}
        <BrutalCard color="surface" className="flex-1 min-w-0 flex flex-col gap-5 sm:gap-6">
          <h2 className="font-display font-black uppercase tracking-widest text-2xl sm:text-4xl text-white">
            Round {room.currentRound} <span className="text-[var(--cyan)]">— “{currentRound.word}”</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {showTop.map((d, i) => {
              const p = playerMap[d.playerId.toString()];
              return (
                <motion.div
                  key={d.drawingId.toString()}
                  className={`bg-[var(--canvas)] rounded-2xl border-4 overflow-hidden relative flex flex-col ${i === 0 ? 'border-[var(--yellow)]' : 'border-black'}`}
                  style={{ boxShadow: `6px 6px 0px 0px ${i === 0 ? '#997B00' : '#000000'}` }}
                  initial={{ opacity: 0, y: 30, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 18, delay: i * 0.1 }}
                >
                  <span className={`absolute top-3 left-3 z-10 px-3 py-0.5 rounded-full font-display font-black text-sm border-2 border-black ${i === 0 ? 'bg-[var(--yellow)] text-[#0E0E16]' : 'bg-[var(--surface)] text-white'}`}>
                    #{i + 1}
                  </span>
                  {d.imageUrl ? (
                    <img src={d.imageUrl} alt="drawing" className="w-full aspect-square object-cover bg-white" />
                  ) : (
                    <div className="w-full aspect-square bg-white flex items-center justify-center text-black/30 font-display uppercase">no image</div>
                  )}
                  <div className="p-4 flex flex-col gap-1.5 border-t-4 border-black">
                    {p && (
                      <div className="flex items-center gap-2">
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-black" style={{ background: p.avatarColor }} />
                        <span className="font-display font-bold text-white uppercase">{p.nickname}</span>
                      </div>
                    )}
                    <div className="font-display font-black text-3xl text-[var(--yellow)] flex items-center gap-2">
                      <CountUp value={d.roundScore} /> pts
                      {d.aiScore > 100 && <span className="text-base text-[var(--green)] font-black">BONUS</span>}
                    </div>
                    <div className="text-xs text-white/60 font-display">
                      AI: <strong className="text-white">{d.aiScore > 100 ? d.aiScore - 100 : d.aiScore}</strong>{d.aiScore > 100 && <strong className="text-[var(--magenta)]"> +100</strong>}{' + '}Speed: <strong className="text-white">{d.roundScore - d.aiScore}</strong>
                    </div>
                    {d.aiGuess && <div className="text-sm font-display font-bold text-[var(--cyan)]">“{d.aiGuess}”</div>}
                    <div className="text-sm text-white/70 italic">{d.aiRoast}</div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </BrutalCard>

        {/* Right column: leaderboard + next */}
        <div className="flex-none w-full lg:w-[320px] flex flex-col gap-5 sm:gap-6">
          <BrutalCard color="yellow" shadowColor="#997B00" className="flex-1">
            <h3 className="font-display font-black uppercase tracking-widest text-2xl sm:text-3xl text-[#0E0E16] mb-5">Leaderboard</h3>
            <div className="flex flex-col gap-3">
              {leaderboard.map((p, i) => (
                <motion.div
                  key={p.playerId.toString()}
                  initial={{ x: 40, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 18, delay: i * 0.08 }}
                  className="flex items-center gap-3 bg-white border-4 border-black rounded-xl p-3 shadow-[3px_3px_0_0_#000]"
                >
                  <span className="font-display font-black text-xl text-[var(--magenta)] w-8 text-center">#{i + 1}</span>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-black" style={{ background: p.avatarColor }} />
                  <span className="flex-1 font-display font-bold uppercase text-[#0E0E16]">{p.nickname}</span>
                  <span className="font-display font-black text-[#0E0E16]"><CountUp value={p.totalScore} /></span>
                </motion.div>
              ))}
            </div>
          </BrutalCard>

          <BrutalButton
            color="magenta"
            size="xl"
            onClick={() => room && nextRound({ roomId: room.roomId })}
            className="w-full !text-2xl !py-6"
          >
            {room.currentRound >= room.totalRounds ? 'End Game' : 'Next Round'}
          </BrutalButton>
        </div>
       </div>
      </div>
    );
  }

  // ── FINISHED ──────────────────────────────────────────────────────────────
  if (room.status === 'finished') {
    const winner = leaderboard[0];
    const runnersUp = leaderboard.slice(1, 3); // 2nd & 3rd for the podium
    return (
      <div className="min-h-screen p-4 sm:p-8 flex flex-col items-center gap-8 sm:gap-14">
        {/* Champion */}
        {winner && (
          <motion.div
            className="bg-[var(--yellow)] border-4 sm:border-8 border-black rounded-[28px] sm:rounded-[48px] shadow-[8px_8px_0_0_#000] sm:shadow-[16px_16px_0_0_#000] px-6 sm:px-12 lg:px-16 py-8 sm:py-12 flex flex-col items-center text-center max-w-3xl w-full"
            initial={{ scale: 0, rotate: -6 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', bounce: 0.55 }}
          >
            <CrownIcon />
            <p className="font-display font-bold uppercase tracking-[0.25em] text-[#0E0E16]/60 text-base sm:text-xl mt-3 sm:mt-4 mb-2 sm:mb-3">Champion</p>
            <div className="flex items-center justify-center gap-3 sm:gap-4 mb-5 sm:mb-7">
              <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-full border-4 border-black flex-none" style={{ background: winner.avatarColor }} />
              <h1 className="font-display font-black uppercase text-[#0E0E16] leading-none tracking-tight" style={{ fontSize: 'clamp(2.2rem, 8vw, 6rem)' }}>{winner.nickname}</h1>
            </div>
            <div className="bg-[#0E0E16] text-white font-display font-black text-3xl sm:text-5xl px-8 sm:px-12 py-4 sm:py-5 rounded-3xl border-4 border-black -rotate-3 shadow-[8px_8px_0_0_var(--magenta)]">
              <CountUp value={winner.totalScore} /> PTS
            </div>
          </motion.div>
        )}

        {/* Podium: 2nd & 3rd */}
        {runnersUp.length > 0 && (
          <div className="flex flex-wrap justify-center gap-4 sm:gap-6 w-full max-w-3xl">
            {runnersUp.map((p, i) => (
              <motion.div
                key={p.playerId.toString()}
                className="flex-1 min-w-[150px] bg-[var(--surface)] border-4 border-black rounded-[24px] shadow-[8px_8px_0_0_#000] p-4 sm:p-6 flex items-center gap-3 sm:gap-4"
                initial={{ y: 30, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 240, damping: 18, delay: 0.2 + i * 0.1 }}
              >
                <span className="font-display font-black text-2xl sm:text-4xl text-white/40">#{i + 2}</span>
                <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full border-2 border-black flex-none" style={{ background: p.avatarColor }} />
                <span className="flex-1 font-display font-black uppercase text-xl sm:text-2xl text-white truncate">{p.nickname}</span>
                <span className="font-display font-black text-xl sm:text-2xl text-[var(--yellow)]"><CountUp value={p.totalScore} /></span>
              </motion.div>
            ))}
          </div>
        )}

        {/* Final standings */}
        <div className="max-w-[560px] mx-auto w-full">
          <h2 className="font-display font-black uppercase tracking-widest text-3xl text-white mb-5 text-center">Final Standings</h2>
          <div className="flex flex-col gap-3">
            {leaderboard.map((p, i) => (
              <motion.div
                key={p.playerId.toString()}
                className={`flex items-center gap-4 rounded-2xl border-4 px-5 py-4 shadow-[5px_5px_0_0_#000] ${i === 0 ? 'bg-[var(--yellow)] border-black' : 'bg-[var(--surface)] border-black'}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
              >
                <span className={`font-display font-black text-2xl w-10 text-center ${i === 0 ? 'text-[#0E0E16]' : 'text-white/50'}`}>#{i + 1}</span>
                <div className="w-5 h-5 rounded-full border-2 border-black flex-none" style={{ background: p.avatarColor }} />
                <span className={`flex-1 font-display font-black uppercase text-xl ${i === 0 ? 'text-[#0E0E16]' : 'text-white'}`}>{p.nickname}</span>
                <span className={`font-display font-black text-2xl ${i === 0 ? 'text-[#0E0E16]' : 'text-[var(--yellow)]'}`}><CountUp value={p.totalScore} /> pts</span>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Hall of Shame */}
        <div className="max-w-5xl mx-auto w-full">
          <h2 className="font-display font-black uppercase tracking-widest text-2xl sm:text-4xl text-[var(--red)] mb-1 text-center">Hall of Shame</h2>
          <p className="text-sm sm:text-base text-white/60 mb-5 sm:mb-7 font-display uppercase tracking-wide text-center">The 3 drawings the AI understood least</p>
          <div className="flex flex-wrap gap-4 sm:gap-6 justify-center">
            {hallOfShame.length === 0 && <p className="text-white/50 font-display uppercase text-lg sm:text-xl">No drawings to roast… yet.</p>}
            {hallOfShame.map((d, i) => {
              const p = playerMap[d.playerId.toString()];
              const word = getWordForDrawing(d);
              return (
                <motion.div
                  key={d.drawingId.toString()}
                  className="flex-1 min-w-[240px] max-w-[320px] bg-[var(--surface)] border-4 border-[var(--red)] rounded-[24px] overflow-hidden flex flex-col"
                  style={{ boxShadow: '8px 8px 0px 0px #8A0000' }}
                  initial={{ opacity: 0, y: 24, rotate: i % 2 ? 2 : -2 }}
                  animate={{ opacity: 1, y: 0, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 18, delay: i * 0.1 }}
                >
                  {d.imageUrl ? (
                    <img src={d.imageUrl} alt="drawing" className="w-full aspect-square object-cover bg-white" />
                  ) : (
                    <div className="w-full aspect-square bg-white flex items-center justify-center text-black/30 font-display uppercase">no image</div>
                  )}
                  <div className="p-5 flex flex-col gap-2.5 border-t-4 border-black">
                    <div className="flex items-center gap-2.5">
                      {p && <div className="w-4 h-4 rounded-full border-2 border-black" style={{ background: p.avatarColor }} />}
                      <span className="font-display font-black uppercase text-lg text-white">{p?.nickname ?? '?'}</span>
                      <span className="font-display uppercase text-sm text-white/50">· {word}</span>
                    </div>
                    <p className="text-sm font-display font-bold text-[var(--cyan)]">AI thought: “{d.aiGuess}”</p>
                    <p className="text-base italic text-[var(--red)] leading-snug">“{d.aiRoast}”</p>
                    <p className="font-display font-black text-3xl text-[var(--red)] mt-1">{d.roundScore} pts</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Play Again */}
        <div className="max-w-3xl mx-auto w-full flex flex-col items-center gap-4 pb-4">
          {!replayOffer ? (
            <BrutalButton color="magenta" size="xl" onClick={() => room && offerReplay({ roomId: room.roomId })}>
              Play Again
            </BrutalButton>
          ) : (
            <div className="bg-[var(--surface)] border-4 border-black rounded-[24px] shadow-[8px_8px_0_0_#000] px-10 py-7 flex flex-col items-center gap-3 w-full max-w-xl">
              <p className="font-display font-black uppercase tracking-wide text-2xl text-[var(--cyan)]">Asking players to play again…</p>
              <p className="font-display font-black text-6xl text-[var(--yellow)] tabular-nums">{replaySecsLeft}s</p>
              <p className="font-display uppercase tracking-wide text-white/70">
                <span className="text-[var(--green)] font-black">{replayYes}</span> of {players.length} said yes
              </p>
              <BrutalButton color="green" size="md" onClick={() => room && resolveReplay({ roomId: room.roomId })}>
                Start now
              </BrutalButton>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// Copy-to-clipboard button with "Copied!" feedback (presentation only)
function CopyButton({ text, label, dark }: { text: string; label: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <button
      onClick={copy}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-xl border-[3px] border-black px-3 py-1.5 font-display font-bold uppercase text-xs tracking-wide shadow-[2px_2px_0_0_#000] transition-transform hover:scale-105 active:scale-95 active:shadow-none ${
        dark ? 'bg-[#0E0E16] text-white' : 'bg-[var(--cyan)] text-[#0E0E16]'
      }`}
    >
      {copied ? (
        <>Copied</>
      ) : (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

// Clean line crown (lucide-style), presentation only
function CrownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#0E0E16" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-28 h-28">
      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z" />
      <path d="M5 21h14" />
    </svg>
  );
}

// Bouncy three-dot loader (presentation only)
function BouncyDots() {
  return (
    <div className="flex gap-2">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-3 h-3 rounded-full bg-[#0E0E16] inline-block animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
