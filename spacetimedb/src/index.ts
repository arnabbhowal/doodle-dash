import { ScheduleAt, Timestamp } from 'spacetimedb';
import { schema, table, t, SenderError } from 'spacetimedb/server';

// Fallback ONLY — the host drives scoring + reveal (see record_score_for / reveal_round).
// This timer is the backstop if the host browser crashes or closes mid-scoring, so it's
// generous: it must not race a host that's still legitimately waiting on Gemini.
const REVEAL_MICROS = 45_000_000n;
// Grace window after the round timer expires (end_round). Non-submitters are left as
// PENDING (unscored) placeholders so an in-flight auto-submit (the upload finishes a
// beat after the deadline) can still land, replace the placeholder, and get AI-scored
// before reveal. If a player genuinely never drew, this is the max extra wait before
// finalize_round scores them 0 and reveals. Must cover upload (~1-3s) + Gemini (~2-5s).
const END_GRACE_MICROS = 25_000_000n; // must exceed GRADE_WINDOW + host scoring time
// Self-grade window: once a round ends (all submitted, or timer expired) the round
// sits in 'scoring' for this long BEFORE the host starts AI-scoring, so every player —
// including the last to submit — has time to lock their self-grade. During scoring the
// round's `ends_at` is repurposed as this grade deadline (host waits for it; clients
// show the countdown). The speed bonus is only ever computed during 'drawing', so this
// reuse doesn't affect scoring.
const GRADE_WINDOW_MICROS = 10_000_000n;
// Board Hijack sabotage: how long the attacker controls the victim's canvas. The
// attacker streams pen strokes (hijack_draw) that the victim renders live. Fixed at
// 10s regardless of round duration (server validates each stroke is inside this window).
const HIJACK_DURATION_MICROS = 10_000_000n;
const MAX_PLAYERS = 16;
// Update this if needed — docs show gemini-2.5-flash as current (May 2026)
const GEMINI_MODEL = 'gemini-2.5-flash';

// ── Schedule tables ───────────────────────────────────────────────────────────
const round_timer_table = table(
  { name: 'round_timer', scheduled: (): any => end_round },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    round_id:     t.u64(),
    room_id:      t.u64(),
  }
);

const reveal_timer_table = table(
  { name: 'reveal_timer', scheduled: (): any => finalize_round },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    round_id:     t.u64(),
    room_id:      t.u64(),
  }
);

// ── Schema ────────────────────────────────────────────────────────────────────
const spacetimedb = schema({
  room: table(
    { name: 'room', public: true },
    {
      room_id:       t.u64().primaryKey().autoInc(),
      code:               t.string().unique(),
      host_identity:      t.identity(),
      status:             t.string(),
      total_rounds:       t.u32(),
      current_round:      t.u32(),
      word_source:        t.string(),
      round_duration_secs: t.u32(),
      created_at:         t.timestamp(),
    }
  ),
  player: table(
    { name: 'player', public: true },
    {
      player_id:          t.u64().primaryKey().autoInc(),
      room_id:            t.u64().index('btree'),
      identity:           t.identity().index('btree'),
      nickname:           t.string(),
      avatar_color:       t.string(),
      is_host:            t.bool(),
      total_score:        t.i32(),
      sabotage_available: t.bool(),
      connected:          t.bool(),
      joined_at:          t.timestamp(),
    }
  ),
  round: table(
    { name: 'round', public: true },
    {
      round_id:     t.u64().primaryKey().autoInc(),
      room_id:      t.u64().index('btree'),
      round_number: t.u32(),
      word:         t.string(),
      status:       t.string(),
      started_at:   t.timestamp(),
      ends_at:      t.timestamp(),
    }
  ),
  drawing: table(
    { name: 'drawing', public: true },
    {
      drawing_id:   t.u64().primaryKey().autoInc(),
      round_id:     t.u64().index('btree'),
      room_id:      t.u64().index('btree'),
      player_id:    t.u64().index('btree'),
      image_url:    t.string(),
      submitted:    t.bool(),
      seconds_left: t.u32(),
      ai_score:     t.i32(),
      ai_guess:     t.string(),
      ai_roast:     t.string(),
      round_score:  t.i32(),
      scored:       t.bool(),
    }
  ),
  sabotage: table(
    { name: 'sabotage', public: true },
    {
      sabotage_id:    t.u64().primaryKey().autoInc(),
      round_id:       t.u64().index('btree'),
      room_id:        t.u64(),
      from_player_id: t.u64(),
      to_player_id:   t.u64().index('btree'),
      effect:         t.string(),
      active:         t.bool(),
      created_at:     t.timestamp(),
    }
  ),
  word_bank: table(
    { name: 'word_bank', public: false },
    {
      word_id:  t.u64().primaryKey().autoInc(),
      text:     t.string(),
      category: t.string(),
    }
  ),
  config: table(
    { name: 'config', public: false },
    {
      id:             t.u32().primaryKey(),
      gemini_api_key: t.string(),
    }
  ),
  // Play Again: an active "play again?" offer for a finished room + per-player votes.
  replay: table(
    { name: 'replay', public: true },
    {
      room_id:  t.u64().primaryKey(),   // one active offer per room
      deadline: t.timestamp(),          // votes close here (host resolves)
    }
  ),
  replay_vote: table(
    { name: 'replay_vote', public: true },
    {
      player_id: t.u64().primaryKey(),  // one vote per player (player_id is globally unique)
      room_id:   t.u64().index('btree'),
      accept:    t.bool(),
    }
  ),
  // Self-grade bonus: the player's guess of their own AI score for the CURRENT round.
  // One row per player (overwritten each round); round_id guards against a stale guess
  // from a previous round leaking a bonus into this one.
  guess: table(
    { name: 'guess', public: true },
    {
      player_id: t.u64().primaryKey(),
      round_id:  t.u64(),
      value:     t.i32(),
    }
  ),
  // Board Hijack sabotage: a live stream of the attacker's pen strokes onto the
  // victim's canvas. One row per flushed batch (a few points). The victim subscribes
  // filtered by `to_player_id` and replays each batch onto its canvas as it arrives.
  // Coordinates are normalized 0..1 (device-independent); `size` is a fraction of the
  // victim canvas's short side. Wiped at each round start (beginRound) + on Play Again.
  hijack_point: table(
    { name: 'hijack_point', public: true },
    {
      point_id:       t.u64().primaryKey().autoInc(),
      round_id:       t.u64().index('btree'),
      room_id:        t.u64(),
      to_player_id:   t.u64().index('btree'),
      from_player_id: t.u64(),
      seq:            t.u32(),       // monotonic per attacker — victim applies in order
      pts:            t.string(),    // JSON: array of [nx, ny, down] (down=1 → new segment)
      color:          t.string(),
      size:           t.f64(),       // brush size as a fraction of the canvas short side
      created_at:     t.timestamp(),
    }
  ),
  // Board Hijack (victim → attacker): while hijacked, the victim periodically uploads a
  // snapshot of its canvas (Supabase URL) so the ATTACKER scribbles on top of the real
  // drawing instead of a blank pad. One row per victim, overwritten as the canvas
  // changes. Wiped at each round start (beginRound) + on Play Again.
  hijack_canvas: table(
    { name: 'hijack_canvas', public: true },
    {
      player_id:  t.u64().primaryKey(),  // the victim whose canvas this is
      round_id:   t.u64(),
      room_id:    t.u64(),
      image_url:  t.string(),
      updated_at: t.timestamp(),         // also a cache-buster for the attacker's <img>
    }
  ),
  // Host "Peek" — while a round runs the host can spectate live drawings. Each
  // still-drawing player periodically uploads a small snapshot here (Supabase URL),
  // gated on `spectate.active` so nothing uploads when no one is watching. One row per
  // player, overwritten; wiped at each round start + on Play Again.
  live_canvas: table(
    { name: 'live_canvas', public: true },
    {
      player_id:  t.u64().primaryKey(),
      round_id:   t.u64(),
      room_id:    t.u64().index('btree'),
      image_url:  t.string(),
      updated_at: t.timestamp(),         // cache-buster for the host <img>
    }
  ),
  // Host "Peek" toggle for a room. When active, drawing players stream their strokes.
  spectate: table(
    { name: 'spectate', public: true },
    {
      room_id: t.u64().primaryKey(),
      active:  t.bool(),
    }
  ),
  // Host "Peek" live stroke stream (read-only spectating). While peek is active, each
  // drawing player streams batches of their pen strokes here (normalized 0..1), keyed
  // by player_id (their own board). The host replays the viewed player's strokes live.
  // Wiped at each round start + on Play Again.
  peek_stroke: table(
    { name: 'peek_stroke', public: true },
    {
      stroke_id: t.u64().primaryKey().autoInc(),
      round_id:  t.u64().index('btree'),
      room_id:   t.u64().index('btree'),
      player_id: t.u64().index('btree'),
      seq:       t.u32(),
      pts:       t.string(),
      color:     t.string(),
      size:      t.f64(),
    }
  ),
  round_timer:  round_timer_table,
  reveal_timer: reveal_timer_table,
});

