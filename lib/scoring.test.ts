// Run with:  npx tsx lib/scoring.test.ts
// Unit tests for the host scoring-loop decision helpers. These cover the exact
// race/edge conditions that used to strand drawings at ai_score = -1.

import assert from 'node:assert/strict';
import { needsScoring, selectPending, roundFullyScored, type ScorableDrawing } from './scoring';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// Builder for a drawing row. Defaults to a submitted, not-yet-scored drawing.
let nextId = 1n;
function draw(over: Partial<ScorableDrawing> = {}): ScorableDrawing {
  return {
    drawingId: nextId++,
    roundId: 10n,
    playerId: 1n,
    submitted: true,
    scored: false,
    aiScore: -1,
    ...over,
  };
}

const KEY = '10';

console.log('needsScoring');
test('submitted + unscored needs scoring', () => {
  assert.equal(needsScoring(draw()), true);
});
test('scored real result does not need scoring', () => {
  assert.equal(needsScoring(draw({ scored: true, aiScore: 73 })), false);
});
test('non-submitter placeholder (scored, aiScore 0) does not need scoring', () => {
  assert.equal(needsScoring(draw({ submitted: true, scored: true, aiScore: 0 })), false);
});
test('scored=true but aiScore still -1 DOES need scoring (sentinel)', () => {
  assert.equal(needsScoring(draw({ scored: true, aiScore: -1 })), true);
});

console.log('selectPending');
test('returns only this round, unscored, not dispatched', () => {
  const a = draw();
  const otherRound = draw({ roundId: 99n });
  const scored = draw({ scored: true, aiScore: 50 });
  const pending = selectPending([a, otherRound, scored], KEY, new Set());
  assert.deepEqual(pending.map(d => d.drawingId), [a.drawingId]);
});
test('excludes already-dispatched drawings (no double Gemini call)', () => {
  const a = draw();
  const b = draw();
  const dispatched = new Set([a.drawingId.toString()]);
  const pending = selectPending([a, b], KEY, dispatched);
  assert.deepEqual(pending.map(d => d.drawingId), [b.drawingId]);
});
test('picks up a late arrival that was not in the earlier snapshot', () => {
  const a = draw();
  const dispatched = new Set([a.drawingId.toString()]);
  // `a` already dispatched; a late `b` submission appears → must be selected.
  const late = draw();
  const pending = selectPending([a, late], KEY, dispatched);
  assert.deepEqual(pending.map(d => d.drawingId), [late.drawingId]);
});

console.log('roundFullyScored');
test('empty snapshot is NOT fully scored (prevents premature reveal on host mount)', () => {
  assert.equal(roundFullyScored([], KEY), false);
});
test('a snapshot with no rows for THIS round is NOT fully scored', () => {
  assert.equal(roundFullyScored([draw({ roundId: 99n })], KEY), false);
});
test('one unscored drawing → not fully scored', () => {
  assert.equal(roundFullyScored([draw({ scored: true, aiScore: 40 }), draw()], KEY), false);
});
test('all scored (mix of real scores + placeholder) → fully scored', () => {
  const rows = [
    draw({ scored: true, aiScore: 80 }),
    draw({ scored: true, aiScore: 0 }), // placeholder
    draw({ scored: true, aiScore: 12 }),
  ];
  assert.equal(roundFullyScored(rows, KEY), true);
});

console.log('loop simulation (drives the helpers exactly as the host effect does)');
test('progressive scoring of 3 drawings terminates exactly once, scoring each once', () => {
  // Mutable "live table" the simulated subscription updates as records land.
  let live: ScorableDrawing[] = [draw(), draw(), draw()];
  const dispatched = new Set<string>();
  const scoreCalls: string[] = [];

  // Mimic record_score_for landing: mark a drawing scored in the live table.
  const land = (id: bigint, score: number) => {
    live = live.map(d => (d.drawingId === id ? { ...d, scored: true, aiScore: score } : d));
  };

  let iterations = 0;
  let revealedByServer = false;
  // The loop: select pending → "score" each (record immediately) → repeat until done.
  while (iterations++ < 50) {
    const pending = selectPending(live, KEY, dispatched);
    if (pending.length === 0) {
      if (roundFullyScored(live, KEY)) break; // server would have revealed by now
      // (no in-flight modelled here, so this branch shouldn't hit) — guard anyway
      throw new Error('stuck: pending empty but round not fully scored');
    }
    for (const d of pending) {
      dispatched.add(d.drawingId.toString());
      scoreCalls.push(d.drawingId.toString());
      land(d.drawingId, 60); // record_score_for persists the score
    }
    // Server reveals when the last one is recorded.
    if (roundFullyScored(live, KEY)) revealedByServer = true;
  }

  assert.equal(scoreCalls.length, 3, 'each drawing scored exactly once');
  assert.equal(new Set(scoreCalls).size, 3, 'no drawing scored twice');
  assert.equal(revealedByServer, true, 'round reaches fully-scored (server reveals)');
});

test('late submission during scoring is caught (no orphan at -1)', () => {
  let live: ScorableDrawing[] = [draw(), draw()];
  const dispatched = new Set<string>();
  const scored: string[] = [];
  const land = (id: bigint) => { live = live.map(d => (d.drawingId === id ? { ...d, scored: true, aiScore: 55 } : d)); };

  // First pass: score the two we know about.
  let pending = selectPending(live, KEY, dispatched);
  for (const d of pending) { dispatched.add(d.drawingId.toString()); scored.push(d.drawingId.toString()); land(d.drawingId); }
  assert.equal(roundFullyScored(live, KEY), true, 'looks done after first pass…');

  // …but a late auto-submit arrives (a brand-new drawing row for this round).
  const late = draw();
  live = [...live, late];
  assert.equal(roundFullyScored(live, KEY), false, 'late arrival re-opens the round');

  // The loop re-reads live data and picks it up.
  pending = selectPending(live, KEY, dispatched);
  assert.deepEqual(pending.map(d => d.drawingId), [late.drawingId]);
  for (const d of pending) { dispatched.add(d.drawingId.toString()); scored.push(d.drawingId.toString()); land(d.drawingId); }
  assert.equal(roundFullyScored(live, KEY), true, 'fully scored after catching the late one');
  assert.equal(scored.length, 3);
});

console.log(`\n${passed} checks passed.`);
