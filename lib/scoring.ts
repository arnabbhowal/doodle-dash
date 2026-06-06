// Pure decision helpers for the host-driven scoring loop. Deliberately free of
// React and the SpacetimeDB SDK so the tricky termination logic can be unit-tested
// in isolation (see lib/scoring.test.ts).
//
// Context: the host scores every drawing for a round (Gemini, with a speed-only
// fallback) and records each via the `record_score_for` reducer. The SERVER reveals
// once all drawings are scored — the host never reveals. These helpers answer two
// questions the loop asks on every iteration against LIVE table data:
//   1. what still needs scoring (and hasn't already been dispatched)?
//   2. is the whole round scored, so the loop can stop?

export interface ScorableDrawing {
  drawingId: bigint;
  roundId: bigint;
  playerId: bigint;
  submitted: boolean;
  scored: boolean;
  aiScore: number;
}

/**
 * A submitted drawing still needs a real AI score until it is both `scored` and has
 * a non-negative `aiScore`. Non-submitter placeholders (scored=true, aiScore=0) and
 * already-scored drawings return false.
 */
export function needsScoring(d: ScorableDrawing): boolean {
  return d.submitted && (!d.scored || d.aiScore < 0);
}

/**
 * Drawings for `roundKey` that still need scoring and haven't been handed to the
 * scorer yet. `dispatched` holds the stringified drawingIds already in flight, so a
 * re-render mid-scoring never double-calls Gemini for the same drawing.
 */
export function selectPending<T extends ScorableDrawing>(
  drawings: readonly T[],
  roundKey: string,
  dispatched: Set<string>,
): T[] {
  return drawings.filter(
    d =>
      d.roundId.toString() === roundKey &&
      needsScoring(d) &&
      !dispatched.has(d.drawingId.toString()),
  );
}

/**
 * Is every drawing for this round present and scored? Requires at least one drawing
 * row to exist — this is the guard that prevents a premature "done" (and the
 * premature reveal it used to cause) when the host mounted before its `drawing`
 * subscription had replicated and the snapshot is momentarily empty.
 */
export function roundFullyScored(drawings: readonly ScorableDrawing[], roundKey: string): boolean {
  const roundDrawings = drawings.filter(d => d.roundId.toString() === roundKey);
  if (roundDrawings.length === 0) return false;
  // Literal "every drawing has a real score". NOTE: this must be true scored-ness,
  // not !needsScoring — a PENDING non-submitter placeholder (submitted=false,
  // scored=false; created by end_round to leave a grace window for an in-flight
  // auto-submit) is not "needsScoring" yet keeps the round open so the host loop
  // stays alive to AI-score the drawing if it lands. The grace backstop finalizes it
  // otherwise. (Server reveal uses the same scored && aiScore>=0 condition.)
  return roundDrawings.every(d => d.scored && d.aiScore >= 0);
}