export default spacetimedb;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const init = spacetimedb.init(ctx => {
  if (ctx.db.config.id.find(0) === null) {
    ctx.db.config.insert({ id: 0, gemini_api_key: '' });
  }
  const existing = Array.from(ctx.db.word_bank.iter());
  if (existing.length === 0) {
    seedWords(ctx);
  }
});

// Canonical preset word bank — SIMPLE, DRAWABLE nouns only (a 30-60s phone doodle
// should be able to convey each). Deliberately excludes hard/abstract things
// (briefcase, thermometer, microscope, treasure chest, waterfall, …) that produced
// unrecognizable scribbles. Single source of truth for both init and seed_words.
const PRESET_WORDS = [
  // Animals
  'cat','dog','fish','bird','duck','owl','frog','snake','turtle','snail',
  'bee','spider','butterfly','ladybug','pig','cow','sheep','horse','rabbit','mouse',
  'fox','bear','lion','penguin','elephant','whale','dolphin','crab','shark','dinosaur',
  // Food & drink
  'apple','banana','pizza','cake','donut','cookie','ice cream','hamburger','hotdog','egg',
  'carrot','cherry','grapes','mushroom','lollipop','cupcake','fries','watermelon',
  // Objects
  'house','key','cup','balloon','kite','ball','hat','shoe','glasses','umbrella',
  'clock','book','pencil','scissors','spoon','fork','chair','bed','lamp','candle',
  'gift','crown','bell','flag','ladder','drum','guitar','anchor','sword','ring',
  // Nature
  'sun','moon','star','cloud','rainbow','tree','flower','leaf','mountain','fire',
  'snowman','cactus','heart','lightning',
  // Vehicles
  'car','bus','truck','train','boat','sailboat','plane','rocket','bike',
  // Buildings
  'tent','castle','bridge','lighthouse',
  // Fun
  'ghost','robot','alien','smiley face','crown',
];

function insertPresetWords(ctx: any): number {
  const existing = new Set(
    Array.from(ctx.db.word_bank.iter())
      .filter((w: any) => w.category === 'preset')
      .map((w: any) => w.text)
  );
  let added = 0;
  const seen = new Set<string>();
  for (const w of PRESET_WORDS) {
    if (!seen.has(w) && !existing.has(w)) {
      seen.add(w);
      ctx.db.word_bank.insert({ word_id: 0n, text: w, category: 'preset' });
      added++;
    }
  }
  return added;
}

function seedWords(ctx: any) {
  insertPresetWords(ctx);
}

// ── Reset preset word bank to the canonical list (call after publish) ─────────
// AUTHORITATIVE: deletes every existing `preset` row, then reseeds from
// PRESET_WORDS. This is what REMOVES the old hard words from a live DB (a plain
// "add missing" can't). Custom words (category `custom_<roomId>`) are untouched,
// and in-progress rounds already hold their word in the `round` row, so this is
// safe to run anytime.
export const seed_words = spacetimedb.reducer(
  (ctx) => {
    let removed = 0;
    for (const w of Array.from(ctx.db.word_bank.iter()).filter((w: any) => w.category === 'preset')) {
      ctx.db.word_bank.word_id.delete((w as any).word_id);
      removed++;
    }
    const added = insertPresetWords(ctx);
    console.log(`[seed_words] reset preset bank: removed ${removed}, added ${added}`);
  }
);

// ── Config ────────────────────────────────────────────────────────────────────
export const set_config = spacetimedb.reducer(
  { apiKey: t.string() },
  (ctx, { apiKey }) => {
    const existing = ctx.db.config.id.find(0);
    if (existing) {
      ctx.db.config.id.update({ ...existing, gemini_api_key: apiKey });
    } else {
      ctx.db.config.insert({ id: 0, gemini_api_key: apiKey });
    }
  }
);

// ── Room management ───────────────────────────────────────────────────────────
// Host is NOT a player — they are just the room controller identified by host_identity.
export const create_room = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const existing = ctx.db.room.code.find(code);
    if (existing !== null) throw new SenderError('Room code already in use');
    ctx.db.room.insert({
      room_id: 0n, code,
      host_identity: ctx.sender,
      status: 'lobby',
      total_rounds: 3,
      current_round: 0,
      word_source: 'preset',
      round_duration_secs: 60,
      created_at: ctx.timestamp,
    });
  }
);

export const join_room = spacetimedb.reducer(
  { code: t.string(), nickname: t.string(), color: t.string() },
  (ctx, { code, nickname, color }) => {
    const room = ctx.db.room.code.find(code);
    if (room === null) throw new SenderError('Room not found');
    if (room.status !== 'lobby') throw new SenderError('Game already started');
    const players = Array.from(ctx.db.player.room_id.filter(room.room_id));
    // Same identity re-joining the same room (refresh, double-tap): update the
    // existing row instead of creating a duplicate — duplicate rows in one room
    // would let player lookups pick the wrong one.
    const mine = players.find((p: any) => p.identity.isEqual(ctx.sender));
    if (mine) {
      ctx.db.player.player_id.update({ ...(mine as any), nickname, avatar_color: color, connected: true });
      return;
    }
    if (players.length >= MAX_PLAYERS) throw new SenderError('Room is full');
    ctx.db.player.insert({
      player_id: 0n,
      room_id: room.room_id,
      identity: ctx.sender,
      nickname,
      avatar_color: color,
      is_host: false,
      total_score: 0,
      sabotage_available: true,
      connected: true,
      joined_at: ctx.timestamp,
    });
  }
);

