# 06 — Build Plan (Claude Code prompt sequence)

A milestone-by-milestone script for building DoodleDash with **Claude Code**. Each milestone is a **copy-pasteable prompt** plus a **verification gate** — don't move on until the gate passes. This keeps a near-one-shot run from drifting.

## How to use this
1. Put this whole `doodledash-docs/` folder in the repo (e.g. at the project root) so Claude Code can read it.
2. Start every session by having it load context (Prompt 0).
3. Paste one milestone prompt at a time. After each, run the verification gate yourself, then `git commit`.
4. If something in the SpacetimeDB API doesn't match the docs, tell Claude Code to check the live docs links in `05-spacetimedb-cheatsheet.md` rather than guessing.

**Golden rules to repeat to Claude Code as needed:**
- HTTP/Gemini only in **procedures**, never reducers. No open transaction during `ctx.http.fetch`.
- Only **URLs** in tables, never base64. Base64 goes as a **procedure argument**.
- Confirm names/filter/mutation syntax against `src/module_bindings/` and the doc links — the API is beta in places.
- Commit after every green gate.

---

## Prompt 0 — Load context (run once per session)
```
Read every file in ./doodledash-docs in order (README, 01–05). This is the full spec for
the app we're building: DoodleDash, a multiplayer draw-for-the-AI game on SpacetimeDB 2.0
(TypeScript module) + Next.js + Gemini + Supabase Storage.

Do not write code yet. Summarize back to me: (a) the three SpacetimeDB primitives the game
relies on, (b) the five gotchas from the README, and (c) the milestone build order. We will
then build it one milestone at a time, and I'll verify each before moving on.
```
**Gate:** its summary correctly names procedures-for-HTTP, scheduled-reducer-timer, tables+subscriptions; the no-base64-in-tables and no-tx-during-HTTP rules; and the 8 milestones.

---

## Milestone 1 — Scaffold
```
Scaffold the project with: spacetime dev --template nextjs-ts
Confirm the sample app runs at localhost:3000 and that spacetimedb/src/index.ts,
app/, and src/module_bindings/ exist. Then stop and show me the project tree and the
contents of spacetimedb/src/index.ts. Don't change anything yet.
```
**Gate:** sample app loads; you can add a Person and see it appear live across two browser tabs.

---

## Milestone 2 — Module schema + core reducers (no AI yet)
```
Implement the SpacetimeDB module in spacetimedb/src/index.ts per 02-architecture-and-data-model.md:
- Tables: room, player, round, drawing, sabotage, word_bank, config, round_timer (schedule),
  reveal_timer (schedule). Use the exact columns/types/public flags in the doc. Verify the
  table/index/scheduled-table syntax against 05-spacetimedb-cheatsheet.md and the live docs.
- Reducers: init (seed ~50 simple words + config row), create_room, join_room, kick_player,
  start_game, beginRound (internal helper), submit_drawing, use_sabotage, end_round
  (scheduled), finalize_round (scheduled), next_round, end_game.
- Implement the 30s timer as a scheduled reducer (ScheduleAt.time, imported from 'spacetimedb').
- Host-only reducers must check ctx.sender == room.host_identity.
- DO NOT add Gemini or any HTTP yet. Scoring stays as placeholders (ai_score = -1, scored=false).

Publish the module, regenerate bindings, and show me: the final index.ts, and the output of
a couple of CLI calls (create_room, join_room, then `spacetime sql "SELECT * FROM player"`).
```
**Gate:** module publishes clean; CLI calls create a room + players; scheduled `end_round` fires ~30s after a round is begun (test by manually beginning a round via CLI and watching logs).

---

## Milestone 3 — Lobby, host screen, join flow (live)
```
Build the Next.js UI for lobby + join, wired to live subscriptions (useTable/useReducer from
spacetimedb/react), per 04-frontend-spec.md:
- Routes: / (Create Room | Join), /join/[code] (nickname + color -> join_room), /host/[code]
  (lobby state), /play/[code] (lobby state only for now).
- Host lobby: QR code (encode NEXT_PUBLIC_APP_URL + /join/<code>), join URL text, live player
  grid, round/word-source config, Start Game (disabled < 2 players), per-player Kick.
- Subscriptions filtered per room. Each client finds its own player row by identity.
Follow the frontend-design skill for a clean, playful Skribbl-like look. Mobile-first /play,
large-display /host.

Show me the running app. I'll open /host in one tab and /join in two others to test.
```
**Gate:** create a room on `/host`; two phones/tabs join via the code; players appear live on the host grid; kick works; Start is gated at ≥2.

---

## Milestone 4 — Round loop + canvas + submit (still no AI)
```
Implement the round loop and drawing, per 01 and 04:
- start_game/next_round begin a round; clients render round.word + a countdown synced to
  round.ends_at, and the drawing canvas (Pointer Events, color palette, brush sizes, clear).
- Submit (or auto-submit at 0s): downscale canvas to ~512px, toDataURL png, upload to Supabase
  Storage (bucket "drawings", path <code>/<roundId>/<playerId>.png), then call submit_drawing
  with the URL + secondsLeft. Keep the base64 in a variable for the next milestone.
- Host in-round screen: word + big countdown + submitted/drawing grid.
- Per-round reveal screen (show images + placeholder scores) and a host "Next Round" button.
Set up @supabase/supabase-js and the NEXT_PUBLIC_SUPABASE_* env vars.

Show me a full 30s round across two players, ending in the reveal screen.
```
**Gate:** word shows; countdown counts; drawing works on a phone; submit uploads to Supabase and a `drawing` row gets the URL + seconds_left; round ends (timer) → reveal → Next Round advances.

