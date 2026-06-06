# 03 — Gemini Integration

All Gemini calls happen inside SpacetimeDB **procedures** via `ctx.http.fetch` (synchronous). Reducers cannot do this. A paid Gemini key is used, so rate limits aren't the worry — **cost** is. Keep calls minimal: scoring is **1 call per drawing per round**, the mid-round roast is **1 call per player per round**, and the Hall of Shame uses **0 extra calls** (it reuses roasts captured during scoring).

## Model & endpoint
Use a current **Gemini vision-capable Flash** model (Flash is cheap and fast — right for this). **Confirm the exact model id and endpoint in Google's docs at build time**, since model names change. The request shape is the standard `generateContent` REST call:

```
POST https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent?key=<API_KEY>
Content-Type: application/json
```

Image goes in as inline base64 (PNG):

```json
{
  "contents": [{
    "parts": [
      { "text": "<PROMPT>" },
      { "inline_data": { "mime_type": "image/png", "data": "<BASE64_NO_DATA_URL_PREFIX>" } }
    ]
  }],
  "generationConfig": { "temperature": 0.4, "maxOutputTokens": 200, "responseMimeType": "application/json" }
}
```

Notes:
- Strip the `data:image/png;base64,` prefix before sending — send raw base64 only.
- `responseMimeType: "application/json"` nudges Gemini to return parseable JSON; still parse defensively.
- The text answer is at `response.candidates[0].content.parts[0].text`. `JSON.parse` it inside a try/catch; on parse failure use the fallback.
- Procedure HTTP default timeout is 30s (max 180s). For scoring set ~15–20s; for the mid-round roast set ~8s so it never lingers into the next phase.

## Prompt 1 — Scoring (used by `score_drawing`)
The judge must be **fair, consistent, and focused on recognizability**, not artistic quality. Inject the known target word.

```
You are the impartial judge of a fast drawing party game. The player had 30 seconds
to finger-draw a single word on a phone. You are shown their drawing and told the
target word. Score how clearly the drawing communicates that EXACT word to a fresh
viewer who does not know the answer.

Target word: "<WORD>"

Scoring rubric (apply identically every time, be consistent and fair):
- 85-100: instantly and unambiguously reads as the target word.
- 60-84: clearly recognizable as the target with minor ambiguity.
- 35-59: on the right track; the idea is there but messy or incomplete.
- 10-34: barely related; you can sort of see what they were going for.
- 0-9: unrecognizable, blank, or unrelated.
Judge ONLY recognizability and clarity of the concept. Do NOT reward or punish
artistic beauty, color, or neatness. Be fair across players.

Also: (a) "guess" = the 1-3 words this drawing MOST looks like to you, ignoring the
target (your honest read). (b) "roast" = ONE short, playful, slightly savage sentence
about the drawing. Keep it light and funny, never mean about the person, never
profane, never about anything but the drawing.

Respond with STRICT JSON only, no markdown, no extra text:
{"score": <integer 0-100>, "guess": "<1-3 words>", "roast": "<one sentence>"}
```

Parsed result drives: `ai_score = score`, `ai_guess = guess`, `ai_roast = roast`, and `round_score = score + seconds_left`.

## Prompt 2 — Mid-round private roast (used by `roast_in_progress`)
Snapshot at ~15s, shown only to the drawer. Short and fun; no score.

```
You are a witty backseat art critic in a fast drawing game. The player is HALFWAY
through a 30-second attempt to draw "<WORD>". Look at their in-progress drawing and
give ONE short, playful, encouraging-but-cheeky line of commentary (max ~12 words).
Never mean about the person, never profane. Respond with the single line only,
no quotes, no JSON.
```

Return the raw line straight to the caller (private). On any error return an empty string.

## API key handling (keep it off the browser and out of source)
The procedure needs the key server-side. Recommended, definitely-works approach for the hackathon:

1. Add a `config` table (private, 1 row) and a `set_config(apiKey)` reducer that writes `gemini_api_key` (optionally host-only; or leave it callable only via CLI).
2. After publishing the module, set the key once from your machine via the CLI — the key never appears in the browser or the repo:
   ```
   spacetime call <db-name> set_config "<YOUR_GEMINI_KEY>"
   ```
3. `score_drawing` reads `gemini_api_key` from `config` inside its first `withTx`, then uses it in the `ctx.http.fetch` Authorization/query param.

Alternative to **verify**: SpacetimeDB module env-var/secret support (the procedures doc mentions "environment variables during development"). If 2.0 exposes module secrets cleanly, prefer that. **Do not** pass the key from the browser as a call argument (the docs' OpenAI example does this for brevity, but it leaks the key to clients) — use the `config`-table approach instead.

## Cost & reliability policy (so the bill stays small)
- **Scoring:** 1 call per drawing. Retry **at most once** on timeout/5xx. No retry on a 4xx (it'll just fail again) — go straight to fallback. Fallback writes `ai_score=0`, `round_score=seconds_left`, `ai_roast="The AI couldn't make sense of it. That's on you."`, `scored=true`.
- **Mid-round roast:** 1 call per player per round, **no retry**. Failure = show nothing.
- **No polling loops** anywhere. Everything is event-driven (client calls the procedure once; UI updates via subscription).
- Cap `maxOutputTokens` low (~200 scoring, ~40 roast) to minimize output cost.
- Keep uploaded snapshots modest (e.g., downscale the canvas to ~512px on the longest side before base64/upload) — smaller images = cheaper vision input and faster uploads.