export const kick_player = spacetimedb.reducer(
  { targetPlayerId: t.u64() },
  (ctx, { targetPlayerId }) => {
    const target = ctx.db.player.player_id.find(targetPlayerId);
    if (target === null) throw new SenderError('Player not found');
    const room = ctx.db.room.room_id.find(target.room_id);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    ctx.db.player.player_id.delete(targetPlayerId);
  }
);

// ── Game control (host-only, all take roomId directly) ────────────────────────
export const start_game = spacetimedb.reducer(
  { roomId: t.u64(), totalRounds: t.u32(), wordSource: t.string(), customWords: t.string(), roundDuration: t.u32() },
  (ctx, { roomId, totalRounds, wordSource, customWords, roundDuration }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    if (room.status !== 'lobby') throw new SenderError('Game already started');
    const players = Array.from(ctx.db.player.room_id.filter(roomId));
    if (players.length < 2) throw new SenderError('Need at least 2 players');

    if (wordSource === 'custom' && customWords.trim().length > 0) {
      const tag = `custom_${roomId}`;
      const wordList = customWords.split(/[\n,]+/).map(w => w.trim()).filter(Boolean);
      for (const w of wordList) {
        ctx.db.word_bank.insert({ word_id: 0n, text: w, category: tag });
      }
    }

    const duration = roundDuration > 0 ? roundDuration : 60;
    ctx.db.room.room_id.update({ ...room, total_rounds: totalRounds, word_source: wordSource, round_duration_secs: duration });
    beginRound(ctx, roomId, 1);
  }
);

export const next_round = spacetimedb.reducer(
  { roomId: t.u64() },
  (ctx, { roomId }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');

    for (const r of ctx.db.round.room_id.filter(roomId)) {
      if (r.round_number === room.current_round) {
        ctx.db.round.round_id.update({ ...r, status: 'done' });
        break;
      }
    }

    if (room.current_round < room.total_rounds) {
      beginRound(ctx, roomId, room.current_round + 1);
    } else {
      ctx.db.room.room_id.update({ ...room, status: 'finished' });
    }
  }
);

export const end_game = spacetimedb.reducer(
  { roomId: t.u64() },
  (ctx, { roomId }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    ctx.db.room.room_id.update({ ...room, status: 'finished' });
  }
);

// ── Play Again ──────────────────────────────────────────────────────────────────
// Host opens a 10s "play again?" offer on the finished screen; players vote yes/no;
// the host resolves at the deadline (or once everyone has voted). Accepters stay in a
// fresh lobby (scores reset); everyone else is dropped from the room.

export const offer_replay = spacetimedb.reducer(
  { roomId: t.u64() },
  (ctx, { roomId }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    if (room.status !== 'finished') throw new SenderError('Game not finished');
    // Clear any stale offer + votes for this room, then open a fresh 10s window.
    if (ctx.db.replay.room_id.find(roomId)) ctx.db.replay.room_id.delete(roomId);
    for (const v of ctx.db.replay_vote.room_id.filter(roomId)) {
      ctx.db.replay_vote.player_id.delete((v as any).player_id);
    }
    ctx.db.replay.insert({
      room_id: roomId,
      deadline: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + 10_000_000n),
    });
    console.log(`[offer_replay] room=${roomId.toString()} offer opened`);
  }
);

export const vote_replay = spacetimedb.reducer(
  { roomId: t.u64(), accept: t.bool() },
  (ctx, { roomId, accept }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.db.replay.room_id.find(roomId)) return; // offer closed/never opened
    const player = findPlayerInRoom(ctx, ctx.sender, roomId);
    if (player === null) throw new SenderError('Not in this room');
    const existing = ctx.db.replay_vote.player_id.find(player.player_id);
    if (existing) ctx.db.replay_vote.player_id.update({ ...existing, room_id: roomId, accept });
    else ctx.db.replay_vote.insert({ player_id: player.player_id, room_id: roomId, accept });
  }
);

// Host calls this at the deadline (or early once all have voted). Accepters continue
// in a fresh lobby; everyone else (rejected or didn't vote) is removed from the room.
export const resolve_replay = spacetimedb.reducer(
  { roomId: t.u64() },
  (ctx, { roomId }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    if (!ctx.db.replay.room_id.find(roomId)) return; // already resolved

    const accepted = new Set<string>();
    for (const v of ctx.db.replay_vote.room_id.filter(roomId)) {
      if ((v as any).accept) accepted.add((v as any).player_id.toString());
    }

    // Keep + reset accepters; drop everyone else.
    let kept = 0;
    for (const p of Array.from(ctx.db.player.room_id.filter(roomId))) {
      if (accepted.has(p.player_id.toString())) {
        ctx.db.player.player_id.update({ ...p, total_score: 0, sabotage_available: true, connected: true });
        kept++;
      } else {
        ctx.db.player.player_id.delete(p.player_id);
      }
    }

    // Wipe the previous game's data for this room.
    for (const r of Array.from(ctx.db.round.room_id.filter(roomId))) ctx.db.round.round_id.delete(r.round_id);
    for (const d of Array.from(ctx.db.drawing.room_id.filter(roomId))) ctx.db.drawing.drawing_id.delete(d.drawing_id);
    for (const hp of Array.from(ctx.db.hijack_point.iter())) {
      if ((hp as any).room_id.toString() === roomId.toString()) ctx.db.hijack_point.point_id.delete((hp as any).point_id);
    }
    for (const hc of Array.from(ctx.db.hijack_canvas.iter())) {
      if ((hc as any).room_id.toString() === roomId.toString()) ctx.db.hijack_canvas.player_id.delete((hc as any).player_id);
    }
    for (const lc of Array.from(ctx.db.live_canvas.iter())) {
      if ((lc as any).room_id.toString() === roomId.toString()) ctx.db.live_canvas.player_id.delete((lc as any).player_id);
    }
    for (const ps of Array.from(ctx.db.peek_stroke.room_id.filter(roomId))) {
      ctx.db.peek_stroke.stroke_id.delete((ps as any).stroke_id);
    }
    if (ctx.db.spectate.room_id.find(roomId)) ctx.db.spectate.room_id.delete(roomId);
    for (const s of Array.from(ctx.db.sabotage.iter())) {
      if ((s as any).room_id.toString() === roomId.toString()) ctx.db.sabotage.sabotage_id.delete((s as any).sabotage_id);
    }
    // Custom words from the previous game (tagged custom_<roomId>) are cleared too.
    for (const w of Array.from(ctx.db.word_bank.iter())) {
      if ((w as any).category === `custom_${roomId.toString()}`) ctx.db.word_bank.word_id.delete((w as any).word_id);
    }
    for (const v of ctx.db.replay_vote.room_id.filter(roomId)) ctx.db.replay_vote.player_id.delete((v as any).player_id);
    ctx.db.replay.room_id.delete(roomId);

    ctx.db.room.room_id.update({ ...room, status: 'lobby', current_round: 0 });
    console.log(`[resolve_replay] room=${roomId.toString()} → lobby with ${kept} player(s)`);
  }
);

