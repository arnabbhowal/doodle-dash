# 04 — Frontend Spec (Next.js)

Built on the `spacetime dev --template nextjs-ts` scaffold (App Router). The template already wires a SpacetimeDB provider, server-side initial fetch, and the React hooks (`useTable`, `useReducer`) from `spacetimedb/react`. Procedures are called via the connection's `procedures` API and return a Promise.

> When writing UI components, follow the **frontend-design** skill conventions for layout/styling quality. Aim for a clean, playful, Skribbl-like look (rounded panels, bright accent colors, big readable type, chunky buttons). Mobile-first for `/play`, large-display-first for `/host`.

## Routes

```
app/
  layout.tsx           # providers (SpacetimeDB connection)
  page.tsx             # landing: Create Room | Join
  host/[code]/page.tsx # host / TV display
  join/[code]/page.tsx # nickname + color, then join
  play/[code]/page.tsx # player controller + canvas
```

- **`/`** — two actions: **Create Room** (generate a random 6-char code → `create_room` → route to `/host/[code]`), and **Join** (enter a code → `/join/[code]`).
- **`/join/[code]`** — nickname input + color swatches → `join_room` → route to `/play/[code]`.
- **`/host/[code]`** — the display. Renders lobby / in-round / scoring / reveal / finished based on `room.status`.
- **`/play/[code]`** — the controller. Renders lobby / drawing / reveal / finished based on `room.status` + `round.status`.

## Shared connection & identity
- One SpacetimeDB connection per client (from the template provider). Anonymous identity is fine.
- After `join_room`/`create_room`, the client finds its own `player` row by matching `player.identity == myIdentity` to learn its `player_id`.
- Persist `code` in the route; persist nothing sensitive in localStorage (note: artifacts/this app run in a normal browser, localStorage is fine here, but keep it to the room code / nickname for reconnect convenience).

## Host screen states
- **Lobby:** big **QR code** (encode `https://<deployed-domain>/join/<code>`), the join URL as selectable text, the code in large type, a live grid of `player` rows (nickname + color chip), player count. Config controls: number of rounds (e.g., 3/5/8) and word source (preset / custom textarea). **Start Game** (disabled < 2 players). Each player has a small **Kick** button → `kick_player`.
- **In round:** the `round.word` huge, a **countdown** computed from `round.ends_at` (e.g., `Math.max(0, ceil((ends_at - now)/1000))`, updated on a 200ms interval), and a grid of players showing submitted vs drawing (derive from `drawing` rows for this round).
- **Scoring:** "The AI is judging…" with a spinner until all this round's `drawing` rows have `scored == true` (or `finalize_round` flips to reveal).
- **Reveal:** the round's drawings sorted by `round_score` desc; show top 3 large (top 1 if < 4 players) with image, score, and `ai_guess`. Side panel: cumulative leaderboard from `player.total_score`. Wait for host **Next Round**.
- **Finished:** final leaderboard (winner highlighted), then the **Hall of Shame** — take all `drawing` rows across the game, sort by `round_score` asc, take the lowest 3, render each with image + word (look up the round) + `ai_guess` + `ai_roast`.

## Player screen states
- **Lobby:** "waiting for the host to start", player list + scores.
- **Drawing:** word + countdown at top; the **canvas**; **color palette**; **brush sizes** (e.g., S/M/L); **Clear**; **Submit**. After submit: disable canvas, show a **Sabotage** button if `sabotage_available` → opens a small sheet to pick a victim (other `player` rows) + an effect, calls `use_sabotage`. A thin bottom strip shows the mid-round roast text when it arrives.
- **Reveal:** your `round_score`, the AI's `ai_guess` for your drawing, your current rank.
- **Finished:** your final rank/score; point them at the host screen for the Hall of Shame.

## Drawing canvas
- HTML5 `<canvas>` sized to the viewport area. Use **Pointer Events** (`pointerdown/move/up`) so finger + mouse both work; call `setPointerCapture`. Disable page scroll/zoom on the canvas (`touch-action: none`).
- State: current color, brush size. Draw smooth lines (lineCap/lineJoin round; interpolate between points).
- **Submit / auto-submit:** at `Submit` or when the countdown hits 0 (if not yet submitted):
  1. Optionally downscale to ~512px max side.
  2. `canvas.toDataURL('image/png')` → strip prefix → keep base64.
  3. Upload the PNG blob to Supabase Storage → get public URL.
  4. `submit_drawing(roundId, url, secondsLeft)`.
  5. `score_drawing(roundId, playerId, base64, word)` (procedure).
- **Mid-round roast:** a one-time timer at ~15s into the round snapshots the canvas and calls `roast_in_progress(base64, word)`; show the returned line for a few seconds.

## Sabotage effects (applied on the victim)
The victim's `/play` screen subscribes to `sabotage.where(to_player_id == me && active == true)`. For each active effect, apply:
- `invert` → wrap the canvas in a div with `style={{ filter: 'invert(1)' }}`.
- `giant_brush` → override the victim's brush size to a large value while active.
- `invisible_ink` → set the stroke render to not show (e.g., draw with the background color / `globalAlpha` tricks) while active; their final image is whatever survives.
- `spin` → `transform: rotate(180deg)` on the canvas wrapper.
- `fake_popup` → render a fake OS/error modal overlay (e.g., "⚠️ System Update Required") with a dismiss button; purely cosmetic, blocks part of the screen.
All effects auto-clear when `end_round` sets `active=false` (subscription removes the row).

## Supabase Storage setup
- Create a Supabase project; create a **public** bucket `drawings`.
- Client uses `@supabase/supabase-js` with the project URL + anon key (in `.env.local` / Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- Upload path: `drawings/<code>/<roundId>/<playerId>.png`, `upsert: true`. Get the public URL and pass it to `submit_drawing`.
- The anon key + public bucket is acceptable for a hackathon; lock down with RLS later if needed.

## QR code
- Use `qrcode.react` (or similar). Encode the full join URL with the deployed domain. On the host lobby only.

## Env vars (frontend)
```
NEXT_PUBLIC_SPACETIMEDB_HOST=...      # maincloud host (or local)
NEXT_PUBLIC_SPACETIMEDB_DB_NAME=...   # your published module name
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_APP_URL=...               # used to build the QR/join link
```
(The template's `.env.local` already sets the SpacetimeDB connection vars for local dev.)

## UX polish that wins demos
- Big, satisfying countdown with a color shift in the final 5s.
- A "submitted!" confetti/checkmark on the host grid as each player comes in.
- The reveal: animate scores counting up; show the AI's guess as a speech bubble.
- The Hall of Shame: gallery-frame the 3 worst with the roast as a caption. This is the screenshot people share.
