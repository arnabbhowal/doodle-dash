# DoodleDash — Build Spec (read this first)

A fast, multiplayer "draw-for-the-AI" party game for the **SpacetimeDB Launchpad Hackathon (NYC Tech Week, Jun 5–7 2026)**.

Everyone in the room draws the **same word** with their finger in **30 seconds**. A **Gemini vision model** scores each drawing out of 100 and adds a speed bonus (seconds left at submit). Players get one **sabotage** per game. After each round there's a score reveal; at the end there's a cumulative leaderboard and a **Hall of Shame** of the 3 worst drawings, each with the AI's guess and a savage one-liner.

This bundle is written to be handed to **Claude Code** to build the app, ideally close to one-shot. Read the files in order.

---

## File map

| File | What it covers |
|---|---|
| `README.md` | This file. Stack, build order, the non-negotiable gotchas. |
| `01-product-spec.md` | Game rules, screens, scoring, sabotage, Hall of Shame. The "what". |
| `02-architecture-and-data-model.md` | High-level architecture + full low-level design: every table, reducer, procedure, scheduled task, subscription, and the end-to-end data flow. The "how". |
| `03-gemini-integration.md` | Exact Gemini prompts, request/response shapes, model, cost/retry policy, API-key handling. |
| `04-frontend-spec.md` | Next.js routes, components, canvas, QR, sabotage CSS effects, Supabase upload, styling. |
| `05-spacetimedb-cheatsheet.md` | Distilled, verified SpacetimeDB 2.0 TS API + the gotchas that will otherwise waste hours. Keep this open while writing the module. |

## Stack (decided)

- **Backend:** SpacetimeDB **2.0** module in **TypeScript** (runs on V8). Deployed to **Maincloud**.
- **Frontend:** **Next.js** (App Router) + the SpacetimeDB React hooks. Deployed to **Vercel**.
- **AI:** **Gemini** (paid key) vision model, called from a SpacetimeDB **procedure** (`ctx.http.fetch`).
- **Image hosting:** **Supabase Storage** (public bucket). Only the resulting **URL** goes into SpacetimeDB; raw images never live in subscribed tables.
- **Auth:** anonymous identity + a chosen nickname. No signup.

## Build order (milestones)

1. **Scaffold** the project: `spacetime dev --template nextjs-ts`. Confirm the sample app runs at `localhost:3000`.
2. **Module schema + reducers** (`spacetimedb/src/index.ts`): rooms, players, rounds, drawings, sabotage, word bank, schedule tables, lifecycle `init` seed. No AI yet.
3. **Lobby + host screen + join flow** wired to live subscriptions. Create/join room, see players appear, host can start/kick. Verify real-time sync across two browser tabs.
4. **Round loop + canvas:** 30s scheduled timer, drawing canvas, submit → Supabase upload → `submit_drawing` reducer. Per-round reveal and host "Next Round".
5. **Gemini scoring procedure** (`score_drawing`) + speed bonus + cumulative score. Then the mid-round private roast procedure (`roast_in_progress`).
6. **Sabotage:** `use_sabotage` reducer + the CSS effects on the victim's screen.
7. **End game:** final leaderboard + Hall of Shame (derived client-side from stored scores/roasts — no extra AI calls).
8. **Deploy:** publish module to Maincloud, app to Vercel, set the Gemini key, point the QR code at the Vercel URL. Test on real phones.

## The five gotchas that will bite (details in `05-spacetimedb-cheatsheet.md`)

1. **Reducers cannot make HTTP requests.** Only **procedures** can. All Gemini calls live in procedures. Procedures are officially **beta** in 2.0 — fine for the hackathon, but don't be surprised by API churn; verify signatures against the generated bindings.
2. **A procedure cannot hold a DB transaction open while making an HTTP request.** Pattern: open `withTx` to read what you need → close it → `ctx.http.fetch` → open a new `withTx` to write results.
3. **`ScheduleAt` is imported from `'spacetimedb'`, not `'spacetimedb/server'`.** The 30s timer is a scheduled reducer.
4. **Never put base64 images in tables.** Subscribed tables replicate to every client; full images would flood every phone. Store only the Supabase URL string. Pass base64 directly to the scoring procedure as a call argument (it's the caller's own data).
5. **Generated bindings are the source of truth for names/syntax.** Client reducer/procedure names are camelCase; CLI uses snake_case; the `useTable` filter syntax (`tables.x.where(r => r.col.eq(v))`) and table mutation methods can shift between releases. When in doubt, read `src/module_bindings/` and https://spacetimedb.com/docs.
