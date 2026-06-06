# 07 — UI Reskin (neo-brutalist arcade)

A **presentation-only** reskin of the existing DoodleDash app into a chaotic, Jackbox-style neo-brutalist look. Hand this to Claude Code one file at a time.

> ## The one hard rule
> **Do not change any logic.** No edits to state management, SpacetimeDB reducer/procedure calls, subscriptions (`useTable`/`useReducer`), Supabase upload code, the canvas drawing math, timers, scoring, or data flow. This task only swaps how things *look*. If a change would touch behavior, stop and ask.

---

## What you MAY change
- Replace `<button>` / generic buttons with `<BrutalButton>`.
- Wrap content panels / cards / containers in `<BrutalCard>`.
- Apply typography, color, border, shadow, and spacing classes to existing elements.
- Restyle text inputs, headings, labels, badges, lists, the leaderboard, score displays.
- Add `motion/react` entrance/score animations **around** existing elements (without changing what data they render or when).

## What you MUST NOT change
- Any `useTable`, `useReducer`, procedure call, or connection code.
- Props that carry data, event handlers, `onClick`/`onChange` logic, or the values passed to reducers/procedures.
- The `<canvas>` element's drawing logic, sizing math, pointer-event handlers, or `touch-action`.
- The **sabotage effect** CSS that's applied to the victim's canvas wrapper (`invert`, `spin`, etc.) — see "Canvas & sabotage caveat" below. Do not add competing `transform`/`filter`/`box-shadow` to that same element.
- File structure of backend/module code (`spacetimedb/`).

---

## Setup

### Dependencies
```
npm i motion clsx tailwind-merge
```
(`motion/react` is the current framer-motion package import path.)

### Fonts + global CSS
Add to the global stylesheet (e.g. `app/globals.css`):
```css
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');

:root {
  --font-sans: 'Inter', sans-serif;
  --font-display: 'Fredoka', 'Poppins', sans-serif;

  --canvas: #0E0E16;   /* page background */
  --surface: #1A1A28;  /* raised cards */

  --magenta: #FF2E88;  /* primary CTA */
  --yellow:  #FFD60A;  /* points / winner */
  --green:   #00E08A;  /* AI recognized it / success */
  --cyan:    #19D3FF;  /* secondary / info */
  --red:     #FF4D4D;  /* sabotage / danger */
}

body {
  background-color: var(--canvas);
  color: #ffffff;
  font-family: var(--font-sans);
}
```

### Tailwind config
- **Tailwind v3:** add the colors + `fontFamily` (`display`, `sans`) to `tailwind.config.js` `theme.extend`.
- **Tailwind v4:** wrap the tokens in an `@theme inline { ... }` block in the CSS instead.

---

## Core primitives (add to the codebase, e.g. `app/components/`)

### `BrutalButton.tsx`
```tsx
import { ReactNode } from 'react';
import { motion, HTMLMotionProps } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type BrutalButtonProps = HTMLMotionProps<"button"> & {
  color?: 'magenta' | 'yellow' | 'green' | 'cyan' | 'red' | 'surface';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: ReactNode;
};

const shadowColors = {
  magenta: '#8A0041',
  yellow: '#997B00',
  green: '#00663E',
  cyan: '#007594',
  red: '#8A0000',
  surface: '#000000'
};

export function BrutalButton({ className, color = 'magenta', size = 'md', children, ...props }: BrutalButtonProps) {
  const sizeClasses = {
    sm: 'px-4 py-2 text-sm border-2 rounded-xl shadow-[2px_2px_0px_0px]',
    md: 'px-6 py-3 text-lg border-[3px] rounded-2xl shadow-[4px_4px_0px_0px]',
    lg: 'px-8 py-4 text-2xl border-4 rounded-[20px] shadow-[6px_6px_0px_0px]',
    xl: 'px-12 py-6 text-4xl border-4 rounded-[24px] shadow-[8px_8px_0px_0px]'
  };

  const baseShadow = {
    sm: '2px 2px 0px 0px',
    md: '4px 4px 0px 0px',
    lg: '6px 6px 0px 0px',
    xl: '8px 8px 0px 0px'
  }[size];

  const shColor = shadowColors[color];

  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{
        scale: 0.98,
        x: parseInt(baseShadow),
        y: parseInt(baseShadow),
        boxShadow: `0px 0px 0px 0px ${shColor}`
      }}
      initial={{ boxShadow: `${baseShadow} ${shColor}` }}
      style={{ boxShadow: `${baseShadow} ${shColor}` }}
      className={cn(
        'font-display font-bold uppercase tracking-wide transition-colors active:shadow-none',
        {
          'bg-[var(--magenta)] border-[#8A0041] text-white': color === 'magenta',
          'bg-[var(--yellow)] border-[#997B00] text-[#0E0E16]': color === 'yellow',
          'bg-[var(--green)] border-[#00663E] text-[#0E0E16]': color === 'green',
          'bg-[var(--cyan)] border-[#007594] text-[#0E0E16]': color === 'cyan',
          'bg-[var(--red)] border-[#8A0000] text-white': color === 'red',
          'bg-[var(--surface)] border-black text-white': color === 'surface',
        },
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </motion.button>
  );
}
```

