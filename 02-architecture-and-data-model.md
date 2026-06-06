# 02 — Architecture & Low-Level Design

## High-level architecture

```
   Player phones (Next.js /play)        Host display (Next.js /host)
        |   ^                                |   ^
   call |   | live subscriptions        call |   | live subscriptions
   reducers/|  (WebSocket)              reducers/|  (WebSocket)
   procedures|                          procedures|
        v   |                                v   |
   +----------------------------------------------------+
   |              SpacetimeDB module (TS, V8)            |
   |  Tables (public state)  Reducers (writes, atomic)   |
   |  Scheduled reducers (30s round timer)               |
   |  Procedures (HTTP allowed) --> Gemini API           |
   +----------------------------------------------------+
                         |  (only in procedures)
                         v
              Gemini vision API (scoring + roasts)

   Supabase Storage (public bucket): phones upload PNG -> get URL.
   Only the URL string is stored in SpacetimeDB.
```

Three SpacetimeDB primitives carry the whole game:
- **Tables + subscriptions** → all shared state (lobby, rounds, scores, sabotage) syncs to every client live.
- **Scheduled reducer** → the authoritative 30-second round timer.
- **Procedure** → the only place HTTP (Gemini) is allowed.

## Why this split (don't fight it)
- **Reducers** are atomic DB transactions and **cannot do HTTP**. Use them for all state writes.
- **Procedures** can do HTTP but must manage transactions manually with `ctx.withTx`, and **can't hold a transaction open during the HTTP call**. Use them only for the Gemini calls.
- The drawing **bytes** never enter a table (would replicate to all clients). The phone uploads the PNG to Supabase, stores the **URL**, and passes the **base64** straight into the scoring procedure as a call argument.

---

## Data model (tables)

Types use the SpacetimeDB 2.0 TS schema API: `t.u64()`, `t.i32()`, `t.string()`, `t.bool()`, `t.identity()`, `t.timestamp()`, `t.scheduleAt()`, with `.primaryKey()`, `.autoInc()`, `.unique()`, indexes. Verify exact builder methods against `05-spacetimedb-cheatsheet.md` and the generated bindings. `public: true` means clients can read it.

### `room`
| column | type | notes |
|---|---|---|
| room_id | u64, PK, autoInc | |
| code | string, unique, indexed | 6-char join code (client-generated, validated unique) |
| host_identity | identity | for host-only authorization |
| status | string | `lobby` \| `in_round` \| `scoring` \| `reveal` \| `finished` |
| total_rounds | u32 | set at start |
| current_round | u32 | 0 until started |
| word_source | string | `preset` \| `custom` |
| created_at | timestamp | |

`public: true`.

### `player`
| column | type | notes |
|---|---|---|
| player_id | u64, PK, autoInc | |
| room_id | u64, indexed | |
| identity | identity, indexed | connection identity |
| nickname | string | |
| avatar_color | string | hex |
| is_host | bool | |
| total_score | i32 | cumulative, default 0 |
| sabotage_available | bool | true at join, false once spent |
| connected | bool | |
| joined_at | timestamp | |

`public: true`.

