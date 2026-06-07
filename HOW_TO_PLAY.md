# 🎨 How to Play DoodleDash

> **Draw fast. Get roasted. Win.**
>
> A Jackbox-style party drawing game where the judge is an AI. Everyone draws the **same word** on their phone; a vision AI scores each doodle, the fastest submissions earn bonus points, and the worst drawings get immortalized on a Hall of Shame.

**Play now:** **https://doodle-dash-flame.vercel.app**

You need: one big screen (laptop / TV / monitor) to be the **Host**, and each player needs a **phone**. No app install, no signup.

---

## 🚀 Getting into a game

### If you're the Host (the big screen)
1. Open **https://doodle-dash-flame.vercel.app** on a laptop or TV.
2. Tap **Host Game**. You land on the host screen showing a big **QR code**, a **join link**, and a **room code**.
3. Wait for players to scan in. You'll see each player pop into the lobby with their nickname and color.
4. Configure the game (see below) and tap **Start Game** once at least **2 players** have joined.

### If you're a Player (a phone)
1. **Scan the QR code** on the host screen with your phone camera, or open the join link, or go to the site and tap **Join Game** and type the **room code**.
2. Pick a **nickname** (up to 10 characters) and an **avatar color**.
3. Tap **Join Game**. You're in the lobby — wait for the host to start.

> The **host is not a player** — they run the screen and don't draw. Everyone on a phone is a player.

---

## ⚙️ Game setup (host configures before starting)

| Setting | Options | Default |
|---|---|---|
| **Rounds** | 3, 5, or 8 | 3 |
| **Draw time** | 30s, 60s, 90s, or 120s per round | 60s |
| **Words** | **Preset** (built-in word bank) or **Custom** (type your own) | Preset |

- **Preset words** are simple, drawable nouns (cat, pizza, umbrella, rocket…). The same word is never repeated within a single game.
- **Custom words**: type your own list, one per line or comma-separated. Everyone draws from your list instead of the preset bank.
- **Players:** minimum **2**, maximum **16** per room.

---

## 🎮 How a round works

1. **The word appears.** Everyone in the room gets the **same word** (e.g. "umbrella"), shown on the host screen and at the top of every phone.
2. **The timer starts.** You have the configured draw time (30–120s). Draw the word on your phone canvas with your finger.
3. **A mid-round roast.** About halfway through, the AI quietly drops a one-line burn about your drawing-in-progress — just for you, at the bottom of your screen.
4. **Submit.** Tap **Submit** when you're happy with it. The sooner you submit, the bigger your **speed bonus**. If you run out of time, your canvas is **auto-submitted** at the buzzer.
5. **Self-grade.** Right after submitting, **guess your own AI score** (0–100) on the slider and **Lock in**. Nail it for a big bonus (see below).
6. **The AI judges.** Once everyone's in, the AI scores every drawing. The host screen shows "The AI is judging…".
7. **Reveal.** The host screen shows the **top drawings**, the **AI's guess** for each ("AI thought: …"), a **roast**, and the running **leaderboard**. Your phone shows **your** score, the AI's guess, and your current rank.
8. **Next round.** The host taps **Next Round**, and it repeats — until the last round.

---

## 🖌️ Your drawing tools

On your phone canvas you get:

- **Color palette** — 19 colors.
- **Brush sizes** — 4 sizes from fine to chunky.
- **Pen** — normal drawing.
- **Eraser** — paints white (the canvas background).
- **Fill** — tap inside an area to flood-fill it with the current color.
- **Undo** — step back your last stroke, fill, or clear.
- **Clear** — wipe the whole canvas.
- **Submit** — lock in your drawing.

---

## 🏆 Scoring

Your score each round is:

```
Round Score = AI Score + Speed Bonus
```

### AI Score (0–100)
A vision AI judges **how recognizable your drawing is** as the target word — *not* how pretty it is. It grades on a fixed rubric so it's fair and consistent:

- **Identifiability** (0–50): would a stranger who didn't know the word guess it from your drawing alone?
- **Key features** (0–30): how many of the essential features of the thing are actually drawn?
- **Form** (0–15): are the proportions and layout right?
- **Effort** (0–5): blank scribble vs. a finished, detailed attempt?

These add up to your 0–100 AI score. A crude-but-recognizable drawing typically lands around 60.

### Speed Bonus
**One point for every whole second left** on the clock when you submit. Submit a 90/100 drawing with 12 seconds to spare → **102 points** that round. (The bonus is measured by the server's clock, so you can't cheat it.) Auto-submitted or never-drawn = **0** speed bonus.

### ⭐ Self-Grade Bonus (+100)
After you submit, you guess your **own** AI score. If your guess lands **within ±5** of what the AI actually gives you — **and** the AI score is at least **20** — you bank a **+100 bonus** on top. Confetti included. (If you don't tap "Lock in" before time runs out, your current slider value is locked automatically, so you never miss out for not tapping.)

---

## 😈 Sabotage: Board Hijack

Each player gets **one sabotage for the whole game**: a **Board Hijack**.

**The rules:**
- You can only hijack **after you've submitted** your own drawing.
- You can only target a player who **hasn't submitted yet** (no point hijacking someone who's already done — and they drop out of your target list the instant they submit).
- Pick a victim → you **seize their canvas** and can **scribble all over it** for about **10 seconds** (this scales with draw time: ~5s on 30s rounds, up to ~20s on 120s rounds).
- You scribble on a pad on your phone; your strokes appear **live** on the victim's canvas. You even see their real drawing-so-far underneath, so you can deface it precisely.
- **Pile-ups are allowed:** several players can hijack the **same** board at once — total chaos.
- The victim sees a red banner ("Someone hit you — Board Hijacked!") with a countdown, but **not who** sent it.
- The hijack ends the moment the victim submits, or when the timer runs out. The victim **can keep drawing** during the hijack and can't undo your scribbles (but their own strokes are still undoable).

**Defense:** if you're being hijacked, **submit fast** — submitting instantly ends the hijack.

---

## 👀 Host "Peek"

While a round is running, the host can tap **Peek at drawings** to spectate everyone's canvases **live** (strokes stream in real time). It auto-shuffles between players every few seconds, and the host can step through manually. It's read-only — purely for the big-screen audience to watch the chaos unfold.

---

## 🎬 End of the game

When the final round is revealed, the host taps **End Game** and you get:

- **🏆 Champion** — the highest total score is crowned, with confetti.
- **Final standings** — everyone ranked by total points.
- **💀 Hall of Shame** — the **3 lowest-scoring drawings** of the entire game, shown with the picture, the word it was *supposed* to be, the AI's best guess, and its savage roast.

### 🔁 Play Again
The host can hit **Play Again** to open a quick 10-second vote. Everyone says **Yes** or **No** on their phone. Players who say yes restart in a fresh lobby (scores reset); everyone else is dropped.

---

## 💡 Tips to win

- **Recognizable beats beautiful.** The AI rewards "I can instantly tell what this is," not artistry. Draw the obvious, iconic version of the word.
- **Hit the key features.** A cat needs ears, whiskers, a tail. Missing features cost you the most points.
- **Speed is real points.** A fast, clear doodle often beats a slow masterpiece — every second left is a point.
- **Know your level for the +100.** The self-grade bonus is huge. Be honest about how good your drawing actually is.
- **Time your sabotage.** Submit early, then hijack the strongest player who's still drawing.
- **Submit to escape a hijack.** Being scribbled on? Finish and submit — it ends instantly.

---

*Have fun, and may your doodles be recognizable. 🎨*