### `BrutalCard.tsx`
```tsx
import { ReactNode } from 'react';
import { motion, HTMLMotionProps } from 'motion/react';
import { cn } from './BrutalButton'; // update path as needed

type BrutalCardProps = HTMLMotionProps<"div"> & {
  color?: 'surface' | 'magenta' | 'yellow' | 'green' | 'cyan' | 'red';
  shadowColor?: string;
  children: ReactNode;
};

export function BrutalCard({ className, color = 'surface', shadowColor = '#000000', children, ...props }: BrutalCardProps) {
  return (
    <motion.div
      className={cn(
        'border-4 rounded-[24px] p-6',
        {
          'bg-[var(--surface)] border-black': color === 'surface',
          'bg-[var(--magenta)] border-[#8A0041]': color === 'magenta',
          'bg-[var(--yellow)] border-[#997B00]': color === 'yellow',
          'bg-[var(--green)] border-[#00663E]': color === 'green',
          'bg-[var(--cyan)] border-[#007594]': color === 'cyan',
          'bg-[var(--red)] border-[#8A0000]': color === 'red',
        },
        className
      )}
      style={{ boxShadow: `8px 8px 0px 0px ${shadowColor}` }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
```

---

## Refactor rules (apply to every component)
1. **Buttons:** swap for `<BrutalButton color="..." size="...">`. Keep the existing `onClick` and `disabled` props **exactly**. Pick color by meaning (table below). Size by importance (`xl`/`lg` on host, `md`/`sm` on phone controls).
2. **Cards / panels / containers:** wrap in `<BrutalCard>`. Keep children + data untouched.
3. **Headings (h1/h2/h3):** add `font-display font-black uppercase tracking-widest`. Host headings huge (e.g. `text-6xl`+); phone headings `text-2xl`–`text-3xl`.
4. **Text inputs (nickname, room code, custom words):**
   ```
   border-4 border-black bg-[var(--surface)] p-4 text-2xl font-display
   shadow-[4px_4px_0_0_#000] focus:outline-none focus:border-[var(--magenta)]
   ```
   Keep the `value`/`onChange` wiring identical.
5. **Depth hierarchy:** more important = bigger shadow + brighter color. Primary CTA (magenta) gets the loudest treatment; secondary actions use `surface` or `cyan`.
6. **2–3 colors per screen max.** Don't rainbow. Let color carry meaning.

## Color semantics (use consistently)
| Color | Meaning in DoodleDash |
|---|---|
| **magenta** | primary CTA (Start Game, Submit, Join) |
| **yellow** | points, scores, the winner, leaderboard highlights |
| **green** | AI recognized it / high score / success states |
| **cyan** | secondary actions, info, links, "waiting" states |
| **red** | sabotage buttons, danger, kick, "Time's up!" |
| **surface** | neutral cards, lists, non-CTA panels |

---

## Per-screen reskin guide (maps to the routes in `04-frontend-spec.md`)

### Landing `/`
- `<BrutalCard>` centered. Big `font-display` title. **Create Room** = `<BrutalButton color="magenta" size="xl">`, **Join** = `<BrutalButton color="cyan" size="lg">`. Keep their navigation/handlers as-is.