// ── Internal helper ───────────────────────────────────────────────────────────
function beginRound(ctx: any, roomId: bigint, n: number) {
  const room = ctx.db.room.room_id.find(roomId);
  if (!room) return;

  // Clear any leftover hijack strokes from the previous round so a victim's
  // subscription never replays stale scribbles into a fresh round.
  const roomIdStrBR = roomId.toString();
  for (const hp of Array.from(ctx.db.hijack_point.iter())) {
    if ((hp as any).room_id.toString() === roomIdStrBR) ctx.db.hijack_point.point_id.delete((hp as any).point_id);
  }
  for (const hc of Array.from(ctx.db.hijack_canvas.iter())) {
    if ((hc as any).room_id.toString() === roomIdStrBR) ctx.db.hijack_canvas.player_id.delete((hc as any).player_id);
  }
  for (const lc of Array.from(ctx.db.live_canvas.iter())) {
    if ((lc as any).room_id.toString() === roomIdStrBR) ctx.db.live_canvas.player_id.delete((lc as any).player_id);
  }
  for (const ps of Array.from(ctx.db.peek_stroke.room_id.filter(roomId))) {
    ctx.db.peek_stroke.stroke_id.delete((ps as any).stroke_id);
  }

  const tag = room.word_source === 'custom' ? `custom_${roomId}` : 'preset';
  const words = Array.from(ctx.db.word_bank.iter()).filter((w: any) => w.category === tag);
  if (words.length === 0) return;

  const usedWords = new Set(
    Array.from(ctx.db.round.room_id.filter(roomId)).map((r: any) => r.word)
  );
  const available = words.filter((w: any) => !usedWords.has(w.text));
  const pool = available.length > 0 ? available : words;

  const idx = Number(ctx.timestamp.microsSinceUnixEpoch % BigInt(pool.length));
  const word = (pool[idx] as any).text as string;

  const now = ctx.timestamp.microsSinceUnixEpoch as bigint;
  const durationMicros = BigInt(room.round_duration_secs || 60) * 1_000_000n;
  const endsAtMicros = now + durationMicros;

  ctx.db.round.insert({
    round_id: 0n, room_id: roomId,
    round_number: n, word, status: 'drawing',
    started_at: ctx.timestamp,
    ends_at: new Timestamp(endsAtMicros),
  });

  let newRound: any = null;
  for (const r of ctx.db.round.room_id.filter(roomId)) {
    if (r.round_number === n) { newRound = r; break; }
  }
  if (!newRound) return;

  ctx.db.room.room_id.update({ ...room, status: 'in_round', current_round: n });
  ctx.db.round_timer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(endsAtMicros),
    round_id: newRound.round_id,
    room_id: roomId,
  });
}

// ── Drawing submit ────────────────────────────────────────────────────────────
export const submit_drawing = spacetimedb.reducer(
  { roundId: t.u64(), imageUrl: t.string(), secondsLeft: t.u32() },
  // NOTE: the client-sent `secondsLeft` is intentionally IGNORED — the speed bonus
  // is computed from the server clock below so client clock skew / tampering can't
  // inflate it. The arg stays in the signature for binding compatibility.
  (ctx, { roundId, imageUrl }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) throw new SenderError('Round not found');
    const player = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (player === null) throw new SenderError('Not in a room');

    // Ignore submissions once the round is past scoring. Accepting one after reveal
    // would reset a drawing to unscored and strand it (the host loop and the
    // finalize backstop have both moved on). 'scoring' is still accepted: the host
    // re-scores it before the server reveals (serialized — see record_score_for).
    if (round.status !== 'drawing' && round.status !== 'scoring') return;

    const roomId = round.room_id;

    // Speed bonus from the server clock — ONLY during the 'drawing' phase. (During
    // 'scoring' the round's ends_at is repurposed as the grade deadline, so a late
    // auto-submit landing in the grade window must NOT mine a speed bonus from it.)
    const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
    const endsMicros = round.ends_at.microsSinceUnixEpoch;
    const secondsLeft = round.status === 'drawing' && endsMicros > nowMicros
      ? Math.ceil(Number(endsMicros - nowMicros) / 1_000_000)
      : 0;

    const roundIdStrSubmit = roundId.toString();
    let existing: any = null;
    for (const d of ctx.db.drawing.player_id.filter(player.player_id)) {
      if (d.round_id.toString() === roundIdStrSubmit) { existing = d; break; }
    }

    if (existing) {
      // Reset scoring fields so real AI scoring can run (placeholder may have scored=true)
      ctx.db.drawing.drawing_id.update({
        ...existing,
        submitted: true, image_url: imageUrl, seconds_left: secondsLeft,
        ai_score: -1, ai_guess: '', ai_roast: '', round_score: 0, scored: false,
      });
    } else {
      ctx.db.drawing.insert({
        drawing_id: 0n, round_id: roundId, room_id: roomId,
        player_id: player.player_id, image_url: imageUrl, submitted: true,
        seconds_left: secondsLeft, ai_score: -1, ai_guess: '', ai_roast: '',
        round_score: 0, scored: false,
      });
    }

    // End round early when every player has submitted. Iterate ALL drawings for the
    // round directly (reducers see their own writes, so the just-inserted row is
    // included) and count DISTINCT submitted players. Only from the 'drawing' phase.
    if (round.status === 'drawing') {
      const allPlayers = Array.from(ctx.db.player.room_id.filter(roomId));
      const submittedIds = new Set<string>();
      for (const d of ctx.db.drawing.round_id.filter(roundId)) {
        if ((d as any).submitted) submittedIds.add((d as any).player_id.toString());
      }
      const allDone = allPlayers.length > 0 && submittedIds.size >= allPlayers.length;
      console.log(`[submit_drawing] round=${roundIdStrSubmit} players=${allPlayers.length} submitted=${submittedIds.size} ids=[${[...submittedIds].join(',')}] allDone=${allDone}`);

      if (allDone) {
        const room = ctx.db.room.room_id.find(roomId);
        if (room) {
          console.log(`[submit_drawing] ALL submitted — ending round early`);
          // Repurpose ends_at as the grade deadline: host waits this long before scoring.
          ctx.db.round.round_id.update({ ...round, status: 'scoring', ends_at: new Timestamp(nowMicros + GRADE_WINDOW_MICROS) });
          ctx.db.room.room_id.update({ ...room, status: 'scoring' });
          for (const s of ctx.db.sabotage.round_id.filter(roundId)) {
            if ((s as any).active) ctx.db.sabotage.sabotage_id.update({ ...(s as any), active: false });
          }
          ctx.db.reveal_timer.insert({
            scheduled_id: 0n,
            scheduled_at: ScheduleAt.time(nowMicros + REVEAL_MICROS),
            round_id: roundId,
            room_id: roomId,
          });
        }
      }
    }
  }
);

// ── Self-grade bonus ────────────────────────────────────────────────────────────
// Player locks a guess of their own AI score (0-100) after submitting. If, when the
// host scores the drawing, the guess is within ±5 of the real AI score AND that base
// score is >= 20, record_score_for awards a +100 AI bonus. Must be locked BEFORE the
// drawing is scored (this just records it; the bonus is applied in record_score_for).
export const submit_guess = spacetimedb.reducer(
  { roundId: t.u64(), value: t.i32() },
  (ctx, { roundId, value }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) throw new SenderError('Round not found');
    const player = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (player === null) throw new SenderError('Not in a room');
    const v = Math.max(0, Math.min(100, value));
    const existing = ctx.db.guess.player_id.find(player.player_id);
    if (existing) ctx.db.guess.player_id.update({ ...existing, round_id: roundId, value: v });
    else ctx.db.guess.insert({ player_id: player.player_id, round_id: roundId, value: v });
  }
);

