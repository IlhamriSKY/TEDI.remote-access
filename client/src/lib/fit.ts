// Fitting a MIRRORED terminal into the browser pane.
//
// The host owns cols/rows and must never be resized from here (the agent and the
// SSH bridge drop browser resize frames outright, see check-no-host-resize.mjs),
// so the only thing this client may change is how big those fixed cells are
// DRAWN.
//
// This replaces a CSS `transform: scale()` on the rendered terminal, which
// resampled already-rasterised glyphs (fuzzy text, and the cursor drew in the
// wrong place), only ever shrank -- so a small host stayed a small island of text
// in a big empty pane -- and centred the result, so the leftover space read as a
// letterbox band. Measured on a 120x30 host in a 378x600 phone pane it produced
// 5.7px glyphs. Choosing a real font size re-renders crisply at any size and
// lets the grid fill the pane.

/** Below this, text stops being readable; the pane pans instead of shrinking further. */
export const FIT_MIN_FONT = 6;
/** Above this a mirrored grid is mostly whitespace even on a big monitor. */
export const FIT_MAX_FONT = 40;

/** Cell size in pixels per 1px of font size, for one font face + line spacing. */
export type CellRatio = { w: number; h: number };

/**
 * Cell ratio of a rendered terminal: `natW`x`natH` is its pixel size with
 * `cols`x`rows` cells at font size `atFont`. Null when anything is unmeasurable
 * (a pane that has not been laid out reports 0), so the caller keeps looking.
 */
export function cellRatio(
  natW: number,
  natH: number,
  cols: number,
  rows: number,
  atFont: number,
): CellRatio | null {
  if (!(natW > 1 && natH > 1 && cols > 0 && rows > 0 && atFont > 0)) return null;
  return { w: natW / (cols * atFont), h: natH / (rows * atFont) };
}

/**
 * ESTIMATE of the largest whole font size at which `cols`x`rows` cells still fit
 * `boxW`x`boxH`. The caller must verify it against a real render and step from
 * there: xterm derives its cell box from measured glyph metrics rounded to whole
 * pixels, so the size is only piecewise-linear in the ratio, and a ratio sampled
 * before the web font finished loading describes the fallback face rather than
 * the real one. Getting this wrong is not cosmetic -- an over-estimate pushes the
 * bottom rows, where the prompt lives, out of the pane.
 *
 * `min` of both axes keeps every row AND column on screen. The floor keeps it a
 * whole pixel (fractional sizes give fuzzy cell metrics) and biases the estimate
 * low, so the verify step usually only has to grow. Clamped to the readable
 * range; when the floor bites (a 200-column host on a phone) the pane scrolls.
 */
export function fitFontSize(
  r: CellRatio,
  cols: number,
  rows: number,
  boxW: number,
  boxH: number,
  min: number = FIT_MIN_FONT,
  max: number = FIT_MAX_FONT,
): number {
  if (!(r.w > 0 && r.h > 0 && cols > 0 && rows > 0 && boxW > 1 && boxH > 1)) return min;
  const byWidth = boxW / (cols * r.w);
  const byHeight = boxH / (rows * r.h);
  return Math.max(min, Math.min(max, Math.floor(Math.min(byWidth, byHeight))));
}