### `round`
| column | type | notes |
|---|---|---|
| round_id | u64, PK, autoInc | |
| room_id | u64, indexed | |
| round_number | u32 | |
| word | string | the prompt everyone draws (public — it's not a guessing game) |
| status | string | `drawing` \| `scoring` \| `reveal` \| `done` |
| started_at | timestamp | |
| ends_at | timestamp | started_at + 30s; clients sync their countdown to this |

`public: true`.

### `drawing` (one per player per round)
| column | type | notes |
|---|---|---|
| drawing_id | u64, PK, autoInc | |
| round_id | u64, indexed | |
| room_id | u64, indexed | |
| player_id | u64, indexed | |
| image_url | string | Supabase public URL (or "" if none) |
| submitted | bool | |
| seconds_left | u32 | clock remaining at submit (0 if auto/none) |
| ai_score | i32 | Gemini 0–100; `-1` = not yet scored |
| ai_guess | string | what the AI thought it was |
| ai_roast | string | one-line critique (reused by Hall of Shame) |
| round_score | i32 | ai_score + seconds_left |
| scored | bool | |

`public: true`. **No base64 here** — only the URL.

### `sabotage`
| column | type | notes |
|---|---|---|
| sabotage_id | u64, PK, autoInc | |
| round_id | u64, indexed | |
| room_id | u64 | |
| from_player_id | u64 | not revealed in UI |
| to_player_id | u64, indexed | victim |
| effect | string | `invert`\|`giant_brush`\|`invisible_ink`\|`spin`\|`fake_popup` |
| active | bool | cleared at round end |
| created_at | timestamp | |

`public: true`. Victim subscribes filtered on `to_player_id == me && active`.

### `word_bank` (preset words, seeded at init)
| column | type | notes |
|---|---|---|
| word_id | u64, PK, autoInc | |
| text | string | |
| category | string | optional |

`public: false` (no need to expose).

### `config` (secrets / settings, 1 row)
| column | type | notes |
|---|---|---|
| id | u32, PK | always 0 |
| gemini_api_key | string | set once via CLI after publish (see `03`) |

`public: false`. **Never** mark public; never log it.

### `round_timer` (SCHEDULE TABLE → `end_round`)
| column | type | notes |
|---|---|---|
| scheduled_id | u64, PK, autoInc | |
| scheduled_at | scheduleAt | set to `ends_at` (one-shot) |
| round_id | u64 | |
| room_id | u64 | |

Declared with `{ name: 'round_timer', scheduled: () => end_round }`.

### `reveal_timer` (SCHEDULE TABLE → `finalize_round`) — optional backstop
Fires ~8s after `end_round` to force-advance to `reveal` even if some scores are slow. Same shape as `round_timer`, points at `finalize_round`.

---

## Reducers (writes only, atomic, no HTTP)

Authorization rule: host-only reducers must check `ctx.sender == room.host_identity` and throw otherwise. All reducers identify the caller via `ctx.sender` (an `Identity`).

- **`init`** *(lifecycle: module init)* — seed `word_bank` with ~50 simple words if empty; ensure a single `config` row (id 0, empty key).
- **`create_room(code, nickname, color)`** — throw if `code` exists; insert `room` (`status='lobby'`, host_identity = ctx.sender); insert host `player` (`is_host=true`).
- **`join_room(code, nickname, color)`** — find room by code; throw if missing, not in `lobby`, or full (≥16); insert `player` (`sabotage_available=true`, `total_score=0`).
- **`kick_player(targetPlayerId)`** *(host)* — delete that player's row.
- **`start_game(totalRounds, wordSource, customWords?)`** *(host)* — set `room.total_rounds`, `word_source`; if `custom`, stash custom words (e.g., into `word_bank` tagged, or a separate table); call internal `beginRound(roomId, 1)`.
- **`beginRound(roomId, n)`** *(internal helper, not client-callable)* — pick a word (random from `word_bank` or custom set); insert `round` (`status='drawing'`, started_at=now, ends_at=now+30s); set `room.status='in_round'`, `current_round=n`; insert `round_timer` row with `scheduled_at = ScheduleAt.time(ends_at)`.
- **`submit_drawing(roundId, imageUrl, secondsLeft)`** — upsert the caller's `drawing` row for the round: `submitted=true`, `image_url`, `seconds_left`. (Scoring is a separate **procedure** call right after.)
- **`use_sabotage(roundId, targetPlayerId, effect)`** — require caller's `sabotage_available==true` AND caller has a `submitted` drawing this round; else throw. Set caller `sabotage_available=false`; insert `sabotage` row (`active=true`).
- **`end_round(arg)`** *(SCHEDULED by `round_timer`)* — set `round.status='scoring'`, `room.status='scoring'`; for every player in the room without a submitted `drawing` this round, insert a zeroed drawing row (`submitted=true, seconds_left=0, ai_score=0, round_score=0, ai_guess='', ai_roast='Didn't even try. Bold.', scored=true, image_url=''`); set all `sabotage` rows for the round `active=false`; insert `reveal_timer` for now+8s.
- **`finalize_round(arg)`** *(SCHEDULED by `reveal_timer`)* — set `round.status='reveal'`, `room.status='reveal'`. (Advancing is host-driven below.)
- **`next_round()`** *(host)* — if `current_round < total_rounds`, `beginRound(roomId, current_round+1)`; else `end_game()`.
- **`end_game()`** *(host, or auto from next_round)* — set `room.status='finished'`. Hall of Shame is derived client-side from `drawing` rows (lowest `round_score`); no extra writes/AI needed.

> **Scoring is NOT done in a reducer** (no HTTP). It's the `score_drawing` procedure below, called by the client right after `submit_drawing`.

---

## Procedures (HTTP allowed — the only place Gemini is called)

Pattern for every procedure that touches both Gemini and the DB:
1. `ctx.withTx(...)` → read what you need (e.g., the API key from `config`), return it, transaction closes.
2. `ctx.http.fetch(...)` → call Gemini (no transaction open here).
3. `ctx.withTx(...)` → write results.

- **`score_drawing(roundId, playerId, imageBase64, word)`**
  1. Read `gemini_api_key` from `config`, and the drawing's `seconds_left`, in a `withTx`.
  2. Call Gemini vision with the scoring prompt (see `03`). Parse strict JSON `{ score, guess, roast }`.
  3. In a `withTx`: update the player's `drawing` row (`ai_score=score`, `ai_guess`, `ai_roast`, `round_score = score + seconds_left`, `scored=true`); add `round_score` to `player.total_score`.
  - **Cost control:** at most **1 retry** on a transient failure (timeout/5xx). On final failure, write a fallback (`ai_score=0`, `round_score=seconds_left`, `ai_guess=''`, `ai_roast="The AI couldn't make sense of it. That's on you."`, `scored=true`). No loops, no polling.
  - Returns the score to the caller (optional; UI mainly reacts via subscription).
- **`roast_in_progress(imageBase64, word)`**
  - One Gemini call with the short mid-round roast prompt (see `03`); returns the **roast string to the caller only** (procedure return values are not broadcast — automatically private). No DB write, **no retry** (it's flavor). On failure return `""` and the client shows nothing.

> Optional: a `set_config(apiKey)` reducer to store the Gemini key (host-only or call once via CLI). See `03` for the recommended one-time CLI approach.

---

## Subscriptions (client)

Keep each client's subscription scoped to its room so phones don't replicate the whole DB. Filter syntax in 2.0 React hooks is roughly `useTable(tables.player.where(r => r.roomId.eq(roomId)))` — **verify exact `where`/filter form against generated bindings** (it has varied across releases).

**Player phone (`/play/[code]`):**
- `room.where(code == myCode)` → status, current_round, total_rounds.
- `player.where(room_id == myRoomId)` → lobby list + live scores.
- `round.where(room_id == myRoomId)` → current word, `ends_at` (drive local countdown), status.
- `drawing.where(round_id == currentRoundId)` → for the reveal (own score/guess; others on reveal).
- `sabotage.where(to_player_id == myPlayerId && active == true)` → effects to apply to me.

**Host screen (`/host/[code]`):** subscribe to all of the above for its room (it's the display, it needs everything): `room`, `player`, `round`, `drawing`, `sabotage` filtered by room.

---

## End-to-end flow of one round (sequence)

1. Host taps **Next Round** (or **Start**) → `next_round`/`start_game` → `beginRound` inserts `round` (`ends_at = now+30s`) + `round_timer` schedule row. All clients see the new word + countdown via subscription.
2. Phones render the word + a countdown synced to `ends_at`, and the drawing canvas.
3. At ~15s, each phone snapshots its canvas → `roast_in_progress(base64, word)` procedure → shows the returned one-liner privately at the bottom.
4. Player taps **Submit** (or phone auto-submits at 0s): canvas → PNG → upload to Supabase → get URL → `submit_drawing(roundId, url, secondsLeft)` reducer → then `score_drawing(roundId, playerId, base64, word)` procedure. Score lands in the `drawing` row; `total_score` updated.
5. After submit, if `sabotage_available`, the player may `use_sabotage(roundId, victimId, effect)`. The victim's phone (subscribed to its sabotage rows) applies the CSS effect instantly.
6. At `ends_at`, the scheduled **`end_round`** fires: zero-scores anyone who didn't submit, clears sabotages, schedules `finalize_round` (+8s).
7. **`finalize_round`** sets status to `reveal`. Host screen shows top drawings + scores + AI guesses; phones show personal score + rank.
8. Host taps **Next Round** → repeat, or **end_game** → finished + Hall of Shame (client-derived from lowest `round_score` drawings, reusing stored `ai_guess`/`ai_roast`).

## Things to verify against live docs while building
- Exact table **mutation** API (update/delete by primary key, index `.find`/`.filter` accessors).
- Exact **scheduled table** declaration syntax and the `scheduled` attribute reference form.
- Exact **`useTable` filter** form for the installed SDK version.
- Whether a lifecycle **`init`** reducer is the right seeding hook in 2.0 (vs `clientConnected`).
See `05-spacetimedb-cheatsheet.md` for the verified snippets and doc links.