### Join `/join/[code]`
- Card with the nickname input (styled input rules above). Color swatches become chunky bordered chips with hard shadows; selected = thicker border + slight `scale`. **Join** = magenta `BrutalButton`. Don't change the color-select state logic.

### Host lobby `/host/[code]`
- QR code inside a white-bordered `BrutalCard` so it scans well. Room code in **giant** yellow `font-display`. Player chips pop in as colored `BrutalCard`s (use each player's `avatar_color` as the card color) via a `motion` entrance. **Start Game** = magenta `xl` (keep the `disabled < 2` logic). **Kick** = small red `BrutalButton`.

### Host in-round
- Word in huge `font-display uppercase`. Countdown as a big number; have it shift to **red** in the final 5s (presentation only — read the same value the logic already computes). Submitted/drawing grid = `BrutalCard` chips; flip a chip to **green** with a checkmark when that player's `drawing.submitted` is true.

### Host scoring
- "The AI is judging…" in a cyan card with a bouncy motion loader. No logic change to how it detects completion.

### Host reveal
- Top drawings in framed `BrutalCard`s, scores in yellow, the AI guess as a cyan speech-bubble card. Leaderboard slams in (`motion` spring). Scores can **count up** visually — animate the display only, not the stored value. **Next Round** = magenta `xl` (host handler untouched).

### Host finished + Hall of Shame
- Winner: oversized yellow celebration card, confetti energy. Hall of Shame: the 3 worst in red-bordered "gallery frame" `BrutalCard`s, the roast as a punchy caption. Pull the same `image_url`/`ai_guess`/`ai_roast` the logic already provides.

### Player `/play/[code]`
- **Lobby:** waiting card (cyan), player list with scores in yellow.
- **Drawing:** word + countdown at top in `font-display`. Color palette = bordered swatch buttons; brush sizes = small `BrutalButton`s; **Clear** = surface, **Submit** = magenta. **Do not restyle the `<canvas>` element itself** (see caveat). The mid-round roast strip = small cyan card at the bottom.
- After submit: **Sabotage** = red `BrutalButton`; victim/effect pickers as red-accented chips ("mischievous and dangerous"). Keep `use_sabotage` wiring intact.
- **Reveal/finished:** your score in yellow, AI guess in cyan, rank prominent.

## Motion
- Use `motion/react` springs: cards pop in, leaderboard slams, winner bounces. Keep it snappy. Wrap presentational containers only — never put a remounting `motion` wrapper directly on the `<canvas>` (it can clear the drawing).

## Tone of in-UI copy (optional, if you touch copy)
Cheeky game-show-host energy: "Time's up!", "The AI is confused", "Nice try". Short, funny, never mean. Don't change copy that's data (player names, the word, AI output).

---

## Canvas & sabotage caveat (read before touching `/play`)
The drawing surface and the sabotage effects are behavior, not decoration:
- The `<canvas>` keeps its existing size math, pointer-event handlers, and `touch-action: none`. Style the **chrome around it** (frame, toolbar, container `BrutalCard`), not the canvas element's transforms/filters.
- Sabotage effects (`invert`, `spin`, `giant_brush`, `invisible_ink`, `fake_popup`) apply `filter`/`transform`/state to the canvas or its wrapper. **Do not add your own `transform`, `filter`, or `box-shadow` to that exact wrapper** — it will fight the sabotage CSS. If you need a brutalist frame there, wrap it in an *outer* element and leave the sabotage-target element alone.
- The `fake_popup` overlay should still look like a fake OS/error dialog (slightly off, jarring) — you may give it brutalist styling, but keep its dismiss handler exactly as-is.

---

## Verification gate
- [ ] App still compiles; no changed imports beyond UI/`motion`.
- [ ] Every reducer/procedure/subscription call is byte-for-byte unchanged.
- [ ] A full round still works: draw → submit → score → reveal.
- [ ] Drawing still works on a phone (pointer events intact); the canvas isn't visually broken.
- [ ] All five sabotage effects still render correctly on the victim (not overridden by reskin styles).
- [ ] Buttons depress (shadow shrink + shift) on tap; cards have hard offset shadows; headings are uppercase `font-display`.
- [ ] No more than ~3 colors per screen; color meanings match the table.
- [ ] Host screen type is legible from across a room.
```
