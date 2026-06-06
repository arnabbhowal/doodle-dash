# DoodleDash — Full Project Context

> **Purpose of this file:** Complete handoff doc for any new AI session or collaborator. Read this before touching any code. Everything that was built, every architectural decision, every bug fixed, and every deployment step is recorded here.
>
> **Major milestones since the first build:** (1) the AI-scoring pipeline was re-architected from "procedure writes to DB" to "procedure returns JSON → reducer persists" to kill a cross-transaction race; (2) scoring is now **completion-driven** (the round won't reveal until every drawing is scored) with a server fallback; (3) a full **neo-brutalist UI reskin** (Tailwind v4 + motion + Fredoka/Inter) was layered on top without touching game logic; (4) round duration is configurable; (5) a `record_score` reducer and `seed_words` reducer were added.
>
> **Newer milestones (2026-06-02 → 06-03):** (6) scoring moved from **per-phone** to **host-driven** — the host screen scores every drawing (bounded-parallel Gemini, reactive over live data) and persists via `record_score_for`; the **server** flips to reveal once all drawings are scored (`record_score_for` / `end_round`), so the client never reveals and can't race the backstop; (7) **room-scoped player lookup** (`findPlayerInRoom`) fixed a stale-identity mis-attribution bug (a returning identity has one player row per game; the old global lookup attributed drawings/scores/sabotage to the wrong room); (8) the speed bonus is computed from the **server clock** in `submit_drawing` (client `secondsLeft` ignored); (9) **iOS Safari resilience** on `/play` — render is gated on subscription readiness (`useTable`'s `isReady`), Supabase uploads retry, and reload watchdogs resync a suspended/stale socket. See §7, §8.4, §11 (bugs 15–20).

---

## 1. What Is DoodleDash?

A real-time multiplayer party game for the **SpacetimeDB Launchpad Hackathon (NYC Tech Week, Jun 5–7 2026)**. The concept: everyone in the room draws the **same word** on their phone within a host-chosen time limit. A **Gemini vision model** scores each drawing (0–100) and adds a **speed bonus** (seconds remaining at submit). One **sabotage** per player per game. After each round there's a score reveal; at the end there's a champion celebration, a final leaderboard, and a **Hall of Shame** showing the 3 worst drawings, each with the AI's guess and a roast line.

Tone: Jackbox-style party chaos. Host screen is a big-screen/TV display; players use their phones as controllers.

---

## 2. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Backend** | SpacetimeDB 2.3.0 (TypeScript module on V8) | Deployed to Maincloud |
| **Frontend** | Next.js 15 (App Router, React 18) | Deployed to Vercel |
| **Styling** | **Tailwind CSS v4** (`@tailwindcss/postcss`) + `motion` (framer-motion successor) + `clsx` + `tailwind-merge` + `canvas-confetti` | Added during the reskin |
| **Fonts** | **Fredoka** (display/headings/buttons) + **Inter** (body) via Google Fonts | Registered in Tailwind `@theme` |
| **AI** | Gemini REST API (`gemini-2.5-flash`) | Called only from SpacetimeDB **procedures** via `ctx.http.fetch`. `thinkingBudget: 0`. |
| **Image storage** | Supabase Storage (public bucket `drawings`) | Only the URL is stored in STDB; raw images never enter subscribed tables |
| **Auth** | Anonymous SpacetimeDB identity + chosen nickname | No signup |

---

## 3. Live Deployment

| Resource | URL / Identifier |
|---|---|
| **Frontend (production)** | https://doodledash-mu.vercel.app |
| **Vercel project** | https://vercel.com/arnab-bhowals-projects/doodledash |
| **SpacetimeDB module** | `doodledash` on Maincloud |
| **SpacetimeDB dashboard** | https://spacetimedb.com/doodledash |
| **GitHub repo** | https://github.com/arnabbhowal/doodledash (branch `main` auto-deploys) |
| **Supabase project** | https://eyqsggcuqzuupxjufktn.supabase.co |

### SpacetimeDB identities
- **User identity:** `c20088cfb8303ac7ce4328ce39d7295a2475c0b019ac58681af9fe6c4f913e57`
- **DB identity:** `c2000b479b55abe5b711062aae7ec90b9b1388c47a6ee5591f17ff16e765a2c2`

### Git branches
- **`main`** — production; Vercel auto-deploys on push.
- **`reskin`** — the neo-brutalist UI work; **already merged into `main`**. Kept around as history.

---

## 4. Credentials & Environment Variables

### `.env.local` (local dev — NOT in git)
```
SPACETIMEDB_DB_NAME=doodledash
SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com

NEXT_PUBLIC_SPACETIMEDB_DB_NAME=doodledash
NEXT_PUBLIC_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com

NEXT_PUBLIC_SUPABASE_URL=https://eyqsggcuqzuupxjufktn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<see Vercel dashboard or .env.local>

NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> **IMPORTANT (deploy gotcha):** `app/providers.tsx` has a hardcoded fallback DB name. It MUST be `'doodledash'`, not the template default `'nextjs-ts'`. `.env.local` is gitignored, so Vercel relies on the `NEXT_PUBLIC_*` env vars; if they're missing, the fallback is what connects. This was a real production outage (every room stuck "Connecting…") — see Bug 11.

### Vercel env vars (all set in production)
All the `NEXT_PUBLIC_*` vars above plus `NEXT_PUBLIC_APP_URL=https://doodledash-mu.vercel.app`, set via `npx vercel env add`.

