# 01 — Product Spec

## One-line pitch
Pictionary where the judge is an AI. Everyone draws the same word in 30 seconds; a vision model scores each doodle out of 100, faster submissions score higher, and the worst drawings end up roasted on a Hall of Shame.

## Core loop
1. **Host** creates a room and opens the **host screen** (the "TV") on a laptop/big display. It shows a QR code + join link.
2. **Players** scan the QR (or open the link) on their phones, pick a nickname + avatar color, and land in the lobby. No app, no signup.
3. Host configures **number of rounds** and **word source**, then taps **Start**.
4. Each round: the **same word** (e.g. "umbrella") is shown to everyone. A **30-second** timer starts. Each player draws on their phone canvas.
5. At ~15s, each player privately gets a one-line AI roast of their in-progress doodle (only they see it, tucked at the bottom).
6. On submit (or at 0s, auto-submit), the drawing is scored by Gemini: **round score = AI quality (0–100) + seconds remaining at submit**.
7. **Round reveal:** host screen shows the top drawings + scores + the AI's guess for each. Host taps **Next Round**.
8. After the last round: **final leaderboard** crowns the winner, and the **Hall of Shame** shows the 3 lowest-scored drawings of the whole game, each with the AI's guess and a savage one-liner.

## Roles
- **Host:** creates the room, configures and starts the game, advances rounds ("Next Round"), can **kick** players. The host is also identified for authorization (only the host can call host-only actions). The host screen is a spectator/display view.
- **Player:** joins via code, draws, submits, optionally spends their one sabotage.

## Screens

### Host screen (`/host/[code]`)
- **Lobby:** big QR code, the join URL in text, live list of joined players (nickname + color), player count, round/word-source config controls, **Start Game** (enabled at ≥2 players), per-player **kick** buttons.
- **In round:** the current **word**, a large **countdown**, and a live grid of players showing who has **submitted** (checkmark) vs still drawing. (We do **not** stream live canvases — see "Non-goals".)
- **Scoring:** brief "The AI is judging…" state while scores come in.
- **Reveal:** the round's **top 3** drawings (top 1 if fewer than 4 players) shown large with score + AI guess; a side leaderboard of cumulative scores. Host **Next Round** button.
- **Finished:** final leaderboard with the **winner** highlighted, and the **Hall of Shame** wall: the 3 lowest-scored drawings across the game, each with its image, the word, the AI's guess, and the AI's roast.

### Join screen (`/join/[code]`)
- Nickname input + avatar color picker (Skribbl-style swatches). **Join** → player screen.

### Player screen (`/play/[code]`)
- **Lobby:** "waiting for host…", list of players + scores.
- **In round:** word at top, countdown, **drawing canvas** (finger/mouse), **color palette**, **brush sizes**, **clear**, **submit**. After submit: a **Sabotage** button (only if their sabotage is still available) → pick a victim from the player list + pick an effect. A subtle bottom strip shows the mid-round AI roast when it arrives.
- **Reveal:** your score this round, the AI's guess for your drawing, your current rank.
- **Finished:** your final rank/score; the dramatic stuff is on the host screen.

## Scoring rules
- `round_score = ai_score + seconds_left`
  - `ai_score`: integer 0–100 from Gemini, judging **recognizability of the target word** above all (not artistic beauty). Same rubric every time for fairness — see `03-gemini-integration.md`.
  - `seconds_left`: whole seconds remaining on the 30s clock at submit time (0–30). Auto-submitted / non-submitted drawings get 0.
- `player.total_score` accumulates `round_score` across rounds.
- **Fairness:** everyone draws the same word per round, judged by the same prompt/rubric, so scores are comparable.

## Sabotage
- Each player gets **exactly one** sabotage for the **whole game**, usable in any single round.
- A player can only sabotage **after they have submitted** their own drawing for the current round.
- They **choose the victim** from the live player list, and **choose the effect** from a small menu.
- Effects (applied to the victim's drawing screen, cleared at round end):
  - `invert` — invert the canvas colors (CSS `filter: invert(1)`).
  - `giant_brush` — force the victim's brush size to huge.
  - `invisible_ink` — strokes don't show up while drawing (the ink is "invisible" until... it just doesn't render; their submitted image is whatever they managed).
  - `spin` — flip the canvas 180° (`transform: rotate(180deg)`).
  - `fake_popup` — drop a fake system/error popup overlay they have to dismiss.
- The victim sees the effect hit instantly (SpacetimeDB sync) but **not who sent it** (surprise factor). Effect ends when the round ends.

## Hall of Shame
- Computed at game end from data already in the DB: the **3 drawings with the lowest `round_score`** across all rounds (1 if very few players).
- Each entry shows: the image, the word it was supposed to be, the AI's **guess**, and the AI's **roast** — all of which were captured during scoring, so **no extra AI calls** are needed at the end.

## Non-goals (explicit, to keep scope sane)
- **No live canvas streaming / live AI guessing mid-stroke.** Scoring happens once, after submit. (The original "watch the AI's mind change live" idea is intentionally dropped for fairness + cost; the mid-round private roast keeps a taste of it.)
- No persistent accounts, friend lists, or matchmaking.
- No spectator chat.
- Max ~16 players per room (soft cap; tune for the venue).

## Edge cases to handle
- Player joins mid-game → lands in lobby/spectating until the next round, or is allowed in for the next round only (simplest: can watch, scores from next round).
- Player disconnects mid-round → at round end they get an auto-zero drawing row with a canned roast ("rage quit, 0 points").
- Player never submits → auto-submit their current canvas at 0s client-side; if the client is gone, server zero-scores them.
- Fewer than 4 players → reveal shows top 1–2; Hall of Shame shows as many as exist.
- Two players try to use the same room code → `create_room` throws on duplicate; client retries with a new code.
