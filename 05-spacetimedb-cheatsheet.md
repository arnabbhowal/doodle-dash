# 05 — SpacetimeDB 2.0 TypeScript Cheatsheet

Verified against the official 2.0 docs (May 2026). Keep this open while writing the module. Where it says **VERIFY**, check the live docs / generated bindings because the API is still evolving (procedures are beta; the query-builder/filter API has shifted across releases).

## Doc links
- Getting started: https://spacetimedb.com/docs/
- Key architecture (tables/reducers/procedures/views/identity): https://spacetimedb.com/docs/intro/key-architecture
- Language support (TS modules run on V8): https://spacetimedb.com/docs/intro/language-support
- TypeScript quickstart: https://spacetimedb.com/docs/quickstarts/typescript
- Next.js quickstart: https://spacetimedb.com/docs/quickstarts/nextjs
- Functions / Reducers: https://spacetimedb.com/docs/functions/reducers
- Procedures (HTTP + AI example): https://spacetimedb.com/docs/functions/procedures
- Schedule tables (timers): https://spacetimedb.com/docs/tables/schedule-tables
- Tables (columns, indexes, constraints): https://spacetimedb.com/docs/tables
- Subscriptions: https://spacetimedb.com/docs/clients/subscriptions
- TypeScript client SDK reference: https://spacetimedb.com/docs/clients/typescript
- CLI reference: https://spacetimedb.com/docs/cli-reference
- Maincloud deploy: https://spacetimedb.com/docs/how-to/deploy/maincloud

## Project scaffold
```
spacetime login
spacetime dev --template nextjs-ts        # module + Next.js client + bindings + dev servers
# structure:
#   spacetimedb/src/index.ts   <- module (tables, reducers, procedures)
#   app/                       <- Next.js App Router UI
#   src/module_bindings/       <- generated types (source of truth for names)
```
Local server: `spacetime start` (port 3000, no SSL). `spacetime dev` auto-publishes + regenerates bindings on change.

## Defining the schema, tables, reducers
```ts
import { schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  player: table(
    { name: 'player', public: true },
    {
      player_id: t.u64().primaryKey().autoInc(),
      room_id:   t.u64(),            // add an index — VERIFY index syntax in docs
      identity:  t.identity(),
      nickname:  t.string(),
      total_score: t.i32(),
      sabotage_available: t.bool(),
    }
  ),
});
export default spacetimedb;

// Reducer with args
export const join_room = spacetimedb.reducer(
  { code: t.string(), nickname: t.string(), color: t.string() },
  (ctx, { code, nickname, color }) => {
    // ctx.sender is the caller Identity
    // ctx.db.<table>.insert({...}); iterate with ctx.db.<table>.iter()
    // index lookup pattern shown in docs: ctx.db.player.identity.find(ctx.sender)
  }
);

// Reducer with no args
export const say_hello = spacetimedb.reducer((ctx) => { /* ... */ });
```
- **Naming:** module exports can be snake_case; the generated **client** bindings expose camelCase (`reducers.joinRoom`), and the **CLI** uses snake_case (`spacetime call <db> join_room ...`). Use whatever the generated bindings show on the client.
- **Mutations (VERIFY exact methods):** `ctx.db.t.insert(row)`, iterate `ctx.db.t.iter()`, index find `ctx.db.t.<indexCol>.find(value)`. Update/delete-by-PK method names — confirm in the Tables docs / bindings.
- **Authorization:** compare `ctx.sender` (Identity) to a stored `host_identity`. Throw to reject + roll back the transaction.
- **Lifecycle/seeding (VERIFY):** there's an init-style lifecycle hook for seeding the word bank; confirm the 2.0 form (init vs clientConnected) in the docs.

## Scheduled reducer (the 30s timer) — VERIFIED PATTERN
```ts
import { ScheduleAt } from 'spacetimedb';          // NOTE: from 'spacetimedb', not '/server'
import { schema, table, t } from 'spacetimedb/server';

const round_timer = table(
  { name: 'round_timer', scheduled: (): any => end_round },   // points at the scheduled reducer
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    round_id: t.u64(),
    room_id: t.u64(),
  }
);

// the scheduled reducer receives the row as its arg
export const end_round = spacetimedb.reducer(
  { arg: round_timer.rowType },
  (ctx, { arg }) => {
    // arg.round_id, arg.room_id available; runs automatically at scheduled_at
  }
);

// schedule a one-shot at an absolute time (microseconds since epoch):
function scheduleRoundEnd(ctx, endsAtMicros: bigint, roundId: bigint, roomId: bigint) {
  ctx.db.round_timer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(endsAtMicros),  // ScheduleAt.interval(micros) for repeating
    round_id: roundId,
    room_id: roomId,
  });
}
```
- Timestamps are microseconds: `ctx.timestamp.microsSinceUnixEpoch + 30_000_000n` for "30s from now".
- Scheduled rows are typically deleted/updated after firing; for a one-shot, delete it in the reducer or let it be.