### Gemini API key
- **Format:** new Google AI Studio style, prefix `AQ.` (e.g. `AQ.Ab8RN6Je...`). This is the current valid format — do not "fix" it to an `AIza...` key.
- Stored **server-side only** in SpacetimeDB's private `config` table (never in the browser or source).
- Set via: `spacetime call doodledash set_config '"<KEY>"'`
- **Free tier** → rate-limited (HTTP 429) under load (~10 req/min). Add a billing method at [aistudio.google.com](https://aistudio.google.com) for real play. When rate-limited, the procedure falls back to a 0 AI score (players still get the speed bonus).

### Supabase
- **URL:** `https://eyqsggcuqzuupxjufktn.supabase.co`
- **Anon key:** see `.env.local` / Vercel dashboard
- **Bucket:** `drawings` (public). Path pattern: `drawings/<code>/<roundId>/<playerId>.png`, `upsert: true`.
- **RLS policies (both required, set in Supabase SQL editor):**
  ```sql
  CREATE POLICY "Allow anon uploads" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'drawings');
  CREATE POLICY "Allow public read" ON storage.objects
    FOR SELECT USING (bucket_id = 'drawings');
  ```
  The SELECT policy is needed because `upsert: true` performs a SELECT-before-write; without it uploads silently failed and `image_url` stayed `''` (see Bug 8).

---

## 5. Project Structure

```
doodledash/
├── spacetimedb/                  ← SpacetimeDB module (TypeScript, runs on V8)
│   └── src/index.ts              ← ALL backend logic: tables, reducers, procedures
│
├── app/                          ← Next.js App Router
│   ├── layout.tsx                ← Root layout (Providers wrapper)
│   ├── providers.tsx             ← SpacetimeDB connection provider (DB-name fallback = 'doodledash')
│   ├── globals.css               ← Tailwind v4 import, @theme tokens, fonts, element resets, sabotage CSS
│   ├── page.tsx                  ← Landing (Create Room | Join) + doodle background
│   ├── host/[code]/page.tsx      ← Host/TV display (lobby/in-round/scoring/reveal/finished)
│   ├── join/[code]/page.tsx      ← Player nickname + color → join
│   ├── play/[code]/page.tsx      ← Player phone controller + canvas + scoring/reveal/finished
│   └── components/               ← Reskin primitives (NEW)
│       ├── BrutalButton.tsx      ← Brutalist button (motion hover/tap), exports cn()
│       ├── BrutalCard.tsx        ← Brutalist card (hard offset shadow)
│       └── CountUp.tsx           ← Presentation-only animated number count-up
│
├── public/
│   └── doodle-background.png     ← Landing background (~6.9 MB; candidate for compression)
│
├── src/module_bindings/          ← AUTO-GENERATED by `spacetime generate`. DO NOT EDIT.
│
├── lib/
│   └── supabase.ts               ← Supabase client + uploadDrawing() helper (upsert: true)
│
├── postcss.config.mjs            ← Tailwind v4 PostCSS pipeline (CRITICAL — see Bug 12)
├── tsconfig.json                 ← excludes "Party Drawing Game UI Design"
├── .env.local                    ← Local env (NOT in git)
├── spacetime.json / .local.json  ← SpacetimeDB project config
├── Party Drawing Game UI Design/ ← Reference design (shadcn/react-router). gitignored, build-excluded.
└── 07-ui-reskin.md, 04-frontend-spec.md ← specs
```

---

## 6. SpacetimeDB Module Deep-Dive

**File:** `spacetimedb/src/index.ts` (~740 lines)

### Key architectural rules (NEVER violate)
1. **HTTP/Gemini calls ONLY in procedures**, never in reducers.
2. **Procedures must NOT write the score directly** — they return JSON; a reducer (`record_score`) persists it. (See "Scoring pipeline" below — this is the single most important architectural fact.)
3. **Compare bigints with `.toString()`** when one side is a reducer/procedure parameter and the other is a table-row value. In SpacetimeDB's TS runtime, `paramBigint === tableBigint` is **unreliable** and silently fails — this caused duplicate rows and miscounts (Bug 9). Table-vs-table `===` is fine.
4. **Only Supabase URLs stored in tables**, never base64. Base64 goes as a procedure argument.
5. **`ScheduleAt`/`Timestamp` imported from `'spacetimedb'`**, not `'spacetimedb/server'`.
6. Subscriptions must be filtered per room so phones don't replicate the whole DB.

### Tables

| Table | Public | Purpose |
|---|---|---|
| `room` | ✓ | One row per game room. `status`, `host_identity`, `total_rounds`, `current_round`, `word_source`, **`round_duration_secs`**, `created_at`. |
| `player` | ✓ | One row per human participant (host is NOT a player). `total_score`, `sabotage_available`, `avatar_color`, etc. |
| `round` | ✓ | One row per round. `word`, `round_number`, `status`, `started_at`, `ends_at`. |
| `drawing` | ✓ | One row per player per round. `image_url`, `submitted`, `seconds_left`, `ai_score`, `ai_guess`, `ai_roast`, `round_score`, `scored`. |
| `sabotage` | ✓ | Active sabotage effects. Victim subscribes filtered by `to_player_id`. Has `created_at` (used for the client-side lifetime). |
| `word_bank` | ✗ | **172** preset words seeded at init (`category='preset'`). Custom words tagged `custom_<roomId>`. |
| `config` | ✗ | Single row (id=0) holding `gemini_api_key`. Never log it. |
| `round_timer` | ✗ (schedule) | Fires `end_round` at `round.ends_at`. |
| `reveal_timer` | ✗ (schedule) | Fires `finalize_round` (now a **25s** fallback after scoring begins). |

**`drawing` row sentinel values:**
- `ai_score = -1`, `scored = false` → submitted, **awaiting AI**.
- `ai_score >= 0`, `scored = true` → scored (by `record_score_for` (host-driven, current), the `finalize_round` backstop, or an `end_round` non-submitter placeholder).
- Non-submitter placeholder (created by `end_round`): `submitted = true, ai_score = 0, scored = true, image_url = '', ai_roast = "Didn't even try. Bold."`.

### Room status flow
```
lobby → in_round → scoring → reveal → (next_round → in_round | finished)
```
- `in_round → scoring` happens via **early-end** (all players submitted, inside `submit_drawing`) OR the `round_timer` firing `end_round`.
- `scoring → reveal` happens **as soon as every drawing is scored** (inside `record_score`), or via the 25s `reveal_timer` fallback (`finalize_round`).

### Reducers (writes only, atomic, no HTTP)

| Reducer | Auth | Description |
|---|---|---|
| `init` | lifecycle | Seeds `word_bank` (172 words) + creates config row |
| `seed_words()` | anyone | Idempotently adds any missing preset words to `word_bank`. Run after a publish if the bank is stale. |
| `set_config(apiKey)` | anyone | Updates Gemini API key |
| `create_room(code)` | anyone | Creates room row (`round_duration_secs` defaults 60). Host is NOT a player. |
| `join_room(code, nickname, color)` | anyone | Inserts player row. Max 16. Only in `lobby`. **Dedup:** the same identity re-joining the same lobby (refresh/double-tap) updates its existing row instead of inserting a duplicate. |
| `kick_player(targetPlayerId)` | host | Deletes player row |
| `start_game(roomId, totalRounds, wordSource, customWords, roundDuration)` | host | Validates ≥2 players, seeds custom words, sets `round_duration_secs`, begins round 1 |
| `next_round(roomId)` | host | Marks current round `done`; begins next or sets `finished` |
| `end_game(roomId)` | host | Forces `finished` |
| `submit_drawing(roundId, imageUrl, secondsLeft)` | player | Insert/update drawing (resets scoring fields). **Speed bonus is computed from the SERVER clock** (`ends_at − now`); the client-sent `secondsLeft` is ignored (anti-skew/anti-cheat). **Rejects late submits once the round is past `scoring`** (`drawing`/`scoring` only) so a stray submit can't strand a drawing after reveal. **Early-ends the round when all players have submitted** (→ scoring + schedules reveal fallback). |
| `use_sabotage(roundId, targetPlayerId, effect)` | player | Caller must have submitted this round. **Target must NOT have already submitted** (authoritative — mirrors the client menu). One per game (`sabotage_available`). |
| `record_score(roundId, score, guess, roast)` | player | **LEGACY / unused by the current client** (the old per-phone path; kept and still correct). Persists the caller's AI result + `total_score` atomically; idempotent; server-driven reveal when all scored. Superseded by `record_score_for` (host-driven). |
| **`record_score_for(roundId, playerId, score, guess, roast)`** | host | **Host-driven scoring (current).** Persists ONE drawing's AI result (`ai_score/ai_guess/ai_roast/round_score = clamp(score)+seconds_left/scored=true`) **and** that player's `total_score`, atomically. Idempotent (`scored && ai_score >= 0` → skip). **Server-driven reveal:** after persisting, if every drawing in the round is scored, flips room/round → `reveal`. Reducers are serialized, so the last one to complete the set performs the flip exactly once. |
| **`reveal_round(roundId)`** | host | Flips room/round `scoring → reveal`. Mostly redundant now that `record_score_for`/`end_round` do the server-side reveal; the host no longer calls it. Kept (harmless). |
| `end_round(arg)` | SCHEDULED | Round timer expired: → scoring, inserts 0-score placeholders for non-submitters, clears sabotages. **If nobody submitted (all placeholders already scored), reveals immediately.** Otherwise schedules `finalize_round` (+45s). |
| `finalize_round(arg)` | SCHEDULED | **Backstop only** (host crash/close). Force-finalizes any still-unscored submitted drawing with a **speed-only** score (and adds it to the player total), then → reveal. No-op if already revealed. |

**Internal helpers:**
- `beginRound(ctx, roomId, n)` — picks an unused word (timestamp-mod selection), inserts the `round` row with `ends_at = now + round_duration_secs`, inserts the `round_timer`, sets room `in_round`.
- **`findPlayerInRoom(ctx, identity, roomId)`** — returns the caller's player row **scoped to the room** (identity AND `room_id`). Replaces the old `findPlayerByIdentity` (which matched identity alone and returned an arbitrary/stale row when an identity had played multiple games — see Bug 16). Used by `submit_drawing`, `use_sabotage`, `record_score`.

> **`REVEAL_MICROS` = 45s** (was 25s): the `reveal_timer`/`finalize_round` backstop is now generous because the host legitimately drives scoring/reveal — the timer must not race a host still waiting on Gemini.

### Procedures (HTTP allowed — Gemini only; NO DB writes)

**`score_drawing(imageBase64, word)`** → `string` (JSON)
- `ctx.withTx` reads ONLY the `gemini_api_key`.
- `ctx.http.fetch` → POST Gemini with the image + scoring prompt (retries once on 5xx).
- Parses the response → returns `JSON.stringify({ ok, score, guess, roast })`. **`ok:false`** means "no real AI result" (empty key / 429 / 4xx / unparseable) — the host must NOT persist a false result as a final score; it retries or falls back to a speed-only score. This is what keeps a 429 from silently locking a player at 0. Always returns valid JSON. **Does not touch the DB beyond reading the key** — this is deliberate (see Bug 7).

**`roast_in_progress(imageBase64, word)`** → `string`
- Mid-round flavor line (~halfway through). HTTP only, returns the line, no DB write.

### Gemini call format (CRITICAL details)
```json
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=<KEY>
{
  "contents": [{
    "parts": [
      { "text": "<PROMPT>" },
      { "inlineData": { "mimeType": "image/png", "data": "<BASE64_NO_PREFIX>" } }
    ]
  }],
  "generationConfig": {
    "temperature": 0.4,
    "maxOutputTokens": 500,
    "thinkingConfig": { "thinkingBudget": 0 }
  }
}
```
- **camelCase** (`inlineData`, `mimeType`) — proto3 JSON. snake_case silently drops the image (Bug 1).
- **`thinkingConfig.thinkingBudget: 0`** is required — `gemini-2.5-flash` is a thinking model and without this it spends the whole token budget "thinking" and returns truncated/empty JSON (Bug 6b). With it, the model returns a single complete JSON object.
- **`maxOutputTokens: 500`** (was 200 — too small once thinking was disabled).
- Scoring prompt asks for STRICT JSON `{"score": 0-100, "looks_like": "...", "roast": "..."}`. The parser accepts `looks_like` (current) or `guess` (legacy).
- **`extractGeminiText()`** handles both shapes: a single complete JSON object (thinkingBudget=0) and NDJSON/streamed chunks. The earlier code only did line-by-line NDJSON and broke when the API returned one object (Bug 6c).
- Scoring roasts are intentionally savage/funny (see prompt). The mid-round roast is a one-liner.

---

## 7. The Scoring Pipeline (READ THIS — it's the heart of the app)

Scoring is **host-driven** and **server-revealed**. The single host screen (always-open TV/laptop) is the scoring coordinator; phones just submit and watch their own row update. The flow per round:

```
1. Players submit (each phone):
   client → submit_drawing(roundId, imageUrl, secondsLeft)   [reducer]
            → drawing row { submitted:true, ai_score:-1, scored:false }
              (seconds_left computed SERVER-side from ends_at − now)
            → if ALL players submitted, round/room → 'scoring' + schedule 45s backstop

2. HOST scores EVERY drawing (app/host — reactive loop over LIVE table data):
   for each pending drawing (submitted && not scored), with bounded concurrency (4):
     host → scoreDrawing({ imageBase64, word })              [procedure, HTTP ~2-5s]
            → returns JSON { ok, score, guess, roast }   (NO db write)
            → retries on !ok (429/transient) with backoff; speed-only fallback if exhausted
     host → recordScoreFor({ roundId, playerId, score, guess, roast })   [reducer]
            → updates that drawing (ai_score, round_score = score + seconds_left, scored=true)
              AND that player's total_score, ATOMICALLY

3. SERVER reveals (NOT the client):
   inside record_score_for, once every drawing in the round is scored → room/round → 'reveal'.
   (end_round also reveals immediately if nobody submitted.) The host NEVER calls reveal,
   so nothing can race ahead of a score and the backstop can't be defeated by an early flip.

4. Server BACKSTOP (host crash/close only): if the round is still 'scoring' after 45s,
   finalize_round force-finalizes remaining drawings with a speed-only score (added to the
   player total) and flips to reveal. Nothing is ever left stuck at ai_score=-1.
```

**The host loop is reactive, not a one-time snapshot.** It reads the *live* `drawings`/`currentRound` via refs each iteration and keeps scoring any still-pending drawing until all are scored — so late submissions and a host that mounted/refreshed mid-`scoring` are always picked up. A `dispatched` set prevents double-calling Gemini for the same drawing; it never reveals (the server does).

**Why host-driven?** The earlier **per-phone** model (each phone scored its own drawing via `record_score`, client retried, reveal flipped when all scored) was fragile: a backgrounded/throttled phone, a per-phone 429, or a dropped call could leave a drawing stuck, and a client-driven reveal could race the backstop and discard a real AI result. Centralizing on the host (one reliable coordinator) throttles Gemini, removes the thundering herd, and makes reveal deterministic.

**Why server-revealed?** Earlier, the client called an explicit `reveal_round`; if it fired before all `record_score_for`s landed (incomplete snapshot, host refresh), drawings were orphaned at `ai_score=-1` AND the reveal disabled the backstop (`finalize_round` no-ops once status≠`scoring`). Making the **reducer** flip to reveal (atomic, serialized) removes that race entirely (Bug 15).

**Why the procedure returns JSON instead of writing?** Procedures and reducers run in different transaction contexts; a procedure could not reliably see the drawing row `submit_drawing` had just inserted → leaderboard/drawing disagreed (Bug 7). The procedure does HTTP only; a reducer persists.

**Consistency guarantee:** because `record_score_for` updates the drawing AND the player total in one atomic reducer, and reveal only happens once all are scored, the per-drawing score and the leaderboard total can never diverge in committed state.

---

## 8. Frontend Deep-Dive

### Routes
| Route | Screen | Who |
|---|---|---|
| `/` | Landing — Create Room or Join (doodle background) | Anyone |
| `/host/[code]` | Host TV display (all game states) | Host on laptop/big screen |
| `/join/[code]` | Nickname + color → join | Player on phone |
| `/play/[code]` | Player controller + canvas | Player on phone |

### SpacetimeDB React hooks
```ts
const [rooms] = useTable(tables.room.where(r => r.code.eq(code)));
const [players] = useTable(tables.player.where(r => r.roomId.eq(roomId ?? 0n)), { enabled: !!roomId });
const createRoom = useReducer(reducers.createRoom);          // fire-and-forget
const scoreDrawing = useProcedure(procedures.scoreDrawing);  // returns Promise<string>
const recordScore = useReducer(reducers.recordScore);
const { getConnection } = useSpacetimeDB();
const myPlayer = players.find(p => p.identity.isEqual(getConnection()?.identity!));
```

### Canvas (`/play/[code]`) — BEHAVIOR, do not restyle the element
- `<canvas width={800} height={800}>`, Pointer Events, `setPointerCapture`, `touch-action: none`.
- Smooth strokes via **quadratic Bézier** (midpoint method); a tap renders a dot.
- Coordinate transform uses `getBoundingClientRect()` ratio (do NOT put `objectFit:contain` on the canvas — Bug 2).
- Downscales to ~512px before upload + before Gemini.
- The drawing screen fills the viewport; canvas is the large area, controls below.
- **Brush default is black (`#000000`); the drawing surface background is white.**

### Sabotage effects (applied on victim's `/play`)
Victim subscribes to `sabotage.where(r => r.toPlayerId.eq(myPlayerId))`, `active === true`. **Each effect now auto-expires after `round_duration_secs / 10` seconds**, computed client-side from `sabotage.created_at` (a banner shows the attacker + a live countdown).

| Effect | Implementation |
|---|---|
| `invert` | CSS class `sabotage-invert` → `filter: invert(1)` on the canvas wrapper |
| `spin` | CSS class `sabotage-spin` → `transform: rotate(180deg)` on the wrapper |
| `giant_brush` | Overrides brush size to 60px while active |
| `invisible_ink` | `globalAlpha = 0` while drawing; final image is whatever survives |
| `fake_popup` | Fake OS modal overlay inside the canvas area (dismiss handler is a no-op) |

> **Canvas & sabotage caveat (for any UI work):** never add `transform`/`filter`/`box-shadow` to the wrapper that carries `sabotageClasses`, and never wrap the `<canvas>` in a remounting `motion` element — both fight the sabotage CSS / clear the drawing. Put any brutalist frame on an OUTER element. This rule was honored throughout the reskin.

### Countdown
`round.endsAt` is a `Timestamp`. `secondsLeft = max(0, ceil((endsAtMs - now)/1000))`, updated every 200ms; freezes when the player submits (shows ✓). Color shifts white → yellow (≤10s) → red (≤5s).

### Hall of Shame
Computed client-side, no extra AI calls:
```ts
const allScored = drawings.filter(d => d.submitted && d.scored && d.imageUrl);
const shame = [...allScored].sort((a,b) => a.roundScore - b.roundScore).slice(0,3);
```
Shown on both the host finished screen and each player's finished screen.

### Sabotage target menu (player)
The menu lists only players who **haven't submitted this round** (computed live from `drawings`); as each player submits they drop out of everyone's menu in real time, and a picked-but-now-submitted target is cleared before launch. The server enforces the same rule (`use_sabotage` rejects an already-submitted target) so a race can't land a useless sabotage.

### 8.4 Host scoring loop (`/host`)
When `room.status === 'scoring'`, a `useEffect` (keyed once per round) runs an async loop that reads the **live** `drawings`/`currentRound` through refs, scores every still-pending drawing with bounded concurrency (`mapWithConcurrency(_, 4)` + per-call retry/backoff + speed-only fallback), and calls `recordScoreFor` for each. It **never** calls reveal — the server does. The loop stops once all drawings are scored; recovers correctly on host refresh (already-scored drawings are skipped). See §7.

### 8.5 Connection resilience (mobile Safari) — `/play`

> **ROOT CAUSE (Bug 24, the big one):** Every iOS-only symptom — "No drawing submitted" after submitting, a **missing Hall of Shame**, stuck on "Syncing…", stuck on the scoring screen — was **one bug**: a **WebSocket decompression failure in the SpacetimeDB TS SDK on all WebKit browsers** (iOS Safari, iOS Chrome, **and macOS Safari**). See clockworklabs/SpacetimeDB **#5031** (fixed in SDK **v2.4.0**). On WebKit, compressed WS frames throw `TypeError: undefined is not a function (…decompressedStream…)` and are **silently dropped**. The server only compresses frames **above a size threshold**, so:
> - small frames (room, player rows) arrive **uncompressed** → those tables synced fine (standings were always correct);
> - large frames — the `drawing` table's initial subscription snapshot, batched score updates, the `SubscriptionApplied` for big queries — are **compressed → dropped** → the `drawings` cache stayed **empty** ("No drawing submitted" / missing Hall of Shame), reveals were missed (stuck on scoring), and `isReady` wedged.
> Android Chrome (Blink) + desktop have a working `DecompressionStream`, which is exactly why they were unaffected.
>
> **THE FIX:** `.withCompression('none')` on the `DbConnection.builder()` in `app/providers.tsx`. The server then sends everything uncompressed — negligible bandwidth for this small game (drawings are Supabase URLs, not blobs) — and iOS behaves identically to Android/desktop. **Remove once the project is on SDK ≥ 2.4.0** (the logs already nag `A new version of SpacetimeDB is available: v2.4.0`), which fixes the decompression path properly.
>
> **History / lesson:** before #5031 was found, this was misdiagnosed as screen-dim socket suspension, subscription cache eviction, and unreliable `isReady`, and a stack of compensating heuristics was added (screen Wake Lock, sticky `roomId`/`myPlayerId`, a `settled` timer, a data-aware render gate, extra reload watchdogs). **All of that was reverted** once the real cause was confirmed — they were treating dropped frames. Don't re-add them; fix the transport, not the symptoms.

What remains on `/play` (all pre-dates the compression saga and is still correct):
- **Render is gated on subscription readiness.** `useTable` returns `[rows, isReady]`; the play page derives `subsReady = playersReady && roundsReady && drawingsReady` and shows "Syncing…" for any non-lobby state until those initial-syncs complete, so we never paint wrong states off not-yet-synced data (Bug 18). With compression off, `isReady` is reliable again, so this no longer hangs.
- **Supabase upload retries 3× with backoff** in `handleSubmit` — a single failed upload used to silently submit `image_url=''` → "score with no drawing" on iOS. (Bug 19)
- **Reload watchdogs** (last-resort resync, since the SDK has **no auto-reconnect** — a full page reload via the connection builder is the only reconnect path): (a) on tab refocus/wake, reload if the socket is dead; (b) reload a few seconds after a confirmed drop; (c) post-submit, reload if our drawing row is **missing** (~7s) or **present-but-unscored** (~25s). A healthy phone's score lands first and clears the watchdog, so it never reloads.
- **Crash guard:** identity comparisons guard against an undefined `myIdentity` (`!!myIdentity && p.identity.isEqual(myIdentity)`) so a transient null can't throw and blank the screen.

> **Known-hard residual:** the SDK still has no reconnect, so a genuinely dropped socket (network loss, or iOS fully backgrounding the tab mid-round) recovers only via the reload watchdogs, not instantly. This is now rare — with compression off, the everyday iOS failure (dropped frames) is gone.

> **Identity note:** `myIdentity` is read as `getConnection()?.identity`. A reactive `useSpacetimeDB().identity` was tried and reverted (it widened the undefined-on-first-render window and blanked screens); if revisited, every `isEqual(myIdentity)` MUST be undefined-guarded.

---

## 9. UI Reskin (neo-brutalist arcade)

A **presentation-only** reskin (spec: `07-ui-reskin.md`). No game logic, reducers, procedures, subscriptions, canvas math, or pointer handlers were changed.

### Foundations
- **Tailwind v4** via `@tailwindcss/postcss`. `postcss.config.mjs` = `{ plugins: { '@tailwindcss/postcss': {} } }`. **This file must be committed** or production ships unstyled (Bug 12).
- `app/globals.css`: `@import "tailwindcss";` + Google Fonts `@import` (Fredoka, Inter) + `@theme { --font-display: 'Fredoka',...; --font-sans: 'Inter',...; }` + brutalist color tokens in `:root` (`--magenta #FF2E88`, `--yellow #FFD60A`, `--green #00E08A`, `--cyan #19D3FF`, `--red #FF4D4D`, `--canvas #0E0E16`, `--surface`).
- **Element resets live in `@layer base`** so Tailwind utilities win. (A leftover unlayered `button { font-family: inherit }` was beating the `font-display` utility, so buttons rendered in Inter instead of Fredoka — Bug 13.)
- Legacy component classes (`.sabotage-*`, `.spinner`, `.badge`, `.btn-*`, `.card`) remain unlayered. **`.sabotage-*` is behavior — never touch it.**

### Primitives (`app/components/`)
- **`BrutalButton`** — `motion.button`, spring hover-lift (`scale 1.05, y -3`) + tap-depress (`scale 0.95` + shadow collapse), `font-display font-extrabold uppercase`. Props: `color` (magenta/yellow/green/cyan/red/surface), `size` (sm/md/lg/xl). Exports `cn()` (clsx+tailwind-merge).
- **`BrutalCard`** — `motion.div`, `border-4 rounded-[24px]`, `8px 8px 0 0` hard offset shadow, same color set.
- **`CountUp`** — animates a displayed number from previous → new (rAF); presentation only, never alters data.

### Color semantics (≤ ~3 per screen)
magenta = primary CTA · yellow = points/winner · green = AI-recognized/success · cyan = secondary/info/waiting · red = sabotage/danger · surface = neutral cards. Player avatar colors are data, exempt from the limit.

### Per-screen notes
- **Landing:** doodle background (`/doodle-background.png`, `cover`) under an 85% canvas overlay; title with magenta drop-shadow; Create Room (magenta) + Join (cyan), equal size, aligned to card bottom via `mt-auto`.
- **Host lobby:** centered `max-w-7xl`; QR in a **yellow card** + **Copy link** button; room code in a surface card (`text-6xl`, fits 6-char codes) + **Copy code** button; players as big colored pills (avatar color) with inline ✕ kick; Game Setup column (rounds / draw-time 30/60/90/120s / words) + Start Game.
- **Host in-round:** huge word; countdown color shift; player chips flip green + ✓ on submit.
- **Host scoring:** cyan card, bouncy dots, "N drawings still being scored" (`submitted && aiScore < 0`).
- **Host reveal:** "Gallery" surface card (drawing grid) + yellow Leaderboard card + magenta Next/End.
- **Host finished:** big yellow **Champion** card (crown icon, CHAMPION, name, black points pill) + **confetti** (canvas-confetti) + podium (2nd/3rd) + final standings + Hall of Shame gallery.
- **Player:** join card; drawing controller (palette swatches, brush chips, Clear/Submit, sabotage sheet with chunky red chips); scoring "The AI is judging your masterpiece…"; reveal distinguishes Loading / Finalizing / score / no-drawing; finished champion card + standings + Hall of Shame.

### Reference design
`Party Drawing Game UI Design/` is a separate shadcn/react-router mock used as a visual reference. It is **gitignored and excluded from `tsconfig.json`** so its missing deps don't break `tsc`/`next build`.

---

## 10. Generated Bindings Reference

`src/module_bindings/types.ts` — row types (camelCase). **u64 = `bigint`; u32/i32 = `number`.**
```ts
Room    = { roomId, code, hostIdentity, status, totalRounds, currentRound, wordSource, roundDurationSecs, createdAt }
Player  = { playerId, roomId, identity, nickname, avatarColor, isHost, totalScore, sabotageAvailable, connected, joinedAt }
Round   = { roundId, roomId, roundNumber, word, status, startedAt, endsAt }
Drawing = { drawingId, roundId, roomId, playerId, imageUrl, submitted, secondsLeft, aiScore, aiGuess, aiRoast, roundScore, scored }
Sabotage= { sabotageId, roundId, roomId, fromPlayerId, toPlayerId, effect, active, createdAt }
```

Reducer params:
- `createRoom`: `{ code }`
- `joinRoom`: `{ code, nickname, color }`
- `kickPlayer`: `{ targetPlayerId }`
- `startGame`: `{ roomId, totalRounds, wordSource, customWords, roundDuration }`  ← `roundDuration` added
- `nextRound` / `endGame`: `{ roomId }`
- `submitDrawing`: `{ roundId, imageUrl, secondsLeft }`  (server ignores `secondsLeft`; kept for binding compat)
- `useSabotage`: `{ roundId, targetPlayerId, effect }`
- `recordScore`: `{ roundId, score, guess, roast }`  (LEGACY — per-phone path, unused by current client)
- `recordScoreFor`: `{ roundId, playerId, score, guess, roast }`  ← NEW (host-driven scoring, current)
- `revealRound`: `{ roundId }`  ← NEW (host-only; now redundant with server-side reveal, unused by client)
- `setConfig`: `{ apiKey }`
- `seedWords`: `{}`

Procedure params (both return `string`):
- `scoreDrawing`: `{ imageBase64, word }` → JSON string  ← signature changed (no roundId/playerId; no longer returns i32)
- `roastInProgress`: `{ imageBase64, word }`

> After any change to reducer/procedure **signatures or tables**, you MUST run `spacetime generate` and commit `src/module_bindings/`. Pure logic changes inside a reducer body do not need regen.

---

## 11. Bugs Found & Fixed (history)

1. **Gemini `inline_data` → `inlineData` (camelCase).** snake_case made Gemini ignore the image → garbage/fallback scores.
2. **Canvas coordinate offset** from `objectFit: contain` letterboxing — removed.
3. **Host counted as a player** — `create_room` no longer inserts a player; host is `room.host_identity`.
4. **`makeRandom` not exported** — replaced with `timestamp % pool.length` word selection.
5. **Drawing-not-found race in original `score_drawing`** — superseded by the record_score architecture (Bug 7).
6. **Gemini empty/truncated JSON:** (a) `responseMimeType` removed; (b) **`thinkingBudget: 0`** added (thinking model ate the token budget); (c) `maxOutputTokens` 200 → 500; (d) `extractGeminiText()` now handles both a single JSON object and NDJSON.
7. **Procedure-vs-reducer scoring race (MAJOR):** `score_drawing` writing via `ctx.withTx` couldn't see the freshly-inserted drawing row → leaderboard/drawing disagreed, scores showed 0. **Fix:** procedure returns JSON only; new `record_score` reducer persists drawing + player total atomically.
8. **Supabase uploads silently failing:** missing INSERT and SELECT RLS policies (SELECT needed because `upsert: true` reads first). Added both; `upsert: true`.
9. **bigint `===` (param vs table) unreliable (MAJOR):** caused (a) early-end miscount and (b) `submit_drawing` failing to find the `end_round` placeholder → **duplicate drawing rows** → "No drawing submitted" on reveal + leaderboard 0. **Fix:** `.toString()` comparisons in `submit_drawing`, `use_sabotage`, `end_round`, `record_score`, and the play page's `myDrawing` lookup.
10. **Round didn't end when everyone submitted** — added early-end in `submit_drawing` (counts distinct submitted players via `round_id` filter, includes the just-inserted row).
11. **Production stuck "Connecting…":** `providers.tsx` DB-name fallback was the template's `'nextjs-ts'`; `.env.local` is gitignored so Vercel hit the fallback. Set fallback to `'doodledash'`.
12. **`postcss.config.mjs` never committed** — local builds worked (file on disk) but Vercel would ship **unstyled**. Now committed.
13. **Buttons not Fredoka:** unlayered `button { font-family: inherit }` beat the layered `font-display` utility (Tailwind v4 utilities live in a cascade layer). Moved element resets into `@layer base`.
14. **Reveal advanced before scores landed / premature 0:** reveal was on a fixed timer. Now the persisting reducer flips to reveal only when all drawings are scored; `finalize_round` is the fallback that force-finalizes stragglers.
15. **Scoring race re-architecture (MAJOR):** the per-phone host-scoring snapshot revealed before stragglers landed and the client `reveal_round` could race / defeat the backstop, orphaning drawings at `ai_score=-1`. **Fix:** host scores **reactively over live data** in a loop; the **server** reveals atomically in `record_score_for` once all are scored (client never reveals); `REVEAL_MICROS` 25s→45s so the backstop never races a host still on Gemini. (See §7.)
16. **Stale-identity mis-attribution (MAJOR, iPhone "no drawing / leaderboard 0"):** a returning player reuses their anonymous identity, so the same identity has one player row **per game**. The old `findPlayerByIdentity` matched identity alone and returned an arbitrary/stale row → `submit_drawing`/`use_sabotage`/`record_score` attributed a player's drawing, score, submitted-state and sabotage to a player row in a **different (old) room** → leaderboard stuck at 0, host "who submitted" chips never lit, players couldn't see their own drawing. **Fix:** `findPlayerInRoom` matches identity **AND** `room_id`; `join_room` dedups same-identity rows within a lobby.
17. **Speed bonus trusted the client clock:** `submit_drawing` used the client-sent `secondsLeft`. **Fix:** compute it server-side from `ends_at − now`; ignore the arg.
18. **iOS "No drawing submitted" / half-empty finished screen / "refresh doesn't fix":** the play page ignored `useTable`'s `isReady` and rendered game screens off not-yet-synced subscriptions (iOS syncs slower under weak signal / Low Power Mode). **Fix:** gate every non-lobby screen on `subsReady`; show "Syncing…" until initial sync completes.
19. **iOS "score with no drawing":** the Supabase image upload was a single `await` that swallowed errors and submitted `image_url=''`. **Fix:** retry the upload 3× with backoff.
20. **Late submit after reveal stranded a drawing:** an auto-submit landing after the round revealed reset the row to unscored with no one left to score it. **Fix:** `submit_drawing` rejects submissions once the round is past `scoring`.
21–23. **(retracted)** A first pass attributed the iOS failures to three separate causes — screen-dim socket suspension (Wake Lock), subscription cache eviction (sticky ids), and unreliable `isReady` (settle timer + data-aware gate). All three were **symptoms of Bug 24**, and those heuristic fixes were reverted. Numbers kept as a tombstone so the history reads straight.
24. **iOS/macOS WebKit WebSocket decompression bug → empty `drawings`, missing Hall of Shame, stuck scoring/syncing (MAJOR, the real one):** the SpacetimeDB TS SDK (≤2.3.x) drops every compressed WS frame on WebKit (`TypeError: undefined is not a function …decompressedStream…`, clockworklabs/SpacetimeDB#5031, fixed v2.4.0). The server compresses only frames over a size threshold, so small room/player frames arrived (standings correct) but the large `drawing` snapshot + batched updates were dropped → empty `drawings` cache and missed reveals on iPhone/iPad/Mac-Safari; Android/desktop (Blink) were fine. **Diagnosis tell:** an empty Hall of Shame (it reads ALL players' drawings) while the leaderboard was correct ⇒ the whole `drawings` cache was empty, not just my row. **Fix:** `.withCompression('none')` on the connection builder (`app/providers.tsx`). Revisit when on SDK ≥ 2.4.0.

---

## 12. Game Flow (end-to-end)

```
1. Host → "Create Room" → create_room(code) → /host/<CODE>
2. Players scan QR / visit /join/<CODE> → nickname + color → join_room → /play/<CODE>
3. Host sets rounds + draw-time + words → "Start Game" (≥2 players) → start_game → beginRound(1)
4. in_round: everyone draws. ~halfway: roast_in_progress() shows a private flavor line.
5. Submit (or auto-submit at 0s): downscale → Supabase upload (retry 3×) → submit_drawing
   (server computes the speed bonus). The phone just watches its own drawing row.
6. Optional: use_sabotage(targetPlayerId, effect) → victim's canvas gets the effect for
   round_duration/10 seconds.
7. Round → scoring when all submitted (early-end) or the round timer fires (end_round).
8. HOST scores every drawing (scoreDrawing HTTP → recordScoreFor) → the SERVER flips to
   reveal once all are scored; the 45s finalize_round is a host-crash backstop.
9. Reveal: host shows the gallery + leaderboard; players see their own score/rank.
10. Host "Next Round" → repeat; after the last round → finished: champion + confetti + standings
    + Hall of Shame (3 lowest round_score drawings with imageUrl).
```

---

## 13. How to Run Locally

```bash
npm install
cd spacetimedb && npm install && cd ..
npm run dev          # http://localhost:3000  (connects to Maincloud by default)
```
`.env.local` points at `wss://maincloud.spacetimedb.com` / `doodledash`, so no local STDB server is needed. To run a local server, `spacetime start` (port 3000 — move Next.js to 3001 and repoint `.env.local`).

---

## 14. How to Deploy Updates

### SpacetimeDB module
```bash
cd spacetimedb && npm run build && cd ..
# Hot-swap (no data wipe; use when schema is unchanged):
spacetime publish --module-path spacetimedb doodledash --server maincloud --yes=all
# Only if reducer/procedure SIGNATURES or TABLES changed:
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
# A full --delete-data publish re-runs init → re-set the key:
spacetime call doodledash set_config '"<GEMINI_KEY>"'
```
> The `--yes` flag takes values: `spacetime publish ... --yes=all` skips the remote + destructive confirmations non-interactively. (`-y` alone prompts on Maincloud.)

### Frontend
```bash
git add -A && git commit -m "..."
git push origin main          # Vercel auto-deploys
# or: npx vercel --prod --yes  (run from the project dir, not $HOME)
```

### Logs
```bash
spacetime logs doodledash -n 100        # or -f to follow
# Useful lines:
# [submit_drawing] round=.. players=3 submitted=3 ids=[..] allDone=true
# [score_drawing] HTTP 200 word=..   /  OK score=.. guess=".."
# [record_score_for] player=.. round=.. ai=.. +speed=.. = ..            (host-driven, current)
# [record_score_for] all N drawings scored — revealing round ..
# [end_round] no submissions to score — revealing round .. immediately
# [finalize_round] forced score drawing=.. = .. (speed only)           (host-crash backstop)
```

### Reset all game data
```bash
spacetime publish --module-path spacetimedb doodledash --server maincloud --delete-data --yes=all
spacetime call doodledash set_config '"<GEMINI_KEY>"'
```

---

## 15. Known Limitations & Next Steps

- **Gemini free tier** rate-limits (429); add billing for real load. On 429 the player still gets the speed bonus.
- **`round_id` is a global autoincrement** — it never resets between games (round 1 of a new game might be `round_id=40`). The displayed Round NUMBER (`round_number`) is always 1..N. Don't confuse the two when reading logs.
- **No spectator support.** A player's identity IS stable across reloads (token persisted in `localStorage`), but the **same identity accumulates one player row per game** it has played; lookups are now room-scoped (`findPlayerInRoom`) so this no longer mis-attributes, but the old rows linger in the DB.
- **iOS Safari socket suspension (residual):** the SDK has no auto-reconnect; if an iPhone is fully backgrounded/dimmed mid-round it can miss that round (see §8.5). Mitigated (isReady gating, upload retry, reload watchdogs) but not fully eliminated. Android Chrome is unaffected.
- **`doodle-background.png` is ~6.9 MB** — compress / convert to WebP for faster first paint.
- **Word selection** is `timestamp % pool.length` (not true RNG) but avoids repeats within a game via a used-words set.
- **Supabase bucket is public** — fine for the hackathon; lock with RLS for production.
- Possible polish: doodle background on more screens; custom domain; spectator mode.

---

## 16. SpacetimeDB 2.3.0 API Quick Reference

```ts
import { ScheduleAt, Timestamp } from 'spacetimedb';        // NOT from /server
import { schema, table, t, SenderError } from 'spacetimedb/server';

// Column types: t.u64()/.i64() → bigint; t.u32()/.i32()/.f64() → number; t.bool();
// t.string(); t.identity() (.isEqual()); t.timestamp() (.microsSinceUnixEpoch: bigint);
// t.scheduleAt(); modifiers .primaryKey() .autoInc() .unique() .index('btree')

// Reducer DB ops (ctx.db)
ctx.db.player.insert({ player_id: 0n, ... })            // 0n = autoInc
ctx.db.player.player_id.find(id)                        // by PK/unique → row | null
ctx.db.player.player_id.update({ ...row, field })       // by PK
ctx.db.player.player_id.delete(id)
[...ctx.db.player.room_id.filter(roomId)]               // by index → iterator
// COMPARE bigints with .toString() when one side is a param.

// Procedure DB ops — read only via ctx.withTx; NEVER hold a tx open during ctx.http.fetch
const key = ctx.withTx(tx => tx.db.config.id.find(0)?.gemini_api_key ?? '');

// Schedule one-shot
ctx.db.round_timer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.time(microsBigint), ... });

// HTTP (synchronous) in procedures
const res = ctx.http.fetch(url, { method:'POST', headers:{...}, body: JSON.stringify({...}) });
res.status; res.text(); res.json();

// Auth
if (!ctx.sender.isEqual(room.host_identity)) throw new SenderError('Not the host');

// Scheduled reducer signature
export const end_round = spacetimedb.reducer({ arg: round_timer_table.rowType }, (ctx, { arg }) => { /* arg.round_id, arg.room_id */ });
```

---

## 17. Files NOT to Touch

| File / dir | Why |
|---|---|
| `src/module_bindings/**` | Auto-generated. Run `spacetime generate` after signature/table changes. |
| `app/globals.css` `.sabotage-*` rules | Sabotage **behavior**, not decoration. |
| The `<canvas>` element + its `sabotageClasses` wrapper in `/play` | Drawing behavior; see the canvas caveat. |
| `spacetime.json` / `node_modules/` | CLI-managed / deps. |
| `postcss.config.mjs` | Required for Tailwind; keep it committed. |

---

## 18. Vercel Deployment Details

- Framework: Next.js (auto-detected). Build: `next build`. Team: `arnab-bhowals-projects`. Project: `doodledash`. Prod domain: `doodledash-mu.vercel.app`. GitHub `main` auto-deploys.
- Manual redeploy: `npx vercel --prod --yes` (from the project dir).
- Env var change: `npx vercel env rm/add <NAME> production` then redeploy (NEXT_PUBLIC_* are baked at build).

---

*Originally built 2026-05-31. Last updated 2026-06-03 — after the move to **host-driven scoring + server-side reveal** (host scores every drawing over live data, `record_score_for` reveals atomically when all are scored, 45s backstop), the **room-scoped player lookup** (`findPlayerInRoom`) that fixed stale-identity mis-attribution, the **server-clock speed bonus**, and the **iOS resilience** pass on `/play` (`isReady`-gated rendering, Supabase upload retry, reload watchdogs). Earlier: the procedure→reducer scoring re-architecture, configurable round duration, bigint/`.toString()` fixes, and the neo-brutalist UI reskin (Tailwind v4 + Fredoka/Inter + motion + confetti). Built with Claude (Sonnet 4.6 / Opus) via Claude Code.*