// Host cuts the grade window short once every submitter has locked a guess — no point
// waiting out the full 10s. Only ever SHORTENS the window (moves ends_at to now); the
// host's scoring loop polls ends_at, and clients' countdowns drop to 0 immediately.
export const close_grading = spacetimedb.reducer(
  { roundId: t.u64() },
  (ctx, { roundId }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) return;
    const room = ctx.db.room.room_id.find(round.room_id);
    if (room === null || !ctx.sender.isEqual(room.host_identity)) return;
    if (round.status !== 'scoring') return;
    if (round.ends_at.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) {
      ctx.db.round.round_id.update({ ...round, ends_at: ctx.timestamp });
    }
  }
);

// ── Sabotage ──────────────────────────────────────────────────────────────────
export const use_sabotage = spacetimedb.reducer(
  { roundId: t.u64(), targetPlayerId: t.u64(), effect: t.string() },
  (ctx, { roundId, targetPlayerId, effect }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) throw new SenderError('Round not found');
    const player = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (player === null) throw new SenderError('Not in a room');
    if (!player.sabotage_available) throw new SenderError('Sabotage already used');

    let hasSubmitted = false;
    const roundIdStrSab = roundId.toString();
    for (const d of ctx.db.drawing.player_id.filter(player.player_id)) {
      if (d.round_id.toString() === roundIdStrSab && d.submitted) { hasSubmitted = true; break; }
    }
    if (!hasSubmitted) throw new SenderError('Must submit your drawing first');

    // The victim must NOT have already submitted this round. The client menu hides
    // submitted targets in real time, but make it authoritative here so a race
    // (victim submits between menu render and launch) can't land a useless sabotage.
    let targetSubmitted = false;
    for (const d of ctx.db.drawing.player_id.filter(targetPlayerId)) {
      if (d.round_id.toString() === roundIdStrSab && d.submitted) { targetSubmitted = true; break; }
    }
    if (targetSubmitted) throw new SenderError('That player already submitted');

    ctx.db.player.player_id.update({ ...player, sabotage_available: false });
    ctx.db.sabotage.insert({
      sabotage_id: 0n, round_id: roundId, room_id: player.room_id,
      from_player_id: player.player_id, to_player_id: targetPlayerId,
      effect, active: true, created_at: ctx.timestamp,
    });
  }
);

// ── Board Hijack: ONE shared board per victim (victim + N attackers) ────────────
// `to_player_id` is the BOARD — i.e. the hijacked victim. Every participant (the
// victim AND every attacker who hijacked them this round) addresses their strokes to
// this board and subscribes to it, so an arbitrary number of people can scribble on
// the same canvas together and all see each other's strokes. Authorize the caller as
// a participant of the board: the victim drawing on their own board, OR an attacker
// who holds an active 'hijack' sabotage on this victim (within the 10s window, while
// 'drawing'). The hijack ends the instant the victim submits.
export const hijack_draw = spacetimedb.reducer(
  { roundId: t.u64(), toPlayerId: t.u64(), seq: t.u32(), pts: t.string(), color: t.string(), size: t.f64() },
  (ctx, { roundId, toPlayerId, seq, pts, color, size }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null || round.status !== 'drawing') return;
    const caller = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (caller === null) return;

    const victimId = toPlayerId; // the board
    const roundIdStr = roundId.toString();
    const callerIdStr = caller.player_id.toString();
    const callerIsVictim = callerIdStr === victimId.toString();
    const nowMicros = ctx.timestamp.microsSinceUnixEpoch as bigint;

    // The board exists only while ≥1 active hijack targets the victim. The victim may
    // draw on it freely; an attacker must own one of those sabotages.
    let authorized = false;
    for (const s of ctx.db.sabotage.to_player_id.filter(victimId)) {
      const ss = s as any;
      if (!(ss.active && ss.effect === 'hijack' && ss.round_id.toString() === roundIdStr &&
            nowMicros <= (ss.created_at.microsSinceUnixEpoch as bigint) + HIJACK_DURATION_MICROS)) continue;
      if (callerIsVictim || ss.from_player_id.toString() === callerIdStr) { authorized = true; break; }
    }
    if (!authorized) return;

    // The hijack ends the moment the victim submits — drop strokes from everyone.
    for (const d of ctx.db.drawing.player_id.filter(victimId)) {
      if ((d as any).round_id.toString() === roundIdStr && (d as any).submitted) return;
    }

    ctx.db.hijack_point.insert({
      point_id: 0n, round_id: roundId, room_id: round.room_id,
      to_player_id: victimId, from_player_id: caller.player_id,
      seq, pts, color, size, created_at: ctx.timestamp,
    });
  }
);

// ── Board Hijack: victim publishes a snapshot of its canvas for the attacker ────
// While hijacked, the victim uploads its current drawing to Supabase and records the
// URL here so the attacker can scribble on top of the real drawing. Authoritative
// guards mirror hijack_draw: only the targeted victim, only during an active hijack
// window, only while drawing (and not after they've submitted).
export const set_hijack_canvas = spacetimedb.reducer(
  { roundId: t.u64(), imageUrl: t.string() },
  (ctx, { roundId, imageUrl }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null || round.status !== 'drawing') return;
    const victim = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (victim === null) return;

    const roundIdStr = roundId.toString();
    const nowMicros = ctx.timestamp.microsSinceUnixEpoch as bigint;
    let targeted = false;
    for (const s of ctx.db.sabotage.to_player_id.filter(victim.player_id)) {
      const ss = s as any;
      if (ss.active && ss.effect === 'hijack' &&
          ss.round_id.toString() === roundIdStr &&
          nowMicros <= (ss.created_at.microsSinceUnixEpoch as bigint) + HIJACK_DURATION_MICROS) {
        targeted = true;
        break;
      }
    }
    if (!targeted) return;

    const existing = ctx.db.hijack_canvas.player_id.find(victim.player_id);
    if (existing) {
      ctx.db.hijack_canvas.player_id.update({ ...existing, round_id: roundId, room_id: round.room_id, image_url: imageUrl, updated_at: ctx.timestamp });
    } else {
      ctx.db.hijack_canvas.insert({ player_id: victim.player_id, round_id: roundId, room_id: round.room_id, image_url: imageUrl, updated_at: ctx.timestamp });
    }
  }
);

// ── Host "Peek": spectate live drawings ────────────────────────────────────────
// Host toggles spectate mode for the room; while active, players publish snapshots.
export const set_spectate = spacetimedb.reducer(
  { roomId: t.u64(), active: t.bool() },
  (ctx, { roomId, active }) => {
    const room = ctx.db.room.room_id.find(roomId);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');
    const existing = ctx.db.spectate.room_id.find(roomId);
    if (existing) ctx.db.spectate.room_id.update({ ...existing, active });
    else ctx.db.spectate.insert({ room_id: roomId, active });
  }
);