## Procedure (the ONLY place to call Gemini) — VERIFIED PATTERN
```ts
import { TimeDuration } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';

export const score_drawing = spacetimedb.procedure(
  { roundId: t.u64(), playerId: t.u64(), imageBase64: t.string(), word: t.string() },
  t.i32(), // return type (the score), optional to use
  (ctx, { roundId, playerId, imageBase64, word }) => {
    // 1) read what we need, then CLOSE the tx (no HTTP while a tx is open)
    const { apiKey, secondsLeft } = ctx.withTx(txCtx => {
      const cfg = txCtx.db.config.id.find(0);
      const d = /* find this player's drawing row for roundId */ null;
      return { apiKey: cfg?.gemini_api_key ?? '', secondsLeft: d?.seconds_left ?? 0 };
    });

    // 2) HTTP to Gemini (synchronous fetch, no open tx)
    let score = 0, guess = '', roast = "The AI couldn't make sense of it. That's on you.";
    try {
      const res = ctx.http.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ /* contents with text + inline_data, see 03 */ }),
          timeout: TimeDuration.fromMillis(15000),
        }
      );
      if (res.status === 200) {
        const data = res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const parsed = JSON.parse(text);
        score = parsed.score; guess = parsed.guess; roast = parsed.roast;
      } else if (res.status >= 500) {
        // ONE retry on 5xx (omitted here for brevity), then fallback
      }
    } catch (e) {
      // fallback values already set; do NOT loop
    }

    // 3) write results in a new tx
    ctx.withTx(txCtx => {
      // update drawing row: ai_score, ai_guess, ai_roast, round_score = score + secondsLeft, scored = true
      // update player.total_score += round_score
    });

    return score + secondsLeft;
  }
);
```
- `ctx.http.fetch(url, { method, headers, body, timeout })` — synchronous; `res.status`, `res.text()`, `res.json()`. Default timeout 30s, max 180s.
- **Procedures are beta** — verify the exact `procedure(...)` signature (some examples omit the return-type arg) and `ctx.withTx` shape against the live docs.
- `withTx` callbacks may run more than once — keep them pure (no external side effects, no captured mutable state). Do the HTTP **outside** `withTx`.

## Client: hooks, subscriptions, calling procedures — VERIFIED PATTERNS
```tsx
'use client';
import { tables, reducers } from '../src/module_bindings';
import { useTable, useReducer } from 'spacetimedb/react';

// subscribe (whole table)
const [players, isReady] = useTable(tables.player);

// subscribe with a filter (VERIFY exact form for your SDK version)
const [roomPlayers] = useTable(tables.player.where(r => r.roomId.eq(roomId)));

// call a reducer
const joinRoom = useReducer(reducers.joinRoom);
joinRoom({ code, nickname, color });
```
- **Calling a procedure** returns a Promise resolving to its return value:
  ```ts
  // via the connection object (VERIFY exact handle in the template, e.g. conn.procedures)
  const score = await conn.procedures.scoreDrawing({ roundId, playerId, imageBase64, word });
  const roast = await conn.procedures.roastInProgress({ imageBase64, word });
  ```
- StrictMode double-mount is handled by the SDK (one WebSocket). 
- Server Components can do an initial fetch (`lib/spacetimedb-server.ts` in the template) for fast first paint; Client Components keep the live subscription.

## Deploy
```
# module -> Maincloud
spacetime publish -s maincloud <db-name>      # VERIFY flag form in CLI reference
spacetime call <db-name> set_config "<GEMINI_KEY>"   # set the key once, off the browser
spacetime generate ...                        # regenerate client bindings if needed

# frontend -> Vercel: set NEXT_PUBLIC_* env vars (SpacetimeDB host + db name, Supabase, APP_URL)
# point NEXT_PUBLIC_APP_URL at the Vercel domain so the QR/join link is correct
```

## Quick gotcha checklist
- [ ] HTTP/Gemini only in **procedures**, never reducers.
- [ ] No open transaction during `ctx.http.fetch`.
- [ ] `ScheduleAt` imported from `'spacetimedb'`.
- [ ] Only URLs (not base64) stored in tables; base64 passed as a procedure arg.
- [ ] Subscriptions filtered per room.
- [ ] Host-only reducers check `ctx.sender == room.host_identity`.
- [ ] At most 1 retry on scoring; 0 on the roast; no polling loops (cost).
- [ ] Names/filters/mutation methods confirmed against `src/module_bindings/`.
