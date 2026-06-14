/*
 * Shared GtkTextIter helpers for the editor model.
 *
 * `GtkTextBuffer`'s iter getters are inconsistent: some return a bare iter
 * (`getIterAtMark`, `getIterAtOffset`, `getStartIter`/`getEndIter`) while others
 * carry a "did it land in range" gboolean and come back as `[ok, iter]`
 * (`getIterAtLine`, `getIterAtLineOffset`). `unwrapIter` normalizes both shapes
 * so callers never have to remember which is which.
 */
import { Gtk } from '../../gi.ts';

export type TextIter = InstanceType<typeof Gtk.TextIter>;
export type TextMark = InstanceType<typeof Gtk.TextMark>;

/** Normalize the bare-iter and `[ok, iter]` return shapes to a bare iter. */
export function unwrapIter(result: TextIter | [boolean, TextIter]): TextIter {
  return Array.isArray(result) ? result[1] : result;
}

/** Constrain `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
