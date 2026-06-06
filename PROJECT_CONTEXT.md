# DoodleDash Project Context

DoodleDash is a real-time multiplayer drawing game powered by SpacetimeDB as the serverless relational database and WASM execution engine, and Gemini AI for visual guessing and roast generation.

---

## Technical Stack & Ports

- **Frontend**: Next.js 15 (App Router), React, HTML5 Canvas with Pointer Events for touch support.
- **Backend / DB**: SpacetimeDB 2.0 (TypeScript Server SDK).
- **AI Engine**: Gemini 2.0 Flash (integrated via HTTP POST fetch from SpacetimeDB backend procedures).
- **Storage**: Supabase Storage REST API (used to store PNG files to avoid storing large binary data in SpacetimeDB tables).
- **Dev Servers**:
  - SpacetimeDB Local Server: `http://127.0.0.1:3000`
  - Next.js Dev Server: `http://localhost:3000` (runs on default Node port)

---

## Database Architecture (`spacetimedb/src/index.ts`)

Data is modeled to match SpacetimeDB's access pattern boundaries. Private tables store internal game states, while public tables are replicated to client caches.

### Public Tables (Replicated to Clients)
1. **`room`**: Stores the game lobby state (status, current round, total rounds, host identity, etc.).
2. **`player`**: Stores player registry, connection status, scores, colors, and sabotage tokens.
3. **`round`**: Tracks current prompt word, status, starts, and ends timestamps (microseconds).
4. **`drawing`**: Stores drawings, image links, Gemini accuracy scores, AI visual guesses, and AI roasts.
5. **`sabotage`**: Stores active sabotage cards used to disrupt drawing canvases.

### Private Tables (Backend Only)
1. **`config`**: Secure table storing the Gemini API key.
2. **`word_bank`**: Stores dictionary words for drawing prompts.
3. **`round_timer`**: Scheduled table that automatically ends drawing rounds when the 30s timer expires.
4. **`reveal_timer`**: Scheduled table that transitions the room to the reveal phase after judging resolves.

---

## Client-Side Bindings & Mappings

Client bindings are generated using `/Users/sanju/.spacetimedb/bin/2.4.1/spacetimedb-cli generate --lang typescript`.
- **camelCase Properties**: The bindings map database snake_case fields to JavaScript camelCase properties (e.g. `room_id` becomes `roomId`, `avatar_color` becomes `avatarColor`).
- **Procedure Accessors**: Backend procedures are accessed via `conn.procedures.scoreDrawing` and `conn.procedures.roastInProgress`.

---

## Setup & Local Testing Guide

### 1. Start SpacetimeDB Server
```bash
/Users/sanju/.spacetimedb/bin/2.4.1/spacetimedb-cli start
```

### 2. Configure Gemini API Key
Insert the API key into the secure `config` table:
```bash
/Users/sanju/.spacetimedb/bin/2.4.1/spacetimedb-cli call <db-name> set_config '"<GEMINI_API_KEY>"'
```

### 3. Deploy/Publish Module
```bash
# Compile backend logic
/Users/sanju/.spacetimedb/bin/2.4.1/spacetimedb-cli build --module-path spacetimedb

# Publish to local instance (use --yes to force schema override and clear tables)
/Users/sanju/.spacetimedb/bin/2.4.1/spacetimedb-cli publish doodle-dash --delete-data always --yes
```

### 4. Run Frontend Client
Ensure environment variables in `.env.local` are set:
- `NEXT_PUBLIC_SPACETIMEDB_HOST=ws://127.0.0.1:3000`
- `NEXT_PUBLIC_SPACETIMEDB_DB_NAME=doodle-dash`
- `NEXT_PUBLIC_SUPABASE_URL` (optional: falls back to data URLs)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (optional)

Run development server:
```bash
npm run dev
```
Navigate to `http://localhost:3000` to play.
