/*
 * Completion source contract — the seam the autocompletion framework is built
 * around. The `CompletionController` coordinates one or more sources (a buffer-
 * words source, an LSP source, a Copilot source, …); each implements
 * `CompletionSource` and is fed a `CompletionContext` (the prefix being typed,
 * the cursor, and the range an accepted item replaces). Sources are sync or
 * async — LSP/Copilot return promises.
 */
import type { Point } from '../../text/Point.ts';
import type { Range } from '../../text/Range.ts';

/** A single completion candidate. Mirrors the useful subset of an LSP item. */
export interface CompletionItem {
  /** Shown in the list and, by default, matched against the prefix + inserted. */
  label: string;
  /** Text inserted on accept (defaults to `label`). */
  insertText?: string;
  /** Text matched against the typed prefix (defaults to `label`). */
  filterText?: string;
  /** A short kind tag — `function`, `variable`, `keyword`, … — drives the icon. */
  kind?: string;
  /** Right-aligned detail (a type signature, the source name, …). */
  detail?: string;
  /**
   * Longer documentation for the item (LSP `documentation`, a signature + doc
   * comment, …). Shown in the popup's side panel when the item is selected.
   */
  documentation?: string;
  /** Ordering hint within a source (compared as a string; falls back to `label`). */
  sortText?: string;
}

export type CompletionTrigger = 'auto' | 'manual' | 'character';

/** Everything a source needs to produce candidates for the current position. */
export interface CompletionContext {
  /** The word being typed immediately before the cursor (may be empty). */
  prefix: string;
  /** The cursor position. */
  cursor: Point;
  /** The buffer range an accepted item replaces (covers `prefix`). */
  replaceRange: Range;
  /** The full text of the cursor's line. */
  line: string;
  /** What caused the request. */
  trigger: CompletionTrigger;
  /** The trigger character, when `trigger === 'character'`. */
  triggerCharacter?: string;
}

/** A provider of completion candidates (buffer words, LSP, Copilot, …). */
export interface CompletionSource {
  readonly name: string;
  /**
   * Characters that auto-open completion for this source beyond plain word typing
   * (e.g. `.` / `::` for LSP). Optional.
   */
  readonly triggerCharacters?: readonly string[];
  /**
   * Produce candidates for `context`. May be sync or async; thrown errors and
   * rejections are swallowed by the controller (one bad source won't break the rest).
   */
  complete(context: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}