// A player publishes a snapshot of their in-progress canvas (only while drawing). The
// client only calls this when the host is peeking (spectate.active), so it's cheap.
export const set_live_canvas = spacetimedb.reducer(
  { roundId: t.u64(), imageUrl: t.string() },
  (ctx, { roundId, imageUrl }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null || round.status !== 'drawing') return;
    const player = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (player === null) return;
    const existing = ctx.db.live_canvas.player_id.find(player.player_id);
    if (existing) {
      ctx.db.live_canvas.player_id.update({ ...existing, round_id: roundId, room_id: round.room_id, image_url: imageUrl, updated_at: ctx.timestamp });
    } else {
      ctx.db.live_canvas.insert({ player_id: player.player_id, round_id: roundId, room_id: round.room_id, image_url: imageUrl, updated_at: ctx.timestamp });
    }
  }
);

// A drawing player streams a batch of their pen strokes for the host's live Peek view.
// Only while the round is drawing AND the host is peeking (spectate active). Keyed by
// the caller's player_id (their own board); the host replays whichever it's viewing.
export const peek_draw = spacetimedb.reducer(
  { roundId: t.u64(), seq: t.u32(), pts: t.string(), color: t.string(), size: t.f64() },
  (ctx, { roundId, seq, pts, color, size }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null || round.status !== 'drawing') return;
    const spec = ctx.db.spectate.room_id.find(round.room_id);
    if (!spec || !spec.active) return;
    const player = findPlayerInRoom(ctx, ctx.sender, round.room_id);
    if (player === null) return;
    ctx.db.peek_stroke.insert({
      stroke_id: 0n, round_id: roundId, room_id: round.room_id,
      player_id: player.player_id, seq, pts, color, size,
    });
  }
);

// ── Scheduled: end round ──────────────────────────────────────────────────────
export const end_round = spacetimedb.reducer(
  { arg: round_timer_table.rowType },
  (ctx, { arg }) => {
    const { round_id, room_id } = arg;
    const round = ctx.db.round.round_id.find(round_id);
    if (!round || round.status !== 'drawing') return;

    // Repurpose ends_at as the grade deadline (host waits this long before scoring).
    ctx.db.round.round_id.update({ ...round, status: 'scoring', ends_at: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + GRADE_WINDOW_MICROS) });
    const room = ctx.db.room.room_id.find(room_id);
    if (room) ctx.db.room.room_id.update({ ...room, status: 'scoring' });

    const roundIdStrEnd = round_id.toString();
    const players = Array.from(ctx.db.player.room_id.filter(room_id));
    for (const player of players) {
      let submitted = false;
      for (const d of ctx.db.drawing.player_id.filter(player.player_id)) {
        if (d.round_id.toString() === roundIdStrEnd && d.submitted) { submitted = true; break; }
      }
      if (!submitted) {
        // PENDING placeholder — submitted=false, UNSCORED. This deliberately keeps the
        // round from revealing (record_score_for / roundFullyScored require every
        // drawing scored) so a player's in-flight auto-submit — whose upload finishes a
        // beat AFTER the deadline — can still land during 'scoring', replace this row,
        // and be AI-scored. If they genuinely never drew, finalize_round (the grace
        // backstop below) scores it 0 and reveals. This is what fixes "timed out → 0
        // even though I drew something".
        ctx.db.drawing.insert({
          drawing_id: 0n, round_id, room_id, player_id: player.player_id,
          image_url: '', submitted: false, seconds_left: 0, ai_score: -1,
          ai_guess: '', ai_roast: '',
          round_score: 0, scored: false,
        });
      }
    }

    for (const s of ctx.db.sabotage.round_id.filter(round_id)) {
      if (s.active) ctx.db.sabotage.sabotage_id.update({ ...s, active: false });
    }

    // Schedule the grace backstop. Reveal normally happens earlier — as soon as every
    // drawing is scored (record_score_for) once any in-flight auto-submits have landed
    // and been scored. This timer only fires if something is still unscored after the
    // grace (e.g., a player who truly never drew).
    const revealAt = ctx.timestamp.microsSinceUnixEpoch + END_GRACE_MICROS;
    ctx.db.reveal_timer.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(revealAt),
      round_id, room_id,
    });
  }
);

// ── Scheduled: reveal ─────────────────────────────────────────────────────────
export const finalize_round = spacetimedb.reducer(
  { arg: reveal_timer_table.rowType },
  (ctx, { arg }) => {
    const { round_id, room_id } = arg;
    const round = ctx.db.round.round_id.find(round_id);
    if (!round || round.status !== 'scoring') return; // already revealed (scoring finished early)

    // Safety net: finalize EVERY still-unscored drawing so nothing is stranded at -1
    // and the round can reveal.
    //  • a real submitted drawing the host never scored → speed-only score.
    //  • a PENDING non-submitter placeholder (never drew, or upload failed) → honest 0.
    for (const d of ctx.db.drawing.round_id.filter(round_id)) {
      const dd = d as any;
      if (dd.scored && dd.ai_score >= 0) continue; // already done
      const drew = dd.submitted && dd.image_url;
      const roundScore = drew ? dd.seconds_left : 0;
      ctx.db.drawing.drawing_id.update({
        ...dd,
        submitted: true,
        ai_score: 0,
        ai_guess: dd.ai_guess || '',
        ai_roast: dd.ai_roast || (drew ? 'The AI ran out of time to judge this one.' : "Didn't even try. Bold."),
        round_score: roundScore, scored: true,
      });
      if (roundScore > 0) {
        const p = ctx.db.player.player_id.find(dd.player_id);
        if (p) ctx.db.player.player_id.update({ ...p, total_score: p.total_score + roundScore });
      }
      console.log(`[finalize_round] forced score drawing=${dd.drawing_id} = ${roundScore} (${drew ? 'speed only' : 'no drawing'})`);
    }

    ctx.db.round.round_id.update({ ...round, status: 'reveal' });
    const room = ctx.db.room.room_id.find(room_id);
    if (room) ctx.db.room.room_id.update({ ...room, status: 'reveal' });
  }
);

