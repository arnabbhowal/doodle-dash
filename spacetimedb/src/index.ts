import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration } from 'spacetimedb';

// -----------------------------------------------------------------------------
// Tables Schema Definitions
// -----------------------------------------------------------------------------

const room = table(
  { name: 'room', public: true },
  {
    room_id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    host_identity: t.identity(),
    status: t.string(), // 'lobby' | 'in_round' | 'scoring' | 'reveal' | 'finished'
    total_rounds: t.u32(),
    current_round: t.u32(),
    word_source: t.string(), // 'preset' | 'custom'
    created_at: t.u64(), // Microseconds since Unix Epoch
  }
);

const player = table(
  { name: 'player', public: true },
  {
    player_id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    identity: t.identity().index('btree'),
    nickname: t.string(),
    avatar_color: t.string(),
    is_host: t.bool(),
    total_score: t.i32(),
    sabotage_available: t.bool(),
    connected: t.bool(),
    joined_at: t.u64(),
  }
);

const round = table(
  { name: 'round', public: true },
  {
    round_id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    round_number: t.u32(),
    word: t.string(),
    status: t.string(), // 'drawing' | 'scoring' | 'reveal' | 'done'
    started_at: t.u64(),
    ends_at: t.u64(),
  }
);

const drawing = table(
  { name: 'drawing', public: true },
  {
    drawing_id: t.u64().primaryKey().autoInc(),
    round_id: t.u64().index('btree'),
    room_id: t.u64().index('btree'),
    player_id: t.u64().index('btree'),
    image_url: t.string(),
    submitted: t.bool(),
    seconds_left: t.u32(),
    ai_score: t.i32(),
    ai_guess: t.string(),
    ai_roast: t.string(),
    round_score: t.i32(),
    scored: t.bool(),
  }
);

const sabotage = table(
  { name: 'sabotage', public: true },
  {
    sabotage_id: t.u64().primaryKey().autoInc(),
    round_id: t.u64().index('btree'),
    room_id: t.u64(),
    from_player_id: t.u64(),
    to_player_id: t.u64().index('btree'),
    effect: t.string(), // 'invert' | 'giant_brush' | 'invisible_ink' | 'spin' | 'fake_popup'
    active: t.bool(),
    created_at: t.u64(),
  }
);

const word_bank = table(
  { name: 'word_bank', public: false },
  {
    word_id: t.u64().primaryKey().autoInc(),
    text: t.string(),
    category: t.option(t.string()),
  }
);

const config = table(
  { name: 'config', public: false },
  {
    id: t.u32().primaryKey(), // always 0
    gemini_api_key: t.string(),
  }
);

const round_timer = table(
  { name: 'round_timer', scheduled: (): any => end_round },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    round_id: t.u64(),
    room_id: t.u64(),
  }
);

const reveal_timer = table(
  { name: 'reveal_timer', scheduled: (): any => finalize_round },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    round_id: t.u64(),
    room_id: t.u64(),
  }
);

// -----------------------------------------------------------------------------
// Schema Export
// -----------------------------------------------------------------------------

const spacetimedb = schema({
  room,
  player,
  round,
  drawing,
  sabotage,
  word_bank,
  config,
  round_timer,
  reveal_timer,
});
export default spacetimedb;

// -----------------------------------------------------------------------------
// Lifecycle Hooks & Seeding
// -----------------------------------------------------------------------------

const presetWords = [
  "umbrella", "banana", "pizza", "guitar", "laptop", "tree", "dog", "cat", "car", "bicycle",
  "house", "flower", "sun", "moon", "chair", "elephant", "penguin", "giraffe", "coffee cup", "hat",
  "sock", "clock", "fish", "bird", "airplane", "ship", "apple", "carrot", "ice cream", "cookie",
  "hamburger", "donut", "spider", "butterfly", "snake", "frog", "cactus", "mountain", "cloud", "rain",
  "snowman", "heart", "star", "key", "hammer", "scissors", "book", "pencil", "glasses", "candle"
];

