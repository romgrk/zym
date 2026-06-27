/*
 * wordDiff — intra-line ("word-by-word") change spans for a modified line pair.
 *
 * Pairs a removed line with its added counterpart and reports the changed character
 * spans on each side, so the diff surface can paint `word-add`/`word-del` highlights
 * over the full-line background (`applyDiffDecorations`). Word-level (not char-level)
 * keeps the highlight on whole tokens — far less noisy than scattering it over single
 * characters. Whitespace is significant (`diffWordsWithSpace`), so indentation/spacing
 * changes still show. Pure + GTK-free.
 *
 * Lifted from the removed `DiffModel.ts` (the diff-view consolidation dropped it); the
 * multibuffer `DiffView` is its sole consumer now.
 */
import { diffWordsWithSpace } from 'diff';

/** A `[start, end)` column range of changed characters within a modified line. */
export type WordRange = [start: number, end: number];

/**
 * The changed character spans of `oldText` (removed) and `newText` (added) — codepoint
 * offsets, since buffer columns are codepoints — plus whether the lines share any
 * content (so a wholesale replacement can skip intra-line highlighting).
 */
export function computeIntraLineDiff(
  oldText: string,
  newText: string,
): { oldRanges: WordRange[]; newRanges: WordRange[]; hasCommon: boolean } {
  const oldRanges: WordRange[] = [];
  const newRanges: WordRange[] = [];
  let oi = 0;
  let ni = 0;
  let hasCommon = false;
  for (const part of diffWordsWithSpace(oldText, newText)) {
    const len = [...part.value].length; // codepoints (buffer columns are codepoints)
    if (part.added) {
      newRanges.push([ni, ni + len]);
      ni += len;
    } else if (part.removed) {
      oldRanges.push([oi, oi + len]);
      oi += len;
    } else {
      if (len > 0) hasCommon = true;
      oi += len;
      ni += len;
    }
  }
  return { oldRanges, newRanges, hasCommon };
}

/**
 * Tidy a line's raw intra-line change spans for display:
 *  - **Collapse** spans separated only by *noise* (whitespace and/or punctuation —
 *    anything with no word character) into one, gap included. Per-word diffing is
 *    too granular for non-word characters: a lone `(` or `` ` `` that happens to
 *    match in an otherwise-changed stretch would otherwise carve the highlight into
 *    choppy slivers. Bridging keeps the changed run whole. A gap holding a real
 *    unchanged word still splits the spans (it's a meaningful common token).
 *  - **Promote** to a full-line highlight: a single span whose line is only
 *    whitespace on either side (indentation aside, the whole line changed) returns
 *    `[]`, so the caller paints just the line background — no word span over what is
 *    essentially the entire line.
 *
 * `text` is the line the ranges index into; offsets are codepoints (buffer columns),
 * so slice on the codepoint array, not the UTF-16 string. Ranges come in ascending,
 * non-overlapping order (the forward scan in `computeIntraLineDiff`).
 */
export function refineWordRanges(text: string, ranges: readonly WordRange[]): WordRange[] {
  if (ranges.length === 0) return [];
  const cps = [...text];
  // Inclusive-empty: an empty slice (from >= to, e.g. abutting spans or a line edge) is vacuously
  // true for either predicate — what we want at line edges and between adjacent spans.
  const isBlank = (from: number, to: number) => cps.slice(from, to).every((c) => /\s/.test(c));
  // Noise = no word character (letter/digit/underscore): only whitespace and/or punctuation.
  const isNoise = (from: number, to: number) => cps.slice(from, to).every((c) => !/[\p{L}\p{N}_]/u.test(c));

  // Collapse changed spans separated only by noise into one (covering the gap).
  const merged: WordRange[] = [[ranges[0][0], ranges[0][1]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = ranges[i];
    if (isNoise(last[1], start)) last[1] = end;
    else merged.push([start, end]);
  }

  // A single span flanked only by whitespace is the whole meaningful line — let the line
  // background carry it (full-line highlight) and drop the word span.
  if (merged.length === 1 && isBlank(0, merged[0][0]) && isBlank(merged[0][1], cps.length)) return [];
  return merged;
}