// ── Record score (reducer) ────────────────────────────────────────────────────
// The procedure does the HTTP call and RETURNS the result. The client then calls
// THIS reducer to persist it. Writing from a reducer (not the procedure) guarantees
// a consistent view of the drawing row that submit_drawing inserted — no race.
export const record_score = spacetimedb.reducer(
  { roundId: t.u64(), score: t.i32(), guess: t.string(), roast: t.string() },
  (ctx, { roundId, score, guess, roast }) => {
    const round0 = ctx.db.round.round_id.find(roundId);
    if (round0 === null) throw new SenderError('Round not found');
    const player = findPlayerInRoom(ctx, ctx.sender, round0.room_id);
    if (player === null) throw new SenderError('Not in a room');

    const roundIdStr = roundId.toString();
    let drawing: any = null;
    for (const d of ctx.db.drawing.player_id.filter(player.player_id)) {
      if (d.round_id.toString() === roundIdStr) { drawing = d; break; }
    }
    if (!drawing) {
      console.log(`[record_score] NO drawing player=${player.player_id} round=${roundIdStr}`);
      return;
    }
    // Idempotent: once a real AI score is recorded, never re-apply.
    if (drawing.scored && drawing.ai_score >= 0) {
      console.log(`[record_score] already scored drawing=${drawing.drawing_id}, skip`);
      return;
    }

    const clamped = Math.max(0, Math.min(100, score));
    const roundScore = clamped + drawing.seconds_left;

    ctx.db.drawing.drawing_id.update({
      ...drawing, ai_score: clamped, ai_guess: guess, ai_roast: roast,
      round_score: roundScore, scored: true,
    });
    const p = ctx.db.player.player_id.find(player.player_id);
    if (p) {
      ctx.db.player.player_id.update({ ...p, total_score: p.total_score + roundScore });
    }
    console.log(`[record_score] player=${player.player_id} round=${roundIdStr} ai=${clamped} +speed=${drawing.seconds_left} = ${roundScore}`);

    // Server-driven reveal: once every drawing in this round is scored, flip to
    // reveal immediately so players never see a premature 0 on the leaderboard.
    const roomId = drawing.room_id as bigint;
    const round = ctx.db.round.round_id.find(drawing.round_id);
    if (round && round.status === 'scoring') {
      const roundDrawings = Array.from(ctx.db.drawing.round_id.filter(drawing.round_id));
      const allScored = roundDrawings.length > 0 && roundDrawings.every((d: any) => d.scored && d.ai_score >= 0);
      if (allScored) {
        console.log(`[record_score] all ${roundDrawings.length} drawings scored — revealing round ${roundIdStr}`);
        ctx.db.round.round_id.update({ ...round, status: 'reveal' });
        const room = ctx.db.room.room_id.find(roomId);
        if (room && room.status === 'scoring') ctx.db.room.room_id.update({ ...room, status: 'reveal' });
      }
    }
  }
);

// ── Record score (host-driven) ────────────────────────────────────────────────
// Host-authorized variant: the HOST screen scores EVERY drawing (it awaits all
// Gemini calls, then persists) so scoring never depends on a fragile per-phone
// call. Takes player_id explicitly (the caller is the host identity, not a player).
// Idempotent and consistent: updates the drawing + that player's total atomically.
export const record_score_for = spacetimedb.reducer(
  { roundId: t.u64(), playerId: t.u64(), score: t.i32(), guess: t.string(), roast: t.string() },
  (ctx, { roundId, playerId, score, guess, roast }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) throw new SenderError('Round not found');
    const room = ctx.db.room.room_id.find(round.room_id);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');

    const roundIdStr = roundId.toString();
    const playerIdStr = playerId.toString();
    let drawing: any = null;
    for (const d of ctx.db.drawing.round_id.filter(roundId)) {
      if ((d as any).player_id.toString() === playerIdStr) { drawing = d; break; }
    }
    if (!drawing) {
      console.log(`[record_score_for] NO drawing player=${playerIdStr} round=${roundIdStr}`);
      return;
    }
    // Idempotent: once a real AI score is recorded, never re-apply (prevents the
    // double-count that would happen if the host + fallback both ran).
    if (drawing.scored && drawing.ai_score >= 0) {
      console.log(`[record_score_for] already scored drawing=${drawing.drawing_id}, skip`);
      return;
    }

    const clamped = Math.max(0, Math.min(100, score));
    // Self-grade bonus: +100 to the AI score if the player locked a guess for THIS
    // round, the base AI score is >= 20, and the guess is within ±5 of it. The stored
    // ai_score therefore exceeds 100 only when bonused (120-200) — the client uses
    // `ai_score > 100` to show the BONUS celebration, no extra column needed.
    let aiScore = clamped;
    let bonus = false;
    const g = ctx.db.guess.player_id.find(playerId);
    if (g && g.round_id.toString() === roundIdStr && clamped >= 20 && Math.abs(g.value - clamped) <= 5) {
      aiScore = clamped + 100;
      bonus = true;
    }
    const roundScore = aiScore + drawing.seconds_left;
    ctx.db.drawing.drawing_id.update({
      ...drawing, ai_score: aiScore, ai_guess: guess, ai_roast: roast,
      round_score: roundScore, scored: true,
    });
    const p = ctx.db.player.player_id.find(drawing.player_id);
    if (p) ctx.db.player.player_id.update({ ...p, total_score: p.total_score + roundScore });
    console.log(`[record_score_for] player=${playerIdStr} round=${roundIdStr} ai=${clamped}${bonus ? ` +100 BONUS(guess=${g!.value})` : ''} +speed=${drawing.seconds_left} = ${roundScore}`);

    // Server-driven reveal: when every drawing in this round has a real score, flip
    // to 'reveal' here, atomically. This is the SINGLE source of truth for reveal —
    // the host never reveals from the client, so nothing can race ahead of a score
    // and the finalize_round backstop can never be defeated by a premature reveal.
    // Reducers are serialized, so whichever record_score_for commits last sees the
    // full set scored and performs the flip exactly once.
    if (round.status === 'scoring') {
      const roundDrawings = Array.from(ctx.db.drawing.round_id.filter(roundId));
      const allScored = roundDrawings.length > 0 && roundDrawings.every((d: any) => d.scored && d.ai_score >= 0);
      if (allScored) {
        console.log(`[record_score_for] all ${roundDrawings.length} drawings scored — revealing round ${roundIdStr}`);
        ctx.db.round.round_id.update({ ...round, status: 'reveal' });
        if (room.status === 'scoring') ctx.db.room.room_id.update({ ...room, status: 'reveal' });
      }
    }
  }
);

// ── Reveal (host-driven) ──────────────────────────────────────────────────────
// The host calls this AFTER it has finished scoring every drawing (awaited all
// Gemini results), flipping the round + room from 'scoring' to 'reveal'. The
// reveal_timer/finalize_round path remains only as a crash backstop.
export const reveal_round = spacetimedb.reducer(
  { roundId: t.u64() },
  (ctx, { roundId }) => {
    const round = ctx.db.round.round_id.find(roundId);
    if (round === null) throw new SenderError('Round not found');
    const room = ctx.db.room.room_id.find(round.room_id);
    if (room === null) throw new SenderError('Room not found');
    if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');

    if (round.status === 'scoring') ctx.db.round.round_id.update({ ...round, status: 'reveal' });
    if (room.status === 'scoring') ctx.db.room.room_id.update({ ...room, status: 'reveal' });
    console.log(`[reveal_round] round=${roundId.toString()} → reveal`);
  }
);

