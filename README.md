# DoodleDash

> A real-time multiplayer party drawing game where the judge is an AI. Everyone draws the **same word** on their phone; a **Gemini vision model** scores each drawing on how recognizable it is; the fastest submissions earn bonus points; and the worst drawings get roasted on a Hall of Shame.

**▶ Play:** **https://doodle-dash-flame.vercel.app**
**📖 Game rules:** see [HOW_TO_PLAY.md](HOW_TO_PLAY.md)

This README is the **technical** documentation: what the code is, how every piece works, and — more importantly — **why** every architectural decision was made. It's written to be read top-to-bottom by anyone (human or AI) who needs to understand or extend the project.

---

## Table of contents

1. [The 60-second overview](#1-the-60-second-overview)
2. [The tech stack and why each piece was chosen](#2-the-tech-stack-and-why-each-piece-was-chosen)
3. [The big idea: SpacetimeDB as database-and-server](#3-the-big-idea-spacetimedb-as-database-and-server)
4. [How the three SpacetimeDB primitives map onto the game](#4-how-the-three-spacetimedb-primitives-map-onto-the-game)
5. [Why Supabase (and not SpacetimeDB) holds the images](#5-why-supabase-and-not-spacetimedb-holds-the-images)
6. [How the LLM (Gemini) is used](#6-how-the-llm-gemini-is-used)
7. [The data model — every table and why it exists](#7-the-data-model--every-table-and-why-it-exists)
8. [The reducers — every write, and why](#8-the-reducers--every-write-and-why)
9. [The procedures — the only place HTTP happens](#9-the-procedures--the-only-place-http-happens)
10. [Scheduled reducers — the authoritative timers](#10-scheduled-reducers--the-authoritative-timers)
11. [The scoring pipeline (the heart of the app)](#11-the-scoring-pipeline-the-heart-of-the-app)
12. [Subscriptions — what each client reads and why](#12-subscriptions--what-each-client-reads-and-why)
13. [The frontend, screen by screen](#13-the-frontend-screen-by-screen)
14. [The drawing canvas internals](#14-the-drawing-canvas-internals)
15. [Board Hijack — the live collaborative-vandalism mechanic](#15-board-hijack--the-live-collaborative-vandalism-mechanic)
16. [Host Peek — live spectating](#16-host-peek--live-spectating)
17. [Sound](#17-sound)
18. [Hard-won decisions and gotchas](#18-hard-won-decisions-and-gotchas)
19. [Project structure](#19-project-structure)
20. [Running locally](#20-running-locally)
21. [Deploying](#21-deploying)
22. [Configuration and environment variables](#22-configuration-and-environment-variables)

---

## 1. The 60-second overview

A **host** opens a big screen (laptop/TV) and creates a room. **Players** scan a QR code with their phones, pick a nickname + color, and join. The host starts the game; everyone draws the **same word** within a time limit (30–120s). On submit, drawings are uploaded as images and a **Gemini** vision model scores each on a fixed rubric (0–100). Players earn a **speed bonus** (a point per second left), can win a **+100 self-grade bonus** by predicting their own score, and get **one Board Hijack sabotage** per game. After each round the host screen reveals the gallery + AI roasts + leaderboard. After the final round: a champion, a podium, and a Hall of Shame of the three worst drawings.

Two halves, deployed separately:

- **Backend** = a single **SpacetimeDB** TypeScript module ([spacetimedb/src/index.ts](spacetimedb/src/index.ts)) running on SpacetimeDB Maincloud. It is the database **and** the game server.
- **Frontend** = a **Next.js** app ([app/](app/)) deployed to Vercel. It connects to the backend over a WebSocket and reacts to live data.

---

## 2. The tech stack and why each piece was chosen

| Layer | Technology | Why this choice |
|---|---|---|
| **Backend / DB / server** | **SpacetimeDB 2.x** (TypeScript module, runs on V8) | One system that is *both* the realtime database and the application server. No separate API layer, no manual WebSocket plumbing, no Redis for presence. Clients subscribe to SQL-like queries and get live updates pushed to them. Perfect for a realtime party game where every screen must stay in sync instantly. |
| **Frontend** | **Next.js 15** (App Router, React 18) | Mature React framework, trivial Vercel deploys, file-based routing maps cleanly to our four screens. We use it almost entirely client-side (the game is realtime, not SSR), but it gives us routing, bundling, and env handling for free. |
| **Realtime client** | **SpacetimeDB React SDK** (`spacetimedb/react`) | Provides `useTable` (subscribe to a query, get reactive rows), `useReducer` (call a write), `useProcedure` (call an HTTP-capable function). The whole UI is "render the subscribed rows"; state sync is the SDK's job. |
| **Image hosting** | **Supabase Storage** (public bucket) | Drawings are bitmaps — far too large to live in a replicated database table (see §5). Supabase is a cheap, simple public object store with a one-call upload helper. Only the resulting **URL** ever enters the database. |
| **AI judge** | **Google Gemini** (`gemini-2.5-flash` vision) via REST | A fast, cheap, capable multimodal model. Vision is required (it has to *look* at the drawing). Called only from SpacetimeDB **procedures** (see §6/§9). |
| **Styling** | **Tailwind CSS v4** + **motion** (Framer Motion successor) + **canvas-confetti** | A "neo-brutalist arcade" look — hard offset shadows, chunky borders, bold display type. Tailwind for utility styling, motion for springy animations, confetti for celebrations. |
| **Fonts** | **Fredoka** (display) + **Inter** (body) | Playful but legible — fits the party-game tone. |
| **QR codes** | **qrcode.react** | The host screen renders a QR pointing at the join URL so players join by scanning. |
| **Hosting** | **Vercel** (frontend) + **SpacetimeDB Maincloud** (backend) | Both are zero-config managed hosts. Vercel auto-deploys on `git push`. |

---

## 3. The big idea: SpacetimeDB as database-and-server

The single most important thing to understand about this codebase is **what SpacetimeDB is**, because it dictates the entire architecture.

SpacetimeDB is a **relational database that is also your application server**. You upload your server logic *into* the database as a WebAssembly module. There is **no traditional backend** — no Express server, no REST API, no separate WebSocket server. Clients talk directly to the database:

- To **read** data, a client **subscribes** to a query. The database pushes the matching rows down immediately and then streams every change in real time.
- To **write** data, a client calls a **reducer** — a transactional function that runs *inside* the database.

This has a few non-negotiable consequences that shape every file in this repo:

1. **Reducers are transactional and deterministic.** They run atomically and **cannot** touch the outside world — no HTTP, no filesystem, no clocks, no randomness beyond what the context provides. All their inputs come from table rows and their arguments.
2. **Reducers don't return data to callers.** You don't "call an API and get a response." You call a reducer (which mutates state) and then *observe the result through your subscriptions*. The UI is a pure function of the subscribed tables.
3. **HTTP lives only in procedures.** Because the AI judge is an external HTTP API and reducers can't do HTTP, all Gemini calls live in **procedures** (a separate primitive, see §9).
4. **`ctx.sender` is the authenticated identity.** Every reducer/procedure knows who called it. We never trust an identity passed as an argument — authorization always checks `ctx.sender`.

If you internalize "writes = reducers, reads = subscriptions, HTTP = procedures, and the UI just renders the subscribed rows," the rest of the code reads naturally.

---

## 4. How the three SpacetimeDB primitives map onto the game

The entire game is carried by three primitives:

### Tables + subscriptions → all shared state
Every piece of shared game state is a table: rooms, players, rounds, drawings, scores, sabotage, votes. Each client subscribes to **only the rows for its room**, so a phone replicates just its own game, not the whole database. When any reducer mutates a row, every subscribed client re-renders automatically. This is how the lobby fills up live, how "who has submitted" checkmarks light up, how scores animate in — all of it is just subscribed rows changing.

### Scheduled reducers → the authoritative clock
A drawing round must end after N seconds **even if no human does anything**. We can't trust a client's timer (clients lie, sleep, and disconnect). So we insert a row into a **scheduled table** with a fire-time; when that time arrives, SpacetimeDB calls a reducer (`end_round`) *server-side*. This is the authoritative round timer. A second scheduled reducer (`finalize_round`) is a backstop that guarantees the game can never get stuck (see §10).

### Procedures → the only door to the outside world
The Gemini vision API is an HTTP call, which reducers can't make. Procedures can. A procedure can read the database (in a short transaction), make an HTTP call (with **no** transaction open), and return a value to its caller. Crucially, **procedures in this app do not write game state** — they return JSON and a reducer persists it (see §6 and §11 for the hard-won reason).

---

## 5. Why Supabase (and not SpacetimeDB) holds the images

This is a deliberate, important split.

**The problem:** SpacetimeDB subscriptions *replicate rows to every subscribed client*. If a drawing's pixels (a base64 PNG, ~tens of KB to hundreds of KB) lived in a table, then every time anyone subscribed to the `drawing` table, **all** those images would be pushed to **every** phone. With 16 players over 8 rounds that's 128 images flooding every device — a bandwidth and memory disaster on a phone.

**The solution:**
- The phone uploads the finished PNG to **Supabase Storage** (a plain public object bucket) and gets back a short **URL string**.
- Only that **URL** is stored in the `drawing` table. URLs are tiny, so replicating them to everyone is free.
- Clients render the image with a normal `<img src={url}>`; the browser fetches the bytes directly from Supabase, on demand, only for the images actually shown.
- The **base64 bytes** are passed to the Gemini scoring **procedure as a call argument** — that's the caller's own data going to the function that needs it, never entering a replicated table.

The upload helpers live in [lib/supabase.ts](lib/supabase.ts): `uploadDrawing` (the submission), `uploadHijackCanvas` (a victim's canvas snapshot for hijackers), and `uploadLiveCanvas` (host peek snapshots). All write to the same public `drawings` bucket under different path prefixes. Uploads use `upsert: true` so a re-submit overwrites cleanly.

> **Trade-off:** the bucket is public (anyone with a URL can view a drawing). For a hackathon party game that's fine; for production you'd lock it down with signed URLs / RLS.

---

## 6. How the LLM (Gemini) is used

The AI does two jobs, both vision calls to `gemini-2.5-flash`, both implemented as **procedures** in [spacetimedb/src/index.ts](spacetimedb/src/index.ts):

### `score_drawing(imageBase64, word)` → JSON string
The main judge. Given the drawing bytes and the target word, it returns a structured score.

- **Why a procedure:** it's an HTTP call; reducers can't do HTTP.
- **Why it returns JSON instead of writing the score:** a procedure and a reducer run in **different transaction contexts**. Early on, the procedure tried to write the score directly via `ctx.withTx`, but it couldn't reliably *see* the `drawing` row that the `submit_drawing` reducer had just inserted — so the leaderboard and the drawing row disagreed and scores showed 0. The fix: the procedure does **HTTP only** and returns `{ ok, score, guess, roast }`; a reducer (`record_score_for`) persists it from a consistent view. **This is the single most important architectural fact in the backend.**
- **The `ok` flag:** `ok: false` means "no real AI result" (empty API key, rate-limited 429, 4xx, or unparseable response). The caller must **not** persist a false result as a final score — it retries or falls back to a speed-only score. This is what stops a transient 429 from silently locking a player at 0.

**The Gemini request format (details that matter):**
- Fields are **camelCase** (`inlineData`, `mimeType`) — this is proto3 JSON. snake_case silently drops the image.
- **`thinkingConfig.thinkingBudget: 0`** is required. `gemini-2.5-flash` is a "thinking" model; without disabling thinking it spends the whole token budget reasoning and returns truncated/empty JSON.
- **`temperature: 0` + `topK: 1`** → deterministic: the same drawing always gets the same score (fairness).
- **`maxOutputTokens: 500`** — enough for the rubric JSON once thinking is off.

**The scoring rubric** (in `buildScoringPrompt`): the model scores four independent components that sum to 0–100:
- `identifiability` (0–50) — would a stranger name it correctly?
- `key_features` (0–30) — fraction of essential features actually drawn.
- `form` (0–15) — proportions/layout.
- `effort` (0–5) — blank scribble vs. finished drawing.

The total is computed **server-side as the sum** of the clamped components, so it always spans the full range and stays consistent with the parts. The model also returns `looks_like` (the guess) and a one-line `roast`. A legacy flat `score` field is still accepted as a fallback.

### `roast_in_progress(imageBase64, word)` → string
A throwaway flavor call. Around the halfway point of a round, the player's phone snapshots their canvas and asks Gemini for **one** deadpan burn about the drawing-so-far, shown privately at the bottom of their screen. No DB write, higher temperature (0.8) for variety, returns `''` on any failure (it's pure flavor).

### Response parsing
`extractGeminiText()` handles both response shapes Gemini can return: a single complete JSON object (what we get with `thinkingBudget: 0`) and streamed NDJSON chunks. The score JSON is then stripped of any markdown code fences before `JSON.parse`.

---

## 7. The data model — every table and why it exists

All tables are defined in the `schema({...})` call in [spacetimedb/src/index.ts](spacetimedb/src/index.ts). `public: true` means clients can subscribe to it; private tables are reducer-only. Tables are organized **by access pattern**, not strictly by entity.

| Table | Public | Purpose & notes |
|---|:---:|---|
| **`room`** | ✓ | One row per game. Holds `status` (the state machine: `lobby`/`in_round`/`scoring`/`reveal`/`finished`), `code` (unique join code), `host_identity` (for host-only authorization), `total_rounds`, `current_round`, `word_source`, `round_duration_secs`. |
| **`player`** | ✓ | One row per human participant (**the host is not a player**). Holds `nickname`, `avatar_color`, `total_score` (cumulative), `sabotage_available`, `connected`, and `identity` (their anonymous auth identity). |
| **`round`** | ✓ | One row per round. Holds `word`, `round_number`, `status`, `started_at`, and **`ends_at`** — which is *dual-purpose*: the **draw deadline** during `drawing`, then repurposed as the **self-grade deadline** during `scoring`. |
| **`drawing`** | ✓ | One row per player per round. Holds the Supabase `image_url`, `submitted`, `seconds_left` (the speed bonus, server-computed), `ai_score`, `ai_guess`, `ai_roast`, `round_score`, and `scored`. **No pixels here — only the URL.** |
| **`sabotage`** | ✓ | An active sabotage (currently always `effect: 'hijack'`). Records `from_player_id` (never shown to the victim), `to_player_id`, and `created_at` (used to compute the live lifetime). |
| **`guess`** | ✓ | **Self-grade.** One row per player (`player_id` is the PK, overwritten each round). `round_id` guards a stale guess from leaking a bonus into a later round; `value` is the player's 0–100 prediction of their own AI score. |
| **`replay`** | ✓ | **Play Again.** One active "play again?" offer per room (`room_id` PK, `deadline`). |
| **`replay_vote`** | ✓ | **Play Again.** One vote per player (`player_id` PK, `accept`). |
| **`hijack_point`** | ✓ | **Board Hijack** stroke stream. One row per flushed batch of pen points, addressed to a board (`to_player_id`). Coordinates are normalized 0..1 so they map onto any device's canvas. See §15. |
| **`hijack_canvas`** | ✓ | **Board Hijack** — a victim's canvas snapshot URL, so a hijacker scribbles *on top of the real drawing* instead of a blank pad. One row per victim. |
| **`live_canvas`** | ✓ | **Host Peek** — a player's in-progress canvas snapshot URL (legacy/snapshot path). One row per player. |
| **`spectate`** | ✓ | **Host Peek** toggle for a room (`active`). Gates whether players stream their strokes. |
| **`peek_stroke`** | ✓ | **Host Peek** live stroke stream — each drawing player streams stroke batches keyed by their own `player_id` so the host can replay them. See §16. |
| **`word_bank`** | ✗ | Preset words seeded at init (`category: 'preset'`). Custom words for a game are tagged `custom_<roomId>`. Private — no need to expose. |
| **`config`** | ✗ | A single row (`id = 0`) holding the `gemini_api_key`. **Never public, never logged.** |
| **`round_timer`** | ✗ (scheduled) | Schedule table → fires `end_round` at the draw deadline. |
| **`reveal_timer`** | ✗ (scheduled) | Schedule table → fires `finalize_round`, the grace/crash backstop. |

**Timing constants** (top of the module): `GRADE_WINDOW_MICROS` (10s self-grade window), `END_GRACE_MICROS` (25s grace after the round timer so a late auto-submit can still land and be scored), `REVEAL_MICROS` (45s backstop after an early end).

**`drawing` row sentinel values** (worth memorizing — they encode the whole lifecycle):
- `ai_score = -1, scored = false, submitted = true` → submitted, **awaiting AI**.
- `ai_score = -1, scored = false, submitted = false` → **PENDING placeholder** for a non-submitter (created by `end_round`); keeps the round open so a late auto-submit can still land.
- `0 ≤ ai_score ≤ 100, scored = true` → scored normally.
- `ai_score > 100` (120–200) → scored **with the +100 self-grade bonus**. The client uses `ai_score > 100` to trigger the bonus celebration — no extra column needed.

### Room status flow
```
lobby → in_round → scoring → reveal → (next_round → in_round | finished)
                                                       finished → (Play Again) → lobby
```

---

## 8. The reducers — every write, and why

Reducers are the **only** way game state changes. They're atomic, deterministic, and authorize via `ctx.sender`. Every reducer is in [spacetimedb/src/index.ts](spacetimedb/src/index.ts).

| Reducer | Who can call | What it does & why |
|---|---|---|
| `init` | lifecycle | On module publish: seeds the `word_bank` and ensures the single `config` row exists. |
| `seed_words()` | anyone | Authoritatively **resets** the preset word bank to the canonical list (deletes old presets, re-inserts). Used to scrub stale/hard words from a live DB. Custom words and in-progress rounds are untouched. |
| `set_config(apiKey)` | anyone | Stores the Gemini API key in the private `config` table. Run once after deploy. |
| `create_room(code)` | anyone | Creates a room (status `lobby`, defaults: 3 rounds, 60s). Throws on a duplicate code. **The host is not inserted as a player** — they're just `host_identity`. |
| `join_room(code, nickname, color)` | anyone | Inserts a player (max 16, lobby only). **Dedup:** the same identity re-joining the same lobby (refresh/double-tap) updates its existing row instead of creating a duplicate. |
| `kick_player(targetPlayerId)` | host | Deletes a player row. |
| `start_game(roomId, totalRounds, wordSource, customWords, roundDuration)` | host | Validates ≥2 players, stores custom words if any, sets the duration, and begins round 1. |
| `next_round(roomId)` | host | Marks the current round `done`; begins the next round, or sets the room `finished` after the last. |
| `end_game(roomId)` | host | Forces `finished`. |
| `submit_drawing(roundId, imageUrl, secondsLeft)` | player | Upserts the caller's drawing for the round and resets its scoring fields. **The speed bonus is computed from the server clock** (`ends_at − now`, only during `drawing`); the client-sent `secondsLeft` is **ignored** (anti-cheat). Accepts only while `drawing`/`scoring`. **If everyone has now submitted, it ends the round early** → `scoring`, sets `ends_at` to the grade deadline, and schedules the backstop. |
| `submit_guess(roundId, value)` | player | **Self-grade.** Upserts the caller's 0–100 prediction of their own AI score (clamped). The bonus itself is applied later in `record_score_for`. |
| `close_grading(roundId)` | host | Ends the self-grade window early (moves `round.ends_at` to now) once every submitter has locked a guess. Only ever *shortens* it. |
| `use_sabotage(roundId, targetPlayerId, effect)` | player | Caller must have submitted; **target must NOT have submitted** (authoritative, mirrors the client menu so a race can't land a useless sabotage). Marks `sabotage_available = false` and inserts the sabotage row. |
| `hijack_draw(...)` | player | Streams a batch of normalized stroke points onto a shared board. Authorizes the caller as the victim drawing on their own board, **or** a hijacker holding an active `hijack` sabotage within the window. See §15. |
| `set_hijack_canvas(roundId, imageUrl)` | player (victim) | Publishes the victim's canvas snapshot URL so hijackers scribble on the real drawing. |
| `set_spectate(roomId, active)` | host | Toggles Host Peek for the room. |
| `set_live_canvas(roundId, imageUrl)` | player | Publishes a snapshot of the player's canvas for the host's peek (snapshot path). |
| `peek_draw(...)` | player | Streams the player's strokes for the host's live peek (only while peek is active). See §16. |
| `record_score(...)` | player | **Legacy** per-phone scoring path. Still correct and idempotent, but unused by the current client (superseded by `record_score_for`). |
| **`record_score_for(roundId, playerId, score, guess, roast)`** | host | **The current scoring write.** Persists one drawing's AI result and adds to that player's total, atomically. Idempotent. Applies the **+100 self-grade bonus** when the guess is within ±5 and base ≥ 20. **And it reveals:** once every drawing in the round is scored, it flips room/round → `reveal` (the single source of truth for reveal). See §11. |
| `reveal_round(roundId)` | host | Flips `scoring → reveal`. Redundant now that the server reveals inside `record_score_for`; kept but unused. |
| `offer_replay` / `vote_replay` / `resolve_replay` | host / player / host | **Play Again.** Host opens a 10s vote; players vote yes/no; host resolves at the deadline (or once all voted) — accepters continue in a reset lobby, everyone else is dropped and the room's old data is wiped. |
| `end_round(arg)` | **scheduled** | Fired by `round_timer` when the draw deadline passes. Flips to `scoring`, inserts a **PENDING placeholder** for each non-submitter (so a late auto-submit can still land — see §11), clears sabotages, and schedules `finalize_round`. |
| `finalize_round(arg)` | **scheduled** | The grace/crash backstop. Finalizes any still-unscored drawing (real submission the host never scored → speed-only; a placeholder that never drew → honest 0), then reveals. No-op if already revealed. |

**Two internal helpers:**
- `beginRound(ctx, roomId, n)` — picks an unused word, inserts the `round` (with `ends_at = now + duration`), inserts the `round_timer`, clears stale hijack/peek/live-canvas rows from the previous round, and sets the room `in_round`.
- **`findPlayerInRoom(ctx, identity, roomId)`** — finds the caller's player row scoped to **identity AND room**. This matters: a returning anonymous player reuses their identity, so the same identity can have one player row *per game it has ever played*. Matching on identity alone returns an arbitrary/stale row and mis-attributes drawings/scores to the wrong room. Always scope by room.

---

## 9. The procedures — the only place HTTP happens

Procedures are the HTTP-capable primitive. Both procedures here (`score_drawing`, `roast_in_progress`) are covered in detail in [§6](#6-how-the-llm-gemini-is-used). The key discipline:

> **A procedure reads the DB only inside a short `ctx.withTx`, closes it, then makes the HTTP call with no transaction open, and returns a value. It must never hold a transaction open across an HTTP call, and (in this app) it never writes game state — a reducer does.**

In practice each procedure: opens a tiny `withTx` to read the `gemini_api_key`, closes it, calls Gemini over `ctx.http.fetch`, parses the response, and returns it. The host client then calls a reducer to persist.

---

## 10. Scheduled reducers — the authoritative timers

Two schedule tables drive time-based transitions server-side, so the game never depends on a human or a particular browser staying alive:

- **`round_timer` → `end_round`.** Inserted by `beginRound` with `scheduled_at = ends_at`. When the draw time expires, SpacetimeDB calls `end_round` inside the database. It flips the round to `scoring` and creates PENDING placeholders for anyone who didn't submit (see §11 for why placeholders, not zeros).
- **`reveal_timer` → `finalize_round`.** A backstop. Reveal *normally* happens the instant the last drawing is scored (inside `record_score_for`). `finalize_round` only fires if something is still unscored after the grace window — e.g. the host browser died mid-scoring, or a player genuinely never drew. It force-finalizes every straggler and reveals, so the game can **never** get permanently stuck on the scoring screen.

This pairing — host drives scoring for speed, scheduled reducers guarantee progress — is what makes the round loop both fast and crash-proof.

---

## 11. The scoring pipeline (the heart of the app)

Scoring is **host-driven** and **server-revealed**. The host screen (the always-open big display) is the single scoring coordinator; phones just submit and watch their own row update.

```
1. Players submit (each phone):
   submit_drawing(roundId, imageUrl, secondsLeft)  [reducer]
     → drawing row { submitted:true, ai_score:-1, scored:false }
       (seconds_left computed SERVER-side from ends_at − now, during 'drawing' only)
     → if ALL players have submitted → round/room flip to 'scoring' (ends_at := grade deadline)
       Otherwise the round_timer eventually fires end_round (which leaves PENDING placeholders).

2. Self-grade window (~10s, while 'scoring'):
   each submitter locks a guess of their own AI score → submit_guess(roundId, value).
   The HOST waits out round.ends_at before AI-scoring, and calls close_grading to cut it
   short the moment every submitter has locked.

3. HOST scores every drawing (a reactive loop over LIVE table data):
   for each pending drawing, with bounded concurrency (4):
     scoreDrawing({ imageBase64, word })            [procedure, HTTP ~2-5s]
       → returns { ok, score, guess, roast } (NO db write)
       → retries on !ok (429/transient) with backoff; speed-only fallback if exhausted
     recordScoreFor({ roundId, playerId, score, guess, roast })  [reducer]
       → ai_score = score (+100 if self-grade within ±5 and score ≥ 20)
       → round_score = ai_score + seconds_left; updates drawing + player total ATOMICALLY

4. SERVER reveals (NOT the client):
   inside record_score_for, once every drawing in the round is scored → room/round → 'reveal'.

5. BACKSTOP: finalize_round (scheduled) finalizes any straggler if the host died mid-scoring.
```

Several decisions here were bought with pain (see the full bug history in [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)):

- **Why host-driven?** The earlier per-phone model (each phone scored its own drawing) was fragile: a backgrounded phone, a per-phone 429, or a dropped call could leave a drawing stuck forever. One reliable coordinator throttles Gemini (no thundering herd of 16 simultaneous calls) and makes scoring deterministic. The host loop is **reactive** — it reads live `drawings`/`currentRound`/`guesses` through refs every iteration, so late submissions and a host that refreshed mid-scoring are always picked up; a `dispatched` set prevents double-calling Gemini.
- **Why server-revealed?** A client-driven reveal could fire before every score landed (incomplete snapshot, host refresh), orphaning drawings at `ai_score = -1` and defeating the backstop. Making the **reducer** flip to reveal — atomically, only when all are scored, serialized so exactly one call does it — removes that race entirely.
- **Why PENDING placeholders + a grace window?** When the timer expires, `end_round` inserts an **unscored** placeholder (`submitted = false`) for each non-submitter rather than a hard 0. Because reveal requires *every* drawing scored, the round stays open through the grace window — long enough for an auto-submit whose upload finished a beat after the buzzer to land, replace the placeholder, and get AI-scored. Truly-never-drew players are scored 0 by `finalize_round`. This is the "timed out → 0 even though I drew something" fix.
- **Why the procedure returns JSON instead of writing?** Cross-transaction visibility (see §6). The procedure does HTTP; a reducer persists from a consistent view.

The pure decision logic for the loop (`needsScoring`, `selectPending`, `roundFullyScored`) is factored into [lib/scoring.ts](lib/scoring.ts) so it can be unit-tested without React or the SDK — see [lib/scoring.test.ts](lib/scoring.test.ts).

---

## 12. Subscriptions — what each client reads and why

Every screen subscribes only to the rows for its room, via `useTable(tables.X.where(...))`. `useTable` returns `[rows, isReady]`; the play page gates rendering on `isReady` so a slow initial sync never paints a wrong state off not-yet-arrived data.

**Player phone (`/play/[code]`)** subscribes to:
- `room` (by code) — the state machine, current round, duration.
- `player` (by room) — the live lobby list and everyone's scores.
- `round` (by room) — the current word, `ends_at` (drives the local countdown), status.
- `drawing` (by room) — to show its own score/guess/roast, the "who's submitted" sabotage targets, and the Hall of Shame.
- `sabotage` (to me) — incoming sabotage to apply.
- `guess` (mine) — my locked self-grade.
- `hijack_point` (to me) — incoming hijack strokes to replay on my canvas.
- `hijack_canvas` (the victim's, when I'm a hijacker) — the snapshot to scribble on.
- `spectate` (by room) — whether to stream my strokes to the host peek.
- `replay` / `replay_vote` (mine) — Play Again.

**Host screen (`/host/[code]`)** subscribes to everything for its room (`room`, `player`, `round`, `drawing`, `guess`, `spectate`, `peek_stroke`, `replay`, `replay_vote`) — it's the display, it needs the whole picture, and it's the scoring coordinator.

---

## 13. The frontend, screen by screen

Routes (Next.js App Router):

| Route | File | Screen |
|---|---|---|
| `/` | [app/page.tsx](app/page.tsx) | Landing — Host / Join / How to Play, with an interactive doodle background. |
| `/host/[code]` | [app/host/[code]/page.tsx](app/host/[code]/page.tsx) | The big-screen TV display for every game state. |
| `/join/[code]` | [app/join/[code]/page.tsx](app/join/[code]/page.tsx) | Nickname + color → `join_room`. |
| `/play/[code]` | [app/play/[code]/page.tsx](app/play/[code]/page.tsx) | The phone controller: canvas, submit, self-grade, sabotage. |

The SpacetimeDB connection is set up once in [app/providers.tsx](app/providers.tsx) (wrapped around the app in [app/layout.tsx](app/layout.tsx)). It builds the `DbConnection`, persists the auth token in `localStorage` (so reloads keep the same anonymous identity), and — critically — calls **`.withCompression('none')`** (see §18).

**Host screen states:** lobby (QR + code + player pills + game setup), in-round (big word + countdown + "who's done" chips, or the Peek viewer), scoring ("lock in your guesses" → "the AI is judging"), reveal (top-3 gallery + leaderboard + Next/End), finished (champion + podium + standings + Hall of Shame + Play Again). The host screen also runs the **scoring loop** (§11) and the **Play Again resolver**.

**Player screen states:** lobby (waiting + player list), drawing (canvas + tools + submit, then the self-grade panel + sabotage), scoring (your score or "judging…"), reveal (your drawing, score breakdown, rank), finished (champion + standings + Hall of Shame + Play Again vote). A player dropped by a Play Again sees a "thanks for playing — rejoin?" screen instead of an empty lobby.

UI primitives live in [app/components/](app/components/): `BrutalButton` (springy motion button + the `cn()` helper), `BrutalCard` (hard-offset-shadow card), `CountUp` (animated number), `DoodleBackground` (the landing field). Styling tokens, fonts, and resets are in [app/globals.css](app/globals.css).

---

## 14. The drawing canvas internals

The canvas ([app/play/[code]/page.tsx](app/play/[code]/page.tsx)) is plain HTML5 Canvas with Pointer Events — no drawing library.

- **Smooth strokes** via the quadratic-Bézier midpoint method; a single tap renders a dot so taps register.
- **Coordinate mapping** uses `getBoundingClientRect()` ratios so screen coordinates map to buffer pixels exactly. (Never put `objectFit: contain` on the canvas — letterboxing breaks the mapping.)
- **Aspect-correct buffer:** the canvas buffer is sized to the drawing area's aspect ratio (short side = 800px) once per round, so what you draw maps 1:1 with no distortion and the canvas fills the screen with no dead white margins.
- **Square-on-submit:** only at submit time is the drawing downscaled to ≤512px and padded to a centered white **square** (`toSquarePng`), so the AI and the gallery always get a consistent, undistorted square image.
- **Tools:** pen, eraser (paints white), fill (a tolerance-aware flood fill that handles anti-aliased edges), undo (snapshots `ImageData` before each action, capped at 12), and clear.
- **Auto-submit** fires at ≤1s remaining (not exactly 0): at 0 the round can flip to `scoring` and unmount the canvas before we capture it, so we grab it a beat early while still mounted; the server's grace window accepts the slightly-late landing.
- **Upload resilience:** the Supabase upload retries 3× with backoff — a single dropped upload (common on iOS Low Power Mode / weak signal) used to silently submit an empty URL.

---

## 15. Board Hijack — the live collaborative-vandalism mechanic

The one sabotage in the game. (The original spec had five CSS effects; the game evolved to this single, richer mechanic.)

When a player who has submitted hijacks a not-yet-submitted victim:

- The hijacker spends their sabotage (`use_sabotage` with `effect: 'hijack'`) and gets a **pad** that fills their screen, showing the **victim's current drawing as a background** (fetched from `hijack_canvas`).
- The hijacker scribbles on the pad. Strokes are buffered and **flushed ~11×/second** as batches of normalized `[nx, ny, down]` points through the **`hijack_draw`** reducer into the **`hijack_point`** table.
- The victim subscribes to `hijack_point` rows addressed to their board (`to_player_id == me`) and **replays each incoming batch live onto their canvas** as it arrives — so they watch themselves get vandalized in real time.
- It's a **shared board**: the victim's own strokes also stream back to the board, and **multiple hijackers can target the same victim at once**, all seeing each other's strokes. Each drawer's strokes are tracked by their own `from_player_id` so segments don't cross-connect.
- **Authorization is server-side** (`hijack_draw`): you may draw on a board only if you're the victim, or you hold an active `hijack` sabotage on that victim within the time window (`round_duration / 6` seconds, e.g. 10s on a 60s round). The hijack ends the instant the victim submits — the reducer stops accepting strokes and the attacker's pad closes.
- The attacker's scribbles **can't be undone** by the victim (their own strokes still can), so the vandalism sticks.

Coordinates are normalized 0..1 so a stroke drawn on the attacker's phone lands in the right place on the victim's differently-sized canvas.

---

## 16. Host Peek — live spectating

While a round runs, the host can tap **Peek at drawings** (`set_spectate(active: true)`), turning the big screen into a live spectator view:

- Each still-drawing player's phone streams its strokes ~8×/second through the **`peek_draw`** reducer into the **`peek_stroke`** table (only when peek is active, so it's free otherwise). Clear and Fill operations are streamed as sentinel ops (`!clear`, `!fill:<hex>`) so the replay reconstructs them faithfully.
- The host replays the viewed player's ordered strokes onto a canvas (`renderPeekStrokes`), auto-shuffling between players every ~3.5s, with manual prev/next and per-player dots. If a player has already submitted, it shows their final image instead.

This reuses the same normalized-stroke streaming idea as Board Hijack, but read-only.

---

## 17. Sound

All audio ([lib/sounds.ts](lib/sounds.ts)) goes through a single **Web Audio API** `AudioContext`, unlocked and preloaded on the first user gesture. This is deliberate: iOS Safari blocks `new Audio().play()` outside a user gesture, which made scheduled/auto sounds (countdown, victory, loops) fire unreliably. Routing everything through one unlocked context means buffers can play anytime after that first tap. Sounds: lobby music + drawing-loop (looping), a player-join chime, a 5-second countdown clip scheduled to *end* exactly at the timer's zero, victory, and a confetti-gun.

---

## 18. Hard-won decisions and gotchas

These are the non-obvious things that will bite anyone editing the code. (Full bug history in [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) §11.)

- **`.withCompression('none')` in [app/providers.tsx](app/providers.tsx) is load-bearing.** The SpacetimeDB TS SDK (≤2.3.x) has a WebSocket *decompression* bug on **all WebKit browsers** (iOS Safari, iOS Chrome, macOS Safari): compressed frames throw and are silently dropped (upstream issue #5031, fixed in SDK 2.4.0). The server only compresses frames above a size threshold, so small `room`/`player` frames arrived fine but the large `drawing` snapshot vanished → empty drawings, missing Hall of Shame, stuck scoring — **only on Apple devices**. Disabling compression sends everything uncompressed (negligible cost for this small game) and makes iOS behave like everything else. Drop this once on SDK ≥ 2.4.0.
- **Compare bigints with `.toString()` when one side is a reducer/procedure argument.** In the TS runtime, `paramBigint === tableBigint` is unreliable and silently fails, which caused duplicate rows and miscounts. Table-vs-table `===` is fine. You'll see `.toString()` comparisons throughout the module for exactly this reason.
- **Room-scoped player lookup (`findPlayerInRoom`).** A returning anonymous identity accumulates one player row per game it has played; look up by identity **and** room, never identity alone.
- **The speed bonus is computed from the server clock**, not the client-sent value — the client's `secondsLeft` argument is ignored so clock skew/tampering can't inflate it.
- **Images never enter tables** — only Supabase URLs. Base64 goes to the scoring procedure as an argument (see §5).
- **`ScheduleAt` and `Timestamp` are imported from `'spacetimedb'`**, not `'spacetimedb/server'`.
- **Generated bindings are the source of truth** for names. Run `spacetime generate` after any change to reducer/procedure **signatures or tables** and commit `src/module_bindings/`. Pure logic changes inside a reducer body don't need regen. **Never hand-edit `src/module_bindings/`.**
- **Don't re-add the iOS heuristics that were reverted.** Several compensating hacks (wake lock, sticky ids, settle timers) were added before the real cause (#5031) was found, then removed. The remaining resilience (`isReady` gating, upload retries, reload watchdogs) is intentional and correct; the rest was treating symptoms.
- **The `round_id` autoincrement never resets** between games — round 1 of a new game might be `round_id = 40`. Use `round_number` (always 1..N) for display; don't confuse the two when reading logs.

---

## 19. Project structure

```
doodledash/
├── spacetimedb/
│   ├── src/index.ts          ← ALL backend logic: tables, reducers, procedures, schedules
│   ├── dist/bundle.js        ← built module (spacetime build output)
│   └── package.json
│
├── app/                      ← Next.js App Router (frontend)
│   ├── layout.tsx            ← root layout, wraps Providers
│   ├── providers.tsx         ← SpacetimeDB connection (withCompression('none'))
│   ├── globals.css           ← Tailwind v4 import, theme tokens, fonts, resets
│   ├── page.tsx              ← landing (Host / Join / How to Play)
│   ├── host/[code]/page.tsx  ← host TV display + scoring loop + peek
│   ├── join/[code]/page.tsx  ← nickname + color → join
│   ├── play/[code]/page.tsx  ← player canvas + submit + self-grade + hijack
│   └── components/           ← BrutalButton, BrutalCard, CountUp, DoodleBackground, …
│
├── lib/
│   ├── supabase.ts           ← Supabase client + upload helpers (drawing/hijack/live)
│   ├── scoring.ts            ← pure host-scoring-loop decision logic (unit-tested)
│   ├── scoring.test.ts       ← tests for the loop termination logic
│   └── sounds.ts             ← Web Audio sound engine
│
├── src/module_bindings/      ← AUTO-GENERATED by `spacetime generate`. DO NOT EDIT.
├── public/, sounds/          ← static assets (background image, audio files)
│
├── HOW_TO_PLAY.md            ← player-facing rules
├── README.md                 ← this file
├── PROJECT_CONTEXT.md        ← deep historical context + full bug log
├── 01..07-*.md               ← original build spec documents
└── package.json, tsconfig.json, next.config.ts, postcss.config.mjs
```

---

## 20. Running locally

```bash
npm install
cd spacetimedb && npm install && cd ..
npm run dev          # http://localhost:3000
```

`.env.local` points the frontend at SpacetimeDB Maincloud (`wss://maincloud.spacetimedb.com`, module `doodledash`) by default, so **no local SpacetimeDB server is needed** to develop the frontend — it talks to the live backend. To run a fully local backend instead, run `spacetime start`, publish to `--server local`, and repoint the env vars.

---

## 21. Deploying

Backend and frontend deploy independently.

### Backend (SpacetimeDB module)
```bash
cd spacetimedb && npm run build && cd ..
# Hot-swap (no data wipe; safe when the schema is unchanged):
spacetime publish --module-path spacetimedb doodledash --server maincloud --yes=all
# Only if reducer/procedure SIGNATURES or TABLES changed, regenerate + commit bindings:
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
# A full --delete-data publish re-runs init → re-set the Gemini key afterward:
spacetime call doodledash set_config '"<GEMINI_KEY>"'
```

### Frontend (Vercel)
```bash
git push origin main     # Vercel auto-deploys main
```

> SpacetimeDB hosts only the backend module — it cannot host the Next.js frontend. The two pieces are deployed to different platforms by design.

---

## 22. Configuration and environment variables

> Values (keys, project URLs, identities) are intentionally **not** listed here — they live in `.env.local` (gitignored) and the Vercel dashboard. This section documents *what* exists and *why*.

**Frontend env (`NEXT_PUBLIC_*`, baked into the build):**
- `NEXT_PUBLIC_SPACETIMEDB_HOST` — the WebSocket host (`wss://maincloud.spacetimedb.com`).
- `NEXT_PUBLIC_SPACETIMEDB_DB_NAME` — the module name (`doodledash`).
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the Supabase project + public anon key for uploads.
- `NEXT_PUBLIC_APP_URL` — the app's own base URL, used to build the QR/join link on the host screen.

> [app/providers.tsx](app/providers.tsx) has a hardcoded fallback DB name that **must** be `'doodledash'`. `.env.local` is gitignored, so production relies on the Vercel `NEXT_PUBLIC_*` vars; if they were ever missing, the fallback is what connects.

**Backend secret (server-side only, never in the browser):**
- The **Gemini API key** lives in the private `config` table, set via `spacetime call doodledash set_config '"<KEY>"'`. It is never exposed to clients and never logged.

---

*For the full build history, the complete bug log, and the reasoning behind earlier architectural pivots, see [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md). For the player-facing rules, see [HOW_TO_PLAY.md](HOW_TO_PLAY.md).*
