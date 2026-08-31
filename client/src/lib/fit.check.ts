// Self-check for the terminal fit math. Run: node src/lib/fit.check.ts
// (Node strips the types; no build step, no test framework.)
import assert from "node:assert/strict";

import { cellRatio, fitFontSize, FIT_MAX_FONT, FIT_MIN_FONT } from "./fit.ts";

// Measured from real xterm 6 + JetBrains Mono at lineHeight 1.2: a 120x30 grid
// renders 858x540 at font size 13.
const r = cellRatio(858, 540, 120, 30, 13);
assert.ok(r, "ratio measurable");
assert.ok(Math.abs(r.w - 0.55) < 0.01, `cell width ratio ${r.w}`);
assert.ok(Math.abs(r.h - 1.3846) < 0.01, `cell height ratio ${r.h}`);

// Unmeasurable input (a pane that has not been laid out) must not be trusted.
assert.equal(cellRatio(0, 0, 120, 30, 13), null);
assert.equal(cellRatio(858, 540, 0, 30, 13), null);

// The bug this whole module exists to kill: fitting must be IDEMPOTENT. Deriving
// the size from the terminal's current pixel size flip-flopped 12 <-> 13 forever.
const desktop = fitFontSize(r, 120, 30, 900, 520);
assert.equal(desktop, 12, `desktop fit ${desktop}`);
assert.equal(fitFontSize(r, 120, 30, 900, 520), desktop, "fit is stable on repeat");

// Every row and column stays on screen at the chosen size.
assert.ok(120 * r.w * desktop <= 900, "columns fit");
assert.ok(30 * r.h * desktop <= 520, "rows fit");

// A big pane GROWS the text (the old CSS scale was clamped to shrink-only, so a
// small host stayed a small island in the middle of a large window).
assert.ok(fitFontSize(r, 80, 24, 1600, 900) > 13, "grows to fill a large pane");

// A phone falls back to the readable floor rather than shrinking to nothing; the
// pane scrolls from there.
assert.equal(fitFontSize(r, 200, 50, 378, 600), FIT_MIN_FONT, "clamps to the floor");
assert.equal(fitFontSize(r, 4, 2, 40000, 40000), FIT_MAX_FONT, "clamps to the ceiling");

// Degenerate boxes (a hidden pane) return the floor, never NaN or Infinity.
for (const [w, h] of [
  [0, 0],
  [900, 0],
  [Number.NaN, 520],
]) {
  const v = fitFontSize(r, 120, 30, w, h);
  assert.ok(Number.isInteger(v) && v >= FIT_MIN_FONT, `degenerate box ${w}x${h} -> ${v}`);
}

console.log("fit.check: ok");