// ── Procedures ────────────────────────────────────────────────────────────────
// score_drawing does ONLY the HTTP call and returns JSON. No DB writes (avoids the
// procedure-vs-reducer race). Client persists via the record_score reducer.
export const score_drawing = spacetimedb.procedure(
  { imageBase64: t.string(), word: t.string() },
  t.string(),
  (ctx, { imageBase64, word }) => {
    const apiKey = ctx.withTx(txCtx => txCtx.db.config.id.find(0)?.gemini_api_key ?? '');

    // ok=false means "no real AI result" (rate-limited / error / unparseable). The
    // caller (host) must NOT persist a false result as a final score — it retries or
    // falls back to a speed-only score. This is what keeps a 429 from silently
    // locking a player at 0.
    let ok = false;
    let score = 0, guess = '', roast = "The AI couldn't make sense of it. That's on you.";

    if (!apiKey) {
      console.log('[score_drawing] ERROR: empty API key — call set_config first');
      return JSON.stringify({ ok, score, guess, roast });
    }

    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      try {
        const res = ctx.http.fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: buildScoringPrompt(word) },
                  { inlineData: { mimeType: 'image/png', data: imageBase64 } },
                ],
              }],
              generationConfig: {
                temperature: 0,        // deterministic: same drawing → same scores
                topK: 1,
                maxOutputTokens: 500,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          }
        );
        console.log(`[score_drawing] HTTP ${res.status} word=${word}`);
        if (res.status === 200) {
          const raw = extractGeminiText(res.text());
          const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
          try {
            const parsed = JSON.parse(jsonStr);
            // Total is computed server-side as the SUM of the rubric components (each
            // clamped to its own scale), so the score is consistent with the parts and
            // spans the full 0-100. Falls back to a legacy flat `score` if present.
            const clampN = (v: any, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
            if (parsed.identifiability !== undefined || parsed.key_features !== undefined) {
              const ident = clampN(parsed.identifiability, 50);
              const feat  = clampN(parsed.key_features, 30);
              const form  = clampN(parsed.form, 15);
              const eff   = clampN(parsed.effort, 5);
              score = ident + feat + form + eff;
              console.log(`[score_drawing] OK rubric id=${ident} feat=${feat} form=${form} eff=${eff} → ${score}`);
            } else {
              score = clampN(parsed.score, 100);
              console.log(`[score_drawing] OK score=${score} (flat)`);
            }
            guess = String(parsed.looks_like ?? parsed.guess ?? '');
            roast = String(parsed.roast ?? roast);
            ok = true;
          } catch (pe) {
            console.log(`[score_drawing] JSON parse error: ${pe} raw="${raw.slice(0, 120)}"`);
          }
          break;
        } else if (res.status < 500) {
          console.log(`[score_drawing] 4xx body: ${res.text().slice(0, 160)}`);
          break;
        }
      } catch (e) {
        console.log(`[score_drawing] fetch error: ${e}`);
        break;
      }
    }

    return JSON.stringify({ ok, score, guess, roast });
  }
);

export const roast_in_progress = spacetimedb.procedure(
  { imageBase64: t.string(), word: t.string() },
  t.string(),
  (ctx, { imageBase64, word }) => {
    const apiKey = ctx.withTx(txCtx => {
      const cfg = txCtx.db.config.id.find(0);
      return cfg?.gemini_api_key ?? '';
    });

    if (!apiKey) return '';

    try {
      const res = ctx.http.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: buildRoastPrompt(word) },
                { inlineData: { mimeType: 'image/png', data: imageBase64 } },
              ],
            }],
            generationConfig: {
              temperature: 0.8,
              maxOutputTokens: 200,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        }
      );
      if (res.status === 200) {
        return extractGeminiText(res.text()).trim();
      }
    } catch { /* swallow */ }
    return '';
  }
);

// ── Prompt helpers ────────────────────────────────────────────────────────────
function buildScoringPrompt(word: string): string {
  return `You are a STRICT, CONSISTENT rubric-based judge for a drawing game. The player tried to draw "${word}". Grade ONLY what is actually on the canvas (ignore intent). Be deterministic: the same drawing must always get the same numbers — judge by the fixed rubric below, not by gut feeling.

First, silently identify the 4-6 ESSENTIAL visual features that make something read as a "${word}" (e.g. for a cat: round head, pointy ears, whiskers, body, 4 legs, tail). Then fill out this rubric, scoring each part independently and literally:

1. identifiability (integer 0-50): If a stranger who did NOT know the word saw only this drawing, how confidently would they name it "${word}"?
   - 0-9: they'd never guess ${word} (blank, scribble, or clearly something else).
   - 10-24: ${word} is a long shot among several guesses.
   - 25-37: ${word} is a plausible guess but ambiguous.
   - 38-46: they'd probably say ${word}.
   - 47-50: they'd instantly and certainly say ${word}.

2. key_features (integer 0-30): Of the essential features you listed, what fraction are actually present AND clearly drawn? Award strictly in proportion (none=0, about half=15, all=30). No credit for features you cannot see.

3. form (integer 0-15): Are the overall shape, proportions and layout correct — parts the right size, in the right place, not jumbled? 0=shapeless, 7=roughly right, 15=well-proportioned.

4. effort (integer 0-5): 0=blank or one random line/scribble, 3=a basic but complete attempt, 5=a clearly finished, detailed drawing.

Hard rules:
- Score each component on its OWN scale and be harsh + literal. Do NOT output a total — it is computed as the sum of the four, so the full 0-100 range is used automatically.
- A crude-but-recognizable ${word} typically lands near identifiability 30, key_features 18, form 9, effort 4 (= 61). Reserve near-max identifiability for drawings anyone would instantly name.
- Identical drawings MUST get identical component scores.

Also provide:
- "looks_like": 1-4 words describing what the drawing actually resembles to a neutral viewer (can be funny if wildly off).
- "roast": ONE short, sharp, clever burn about the DRAWING. Max 12 words; dry, deadpan, observational wit (a fitting pop-culture reference is a plus). BANNED: "your mom", profanity, slurs, body-shaming, anything about the person — roast the drawing only.

Respond with STRICT JSON only — no markdown, no code fences, no extra text:
{"identifiability": <int 0-50>, "key_features": <int 0-30>, "form": <int 0-15>, "effort": <int 0-5>, "looks_like": "<1-4 words>", "roast": "<one short punchy line>"}`;
}

function buildRoastPrompt(word: string): string {
  return `You are a deadpan AI art critic watching someone draw "${word}" on their phone right now, mid-attempt. Drop ONE short, clever burn about what's on the canvas so far. HARD RULES: max 10 words; dry and observational, not goofy; a fitting pop-culture reference (movies, tech, games, art, internet) is a plus; be harsh about the DRAWING, never the person; no profanity, no "your mom". Smart-harsh, not crude. Style to aim for (don't copy): "Is that a ${word} or a hostage situation?", "Ctrl+Z exists, you know.", "The AI is buffering its disappointment." Respond with the single line only — no quotes, no JSON.`;
}

// ── Gemini response parser ────────────────────────────────────────────────────
// With thinkingBudget=0 Gemini returns a single multi-line JSON object.
// Without it, it streams NDJSON (one JSON object per line). Handle both.
function extractGeminiText(body: string): string {
  // Try full body as one complete JSON object first (non-streaming / thinkingBudget=0)
  try {
    const obj = JSON.parse(body);
    const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text === 'string') return text;
  } catch {}
  // Fall back to NDJSON: accumulate text from each line that parses as JSON
  let out = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsonLine = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
    try {
      const obj = JSON.parse(jsonLine);
      const chunk = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof chunk === 'string') out += chunk;
    } catch {}
  }
  return out;
}

// ── Utility ───────────────────────────────────────────────────────────────────
// Find the caller's player row IN A SPECIFIC ROOM. A returning player reuses their
// anonymous identity, so the same identity can have MANY player rows (one per game
// they've played). Matching identity alone returns an arbitrary/stale row from the
// index, which mis-attributes drawings, scores, submitted-state and sabotage to a
// player in a different room. Always scope by room_id.
function findPlayerInRoom(ctx: any, identity: any, roomId: bigint): any {
  const roomIdStr = roomId.toString();
  for (const p of ctx.db.player.identity.filter(identity)) {
    if (p.room_id.toString() === roomIdStr) return p;
  }
  return null;
}