export const init = spacetimedb.init((ctx) => {
  // Check config
  if (!ctx.db.config.id.find(0)) {
    ctx.db.config.insert({ id: 0, gemini_api_key: "" });
  }

  // Seed word bank if empty
  const currentCount = [...ctx.db.word_bank.iter()].length;
  if (currentCount === 0) {
    for (const w of presetWords) {
      ctx.db.word_bank.insert({ word_id: 0n, text: w, category: undefined });
    }
  }
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const players = [...ctx.db.player.identity.filter(ctx.sender)];
  for (const p of players) {
    ctx.db.player.player_id.update({ ...p, connected: true });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const players = [...ctx.db.player.identity.filter(ctx.sender)];
  for (const p of players) {
    ctx.db.player.player_id.update({ ...p, connected: false });
  }
});

// -----------------------------------------------------------------------------
// Reducers (State Mutations)
// -----------------------------------------------------------------------------

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

export const create_room = spacetimedb.reducer(
  { code: t.string(), nickname: t.string(), color: t.string() },
  (ctx, { code, nickname, color }) => {
    // Check if code is already used by an active room
    const existingRooms = [...ctx.db.room.iter()].filter(r => r.code === code && r.status !== 'finished');
    if (existingRooms.length > 0) {
      throw new Error("Room code already in use");
    }

    const newRoom = ctx.db.room.insert({
      room_id: 0n,
      code,
      host_identity: ctx.sender,
      status: 'lobby',
      total_rounds: 3,
      current_round: 0,
      word_source: 'preset',
      created_at: ctx.timestamp.microsSinceUnixEpoch,
    });

    ctx.db.player.insert({
      player_id: 0n,
      room_id: newRoom.room_id,
      identity: ctx.sender,
      nickname,
      avatar_color: color,
      is_host: true,
      total_score: 0,
      sabotage_available: true,
      connected: true,
      joined_at: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const join_room = spacetimedb.reducer(
  { code: t.string(), nickname: t.string(), color: t.string() },
  (ctx, { code, nickname, color }) => {
    const rm = [...ctx.db.room.iter()].find(r => r.code === code);
    if (!rm) {
      throw new Error("Room not found");
    }
    if (rm.status !== 'lobby') {
      throw new Error("Game already in progress or finished");
    }

    const currentPlayers = [...ctx.db.player.room_id.filter(rm.room_id)];
    if (currentPlayers.length >= 16) {
      throw new Error("Room is full");
    }

    // Check if player with same identity is already in the room
    const existingPlayer = currentPlayers.find(p => p.identity.equals(ctx.sender));
    if (existingPlayer) {
      // Reconnect/re-use player row
      ctx.db.player.player_id.update({
        ...existingPlayer,
        nickname,
        avatar_color: color,
        connected: true,
      });
      return;
    }

    ctx.db.player.insert({
      player_id: 0n,
      room_id: rm.room_id,
      identity: ctx.sender,
      nickname,
      avatar_color: color,
      is_host: false,
      total_score: 0,
      sabotage_available: true,
      connected: true,
      joined_at: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const kick_player = spacetimedb.reducer(
  { targetPlayerId: t.u64() },
  (ctx, { targetPlayerId }) => {
    const targetPlayer = ctx.db.player.player_id.find(targetPlayerId);
    if (!targetPlayer) {
      throw new Error("Player not found");
    }

    const rm = ctx.db.room.room_id.find(targetPlayer.room_id);
    if (!rm) {
      throw new Error("Room not found");
    }

    if (!rm.host_identity.equals(ctx.sender)) {
      throw new SenderError("Unauthorized: Only host can kick players");
    }

    ctx.db.player.player_id.delete(targetPlayerId);
  }
);

export const start_game = spacetimedb.reducer(
  { totalRounds: t.u32(), wordSource: t.string(), customWords: t.option(t.string()) },
  (ctx, { totalRounds, wordSource, customWords }) => {
    const hostPlayer = [...ctx.db.player.identity.filter(ctx.sender)].find(p => p.is_host);
    if (!hostPlayer) {
      throw new SenderError("Unauthorized: Only host can start game");
    }

    const rm = ctx.db.room.room_id.find(hostPlayer.room_id);
    if (!rm) {
      throw new Error("Room not found");
    }

    ctx.db.room.room_id.update({
      ...rm,
      status: 'in_round',
      total_rounds: totalRounds,
      current_round: 1,
      word_source: wordSource,
    });

    // Handle custom words if provided
    if (wordSource === 'custom' && customWords) {
      const words = customWords.split(',').map(w => w.trim()).filter(w => w.length > 0);
      for (const w of words) {
        ctx.db.word_bank.insert({ word_id: 0n, text: w, category: "custom" });
      }
    }

    beginRoundInternal(ctx, rm.room_id, 1);
  }
);

// Helper function to begin a round
function beginRoundInternal(ctx: any, roomId: bigint, roundNumber: number) {
  // Select word
  const rm = ctx.db.room.room_id.find(roomId);
  let words = [];
  if (rm && rm.word_source === 'custom') {
    words = [...ctx.db.word_bank.iter()].filter(w => w.category === 'custom');
  }
  if (words.length === 0) {
    words = [...ctx.db.word_bank.iter()].filter(w => w.category !== 'custom');
  }

  const randomIndex = ctx.random.integerInRange(0, words.length - 1);
  const word = words[randomIndex]?.text || "umbrella";

  const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
  const endsAtMicros = nowMicros + 30_000_000n; // 30s

  const newRound = ctx.db.round.insert({
    round_id: 0n,
    room_id: roomId,
    round_number: roundNumber,
    word,
    status: 'drawing',
    started_at: nowMicros,
    ends_at: endsAtMicros,
  });

  // Schedule the round timer
  ctx.db.round_timer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(endsAtMicros),
    round_id: newRound.round_id,
    room_id: roomId,
  });
}

export const submit_drawing = spacetimedb.reducer(
  { roundId: t.u64(), imageUrl: t.string(), secondsLeft: t.u32() },
  (ctx, { roundId, imageUrl, secondsLeft }) => {
    const rnd = ctx.db.round.round_id.find(roundId);
    if (!rnd) {
      throw new Error("Round not found");
    }

    const activePlayer = [...ctx.db.player.identity.filter(ctx.sender)].find(p => p.room_id === rnd.room_id);
    if (!activePlayer) {
      throw new Error("Player not found in this room");
    }

    // Check if drawing already exists for this round/player
    const existing = [...ctx.db.drawing.round_id.filter(roundId)].find(d => d.player_id === activePlayer.player_id);
    if (existing) {
      if (!existing.scored) {
        ctx.db.drawing.drawing_id.update({
          ...existing,
          image_url: imageUrl,
          seconds_left: secondsLeft,
        });
      }
    } else {
      ctx.db.drawing.insert({
        drawing_id: 0n,
        round_id: roundId,
        room_id: rnd.room_id,
        player_id: activePlayer.player_id,
        image_url: imageUrl,
        submitted: true,
        seconds_left: secondsLeft,
        ai_score: -1,
        ai_guess: '',
        ai_roast: '',
        round_score: 0,
        scored: false,
      });
    }
  }
);

export const use_sabotage = spacetimedb.reducer(
  { roundId: t.u64(), targetPlayerId: t.u64(), effect: t.string() },
  (ctx, { roundId, targetPlayerId, effect }) => {
    const rnd = ctx.db.round.round_id.find(roundId);
    if (!rnd) {
      throw new Error("Round not found");
    }

    const caller = [...ctx.db.player.identity.filter(ctx.sender)].find(p => p.room_id === rnd.room_id);
    if (!caller) {
      throw new Error("Player not found");
    }

    if (!caller.sabotage_available) {
      throw new Error("Sabotage already spent for the game");
    }

    // Ensure caller has already submitted drawing this round
    const callerDrawing = [...ctx.db.drawing.round_id.filter(roundId)].find(d => d.player_id === caller.player_id);
    if (!callerDrawing || !callerDrawing.submitted) {
      throw new Error("Must submit drawing before using sabotage");
    }

    const target = ctx.db.player.player_id.find(targetPlayerId);
    if (!target || target.room_id !== rnd.room_id) {
      throw new Error("Invalid target player");
    }

    // Spend the sabotage
    ctx.db.player.player_id.update({
      ...caller,
      sabotage_available: false,
    });

    // Activate the sabotage
    ctx.db.sabotage.insert({
      sabotage_id: 0n,
      round_id: roundId,
      room_id: rnd.room_id,
      from_player_id: caller.player_id,
      to_player_id: targetPlayerId,
      effect,
      active: true,
      created_at: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const end_round = spacetimedb.reducer(
  { arg: round_timer.rowType },
  (ctx, { arg }) => {
    const rnd = ctx.db.round.round_id.find(arg.round_id);
    if (!rnd) return;

    ctx.db.round.round_id.update({
      ...rnd,
      status: 'scoring',
    });

    const rm = ctx.db.room.room_id.find(arg.room_id);
    if (rm) {
      ctx.db.room.room_id.update({
        ...rm,
        status: 'scoring',
      });
    }

    // Deactivate all sabotages for this round
    const activeSabotages = [...ctx.db.sabotage.round_id.filter(arg.round_id)];
    for (const sab of activeSabotages) {
      ctx.db.sabotage.sabotage_id.update({
        ...sab,
        active: false,
      });
    }

    // Zero-score anyone who hasn't submitted a drawing
    const playersInRoom = [...ctx.db.player.room_id.filter(arg.room_id)];
    const drawings = [...ctx.db.drawing.round_id.filter(arg.round_id)];

    for (const p of playersInRoom) {
      const pDrawing = drawings.find(d => d.player_id === p.player_id);
      if (!pDrawing) {
        ctx.db.drawing.insert({
          drawing_id: 0n,
          round_id: arg.round_id,
          room_id: arg.room_id,
          player_id: p.player_id,
          image_url: '',
          submitted: true,
          seconds_left: 0,
          ai_score: 0,
          ai_guess: '',
          ai_roast: "Didn't even try. Bold.",
          round_score: 0,
          scored: true,
        });
      }
    }

    // Schedule the reveal transition (force-advance after 8 seconds in case AI calls are slow)
    ctx.db.reveal_timer.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + 8_000_000n),
      round_id: arg.round_id,
      room_id: arg.room_id,
    });
  }
);

export const finalize_round = spacetimedb.reducer(
  { arg: reveal_timer.rowType },
  (ctx, { arg }) => {
    const rnd = ctx.db.round.round_id.find(arg.round_id);
    if (!rnd || rnd.status === 'reveal') return;

    ctx.db.round.round_id.update({
      ...rnd,
      status: 'reveal',
    });

    const rm = ctx.db.room.room_id.find(arg.room_id);
    if (rm) {
      ctx.db.room.room_id.update({
        ...rm,
        status: 'reveal',
      });
    }

    // For any drawing that is still not scored (AI failed / timed out), set fallback
    const drawings = [...ctx.db.drawing.round_id.filter(arg.round_id)];
    for (const dw of drawings) {
      if (!dw.scored) {
        ctx.db.drawing.drawing_id.update({
          ...dw,
          ai_score: 0,
          ai_guess: '',
          ai_roast: "The AI couldn't make sense of it. That's on you.",
          round_score: Number(dw.seconds_left),
          scored: true,
        });

        // Add fallback score to player's total
        const pl = ctx.db.player.player_id.find(dw.player_id);
        if (pl) {
          ctx.db.player.player_id.update({
            ...pl,
            total_score: pl.total_score + Number(dw.seconds_left),
          });
        }
      }
    }
  }
);

export const next_round = spacetimedb.reducer((ctx) => {
  const hostPlayer = [...ctx.db.player.identity.filter(ctx.sender)].find(p => p.is_host);
  if (!hostPlayer) {
    throw new SenderError("Unauthorized: Only host can advance round");
  }

  const rm = ctx.db.room.room_id.find(hostPlayer.room_id);
  if (!rm) {
    throw new Error("Room not found");
  }

  if (rm.current_round < rm.total_rounds) {
    const nextRoundNum = rm.current_round + 1;
    ctx.db.room.room_id.update({
      ...rm,
      status: 'in_round',
      current_round: nextRoundNum,
    });
    beginRoundInternal(ctx, rm.room_id, nextRoundNum);
  } else {
    ctx.db.room.room_id.update({
      ...rm,
      status: 'finished',
    });
  }
});

export const end_game = spacetimedb.reducer((ctx) => {
  const hostPlayer = [...ctx.db.player.identity.filter(ctx.sender)].find(p => p.is_host);
  if (!hostPlayer) {
    throw new SenderError("Unauthorized: Only host can end game");
  }

  const rm = ctx.db.room.room_id.find(hostPlayer.room_id);
  if (rm) {
    ctx.db.room.room_id.update({
      ...rm,
      status: 'finished',
    });
  }
});

// -----------------------------------------------------------------------------
// Procedures (HTTP / AI Integrations)
// -----------------------------------------------------------------------------

export const score_drawing = spacetimedb.procedure(
  { roundId: t.u64(), playerId: t.u64(), imageBase64: t.string(), word: t.string() },
  t.i32(),
  (ctx, { roundId, playerId, imageBase64, word }) => {
    // 1. Read config and seconds left in withTx
    const configData = ctx.withTx(txCtx => {
      const cfg = txCtx.db.config.id.find(0);
      const dw = [...txCtx.db.drawing.round_id.filter(roundId)].find(d => d.player_id === playerId);
      return { 
        apiKey: cfg?.gemini_api_key ?? '', 
        secondsLeft: dw?.seconds_left ?? 0 
      };
    });

    const fallbackScore = Number(configData.secondsLeft);

    if (!configData.apiKey) {
      console.warn("Gemini API key is not configured.");
      ctx.withTx(txCtx => {
        const dw = [...txCtx.db.drawing.round_id.filter(roundId)].find(d => d.player_id === playerId);
        if (dw && !dw.scored) {
          txCtx.db.drawing.drawing_id.update({
            ...dw,
            ai_score: 0,
            ai_guess: '',
            ai_roast: "API key missing. Drawing couldn't be scored.",
            round_score: fallbackScore,
            scored: true
          });
          const pl = txCtx.db.player.player_id.find(playerId);
          if (pl) {
            txCtx.db.player.player_id.update({
              ...pl,
              total_score: pl.total_score + fallbackScore
            });
          }
        }
      });
      return fallbackScore;
    }

    // 2. Call Gemini
    let score = 0;
    let guess = '';
    let roast = "The AI couldn't make sense of it. That's on you.";

    const prompt = `You are the impartial judge of a fast drawing party game. The player had 30 seconds to finger-draw a single word on a phone. You are shown their drawing and told the target word. Score how clearly the drawing communicates that EXACT word to a fresh viewer who does not know the answer.

Target word: "${word}"

Scoring rubric (apply identically every time, be consistent and fair):
- 85-100: instantly and unambiguously reads as the target word.
- 60-84: clearly recognizable as the target with minor ambiguity.
- 35-59: on the right track; the idea is there but messy or incomplete.
- 10-34: barely related; you can sort of see what they were going for.
- 0-9: unrecognizable, blank, or unrelated.
Judge ONLY recognizability and clarity of the concept. Do NOT reward or punish artistic beauty, color, or neatness. Be fair across players.

Also: (a) "guess" = the 1-3 words this drawing MOST looks like to you, ignoring the target (your honest read). (b) "roast" = ONE short, playful, slightly savage sentence about the drawing. Keep it light and funny, never mean about the person, never profane, never about anything but the drawing.

Respond with STRICT JSON only, no markdown, no extra text:
{"score": <integer 0-100>, "guess": "<1-3 words>", "roast": "<one sentence>"}`;

    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = ctx.http.fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${configData.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: "image/png", data: imageBase64 } }
                ]
              }],
              generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 200,
                responseMimeType: "application/json"
              }
            }),
            timeout: TimeDuration.fromMillis(15000),
          }
        );

        if (res.status === 200) {
          const data = res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          
          let cleanedText = text.trim();
          if (cleanedText.startsWith("```json")) {
            cleanedText = cleanedText.slice(7);
          }
          if (cleanedText.endsWith("```")) {
            cleanedText = cleanedText.slice(0, -3);
          }
          cleanedText = cleanedText.trim();

          const parsed = JSON.parse(cleanedText);
          score = typeof parsed.score === 'number' ? parsed.score : 0;
          guess = parsed.guess || '';
          roast = parsed.roast || '';
          success = true;
          break;
        } else {
          console.error(`Gemini call failed with status ${res.status}: ${res.text()}`);
        }
      } catch (e) {
        console.error(`Gemini call error on attempt ${attempt + 1}:`, e);
      }
    }

    // 3. Write results in a new tx
    ctx.withTx(txCtx => {
      const dw = [...txCtx.db.drawing.round_id.filter(roundId)].find(d => d.player_id === playerId);
      if (dw && !dw.scored) {
        const roundScore = score + dw.seconds_left;
        txCtx.db.drawing.drawing_id.update({
          ...dw,
          ai_score: score,
          ai_guess: guess,
          ai_roast: roast,
          round_score: roundScore,
          scored: true
        });
        const pl = txCtx.db.player.player_id.find(playerId);
        if (pl) {
          txCtx.db.player.player_id.update({
            ...pl,
            total_score: pl.total_score + roundScore
          });
        }
      }
    });

    return score + configData.secondsLeft;
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

    const prompt = `You are a witty backseat art critic in a fast drawing game. The player is HALFWAY through a 30-second attempt to draw "${word}". Look at their in-progress drawing and give ONE short, playful, encouraging-but-cheeky line of commentary (max ~12 words). Never mean about the person, never profane. Respond with the single line only, no quotes, no JSON.`;

    try {
      const res = ctx.http.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: "image/png", data: imageBase64 } }
              ]
            }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 100
            }
          }),
          timeout: TimeDuration.fromMillis(8000),
        }
      );

      if (res.status === 200) {
        const data = res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return text.trim();
      }
    } catch (e) {
      console.error('Gemini in-progress roast error:', e);
    }
    return '';
  }
);