---

## Milestone 5 — Gemini scoring + speed bonus + mid-round roast
```
Add the AI, per 03-gemini-integration.md, strictly inside procedures:
- score_drawing(roundId, playerId, imageBase64, word): read gemini_api_key from config and the
  drawing's seconds_left in a withTx (then close it), call Gemini vision with the scoring prompt,
  parse strict JSON {score,guess,roast}, then in a new withTx write ai_score/ai_guess/ai_roast,
  round_score = score + seconds_left, scored=true, and add round_score to player.total_score.
  At most ONE retry on timeout/5xx; otherwise the fallback values in the doc. No loops.
- roast_in_progress(imageBase64, word): one call, no retry, returns the line to the caller only.
- Client: after submit_drawing, call score_drawing(base64,...). At ~15s into the round, snapshot
  and call roast_in_progress; show the returned line privately at the bottom of /play.
- Reveal now shows real scores + AI guesses; host reveal shows top 3 (top 1 if <4 players).
Remember: no HTTP in reducers; no open tx during ctx.http.fetch. Verify the procedure signature
and ctx.withTx shape against the live docs (procedures are beta).

After publishing, I'll set the key with: spacetime call <db> set_config "<KEY>"
Then show me a scored round and a mid-round roast on a phone.
```
**Gate:** after setting the key, a submitted drawing gets a real 0–100 score + guess + roast; `round_score = score + seconds_left`; `total_score` accumulates; the mid-round roast appears only on the drawer's screen; a forced failure (bad key) yields the graceful fallback, not a loop.

---

## Milestone 6 — Sabotage
```
Implement sabotage per 01 and 04:
- After a player submits, if sabotage_available, show a Sabotage button -> pick victim from the
  player list + pick effect (invert | giant_brush | invisible_ink | spin | fake_popup) ->
  use_sabotage(roundId, victimId, effect). Enforce sabotage_available + submitted in the reducer.
- The victim's /play subscribes to sabotage.where(to_player_id == me && active == true) and
  applies the effect (CSS/state) as described. Effects clear when end_round sets active=false.
- Victim does NOT see who sent it.

Show me one player sabotaging another mid-round, the effect appearing instantly, and clearing
at round end.
```
**Gate:** sabotage is one-per-game (button disappears after use); only usable after submitting; the chosen effect hits the victim live and clears at round end.

---

## Milestone 7 — End game + Hall of Shame
```
Implement the finished state per 01 and 04:
- end_game sets room.status='finished'.
- Host finished screen: final leaderboard (winner highlighted) from player.total_score, then the
  Hall of Shame: take all drawing rows across the game, sort by round_score asc, show the lowest
  3 (fewer if needed) with image + the word + ai_guess + ai_roast. No new AI calls — reuse stored
  values. Add the demo polish from 04 (count-up scores, confetti on submit, framed Hall of Shame).
- Player finished screen: final rank/score, pointer to the host screen.

Show me a full game end-to-end with 3+ players and the Hall of Shame populated.
```
**Gate:** a full multi-round game completes; leaderboard is correct; Hall of Shame shows the worst 3 with their stored guess + roast; no extra Gemini calls fire at the end.

---

## Milestone 8 — Deploy
```
Deploy per 05-spacetimedb-cheatsheet.md:
- Publish the module to Maincloud and set the Gemini key there via spacetime call ... set_config.
- Deploy the Next.js app to Vercel with NEXT_PUBLIC_* env vars (SpacetimeDB host + db name,
  Supabase url/key, APP_URL = the Vercel domain so the QR/join link is correct).
- Confirm the client connects to the Maincloud DB and regenerate bindings if needed.

Give me the live host URL. I'll test a full game on real phones.
```
**Gate:** the deployed host URL works; phones join via QR over the internet; a full game runs end-to-end including scoring and Hall of Shame.

---

## If you want to compress to fewer pastes
Milestones 2–4 can be one prompt ("backend schema + lobby + round loop, no AI") and 5–7 another ("AI scoring + sabotage + end game"), but the smaller gates above are safer for a one-shot-ish run. Keep deploy (8) separate either way.

## Demo-day checklist
- [ ] Gemini key set on the **Maincloud** module (not just local).
- [ ] `NEXT_PUBLIC_APP_URL` points at the Vercel domain (QR works on phones).
- [ ] Supabase bucket is **public**; uploads succeed from a phone on cellular, not just wifi.
- [ ] Tested with the realistic player count for the room (and the ~16 cap holds).
- [ ] A round where someone doesn't submit → graceful auto-zero.
- [ ] A bad-network Gemini call → fallback, no hang.
- [ ] One sabotage of each effect type renders correctly on a phone.
```
