/*
 * Stub managers for the vim layer.
 *
 * vim-mode-plus's VimState lazily instantiates ~15 managers; many are cosmetic
 * (cursor styling, hover overlays, flash) or belong to features not yet ported.
 * These no-op stands-in satisfy the `load()` contract so the mode/operation core
 * runs. They are replaced by real implementations as each feature lands
 * (FlashManager and the visual-mode parts of CursorStyleManager are real now).
 */
import type VimState from './vim-state.ts';
import { TextDecorations } from '../TextDecorations.ts';
import { Range } from '../../../text/Range.ts';
import { Point } from '../../../text/Point.ts';
import type { Marker } from '../Marker.ts';
import type { MarkerLayer } from '../MarkerLayer.ts';
import type { Selection } from '../Selection.ts';
import { Emitter } from '../../../util/eventKit.ts';
// Vendored utils are untyped JS; import the two helpers the occurrence port needs.
import { collectRangeByScan, shrinkRangeEndToBeforeNewLine } from './utils.ts';

/**
 * Renders cursor decorations by mode in Atom; here the cursor is the native
 * GtkSourceView cursor. We reuse its `refresh()` (called at the end of every
 * operation) as the reliable point to keep the cursor scrolled on screen, since
 * the vim layer moves the cursor with programmatic mark moves that don't
 * auto-scroll.
 */
export class CursorStyleManager {
  private readonly vimState: VimState;
  constructor(vimState: VimState) {
    this.vimState = vimState;
  }
  refresh(): void {
    const { editor } = this.vimState;
    // In visual mode the block caret belongs on the selection's logical head
    // (which `saveProperties` keeps on the line), not the insert mark — for a
    // linewise selection the insert mark sits at the next line's start.
    if (this.vimState.mode === 'visual') {
      const head = this.vimState
        .swrap(editor.getLastSelection())
        .getBufferPositionFor('head', { from: ['property', 'selection'] });
      editor.setCursorDisplayPoint(head ?? null);
    } else {
      editor.setCursorDisplayPoint(null);
    }
    editor.refreshCursorStyle();
    // Repaint the visual-block member rows (secondary selections). Cheap and
    // idempotent; clears when there are none (left blockwise / other modes).
    editor.renderExtraSelections();
    editor.scrollCursorOnscreen();
  }
}

/** A transient overlay near the cursor (count/input echo). Not yet implemented. */
export class HoverManager {
  constructor(_vimState: VimState) {}
  set(_value?: unknown): void {}
  reset(): void {}
  clearAllMarkers(): void {}
}

/** Drives the mode/count display in the status bar; wired to the window later. */
export class StatusBarManager {
  update(_mode: string, _submode: string | null): void {}
}

/**
 * Briefly highlights operated/yanked ranges (vim-mode-plus's `flashOnOperate`/
 * `flashOnUndoRedo`). Ranges are painted on a dedicated decoration layer and
 * cleared after a per-type duration; a new flash supersedes the pending one.
 */
const FLASH_DURATION: Record<string, number> = {
  operator: 200,
  'operator-long': 700,
  'operator-occurrence': 200,
  'operator-remove-occurrence': 200,
  'undo-redo': 300,
  'undo-redo-multiple-changes': 300,
};
const DEFAULT_FLASH_DURATION = 250;

export class FlashManager {
  private readonly decorations: TextDecorations;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(vimState: VimState) {
    this.decorations = new TextDecorations(vimState.editor);
    vimState.onDidDestroy(() => this.destroy());
  }

  flash(ranges: unknown, options: { type?: string } = {}): void {
    const list = (Array.isArray(ranges) ? ranges : [ranges]).filter(
      (r): r is { isEmpty?: () => boolean } => Boolean(r) && !(r as { isEmpty?: () => boolean }).isEmpty?.(),
    );
    if (!list.length) return;

    const duration = FLASH_DURATION[options.type ?? ''] ?? DEFAULT_FLASH_DURATION;
    if (duration <= 0) return;

    this.clearAllMarkers();
    const layer = this.decorations.layer('vim-flash');
    for (const range of list) layer.decorate(range as never, 'flash');
    this.timer = setTimeout(() => this.clearAllMarkers(), duration);
  }

  clearAllMarkers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.decorations.layer('vim-flash').clear();
  }

  destroy(): void {
    this.clearAllMarkers();
  }
}

/**
 * Scrolls the view for ctrl-d/u/f/b and zz/zt/zb. vim-mode-plus's smooth-scroll
 * animation is dropped (smooth-scroll config is off): scrolls land immediately
 * via the view's vertical adjustment.
 */
export class ScrollManager {
  private readonly vimState: VimState;
  constructor(vimState: VimState) {
    this.vimState = vimState;
    vimState.onDidDestroy(() => this.destroy());
  }
  destroy(): void {}
  requestScroll(options: { amountOfPixels?: number; scrollTop?: number; onFinish?: () => void } = {}): void {
    const { editor } = this.vimState;
    let scrollTop = options.scrollTop;
    if (options.amountOfPixels != null) scrollTop = editor.getScrollTop() + options.amountOfPixels;
    if (scrollTop != null) editor.setScrollTop(scrollTop);
    options.onFinish?.();
  }
}

/**
 * Tracks "occurrence" markers — the marker layer behind vim-mode-plus's
 * occurrence operator-modifier (`c o p` = change every cursor-word in the
 * paragraph) and preset occurrence (`g o` toggles persistent markers any later
 * operator restricts itself to). Ported from vim-mode-plus's OccurrenceManager.
 *
 * Adaptations to quilx's primitives:
 *  - Atom's `decorateMarkerLayer` is replaced by a TextDecorations layer
 *    re-synced (`renderMarkers`) whenever the marker set changes — quilx markers
 *    move with edits but don't carry their own decoration.
 *  - quilx's `MarkerLayer.findMarkers` only filters by `containsBufferPosition`,
 *    so range-intersection queries iterate the markers directly.
 *  - quilx markers don't auto-invalidate on edit, so the upstream
 *    invalidated-marker sweep is dropped; markers are cleared by `resetPatterns`
 *    when an occurrence operation finishes.
 */
export class OccurrenceManager {
  private readonly vimState: VimState;
  private readonly emitter = new Emitter();
  private readonly markerLayer: MarkerLayer;
  private readonly decorations: TextDecorations;
  private patterns: RegExp[] = [];

  constructor(vimState: VimState) {
    this.vimState = vimState;
    const { editor } = vimState;
    vimState.onDidDestroy(() => this.destroy());

    this.markerLayer = editor.addMarkerLayer();
    this.decorations = new TextDecorations(editor);

    // All marker create/destroy is driven by reacting to pattern changes.
    this.onDidChangePatterns(({ pattern, occurrenceType }) => {
      if (pattern) this.markBufferRangeByPattern(pattern, occurrenceType);
      else this.clearMarkers();
      this.renderMarkers();
    });
    this.markerLayer.onDidUpdate(() => this.renderMarkers());
  }

  private markBufferRangeByPattern(regex: RegExp, occurrenceType?: string): void {
    const { editor } = this.vimState;
    let occurrenceRanges: Range[] = collectRangeByScan(editor, regex);

    if (occurrenceType === 'subword') {
      const subwordRegex = editor.getLastCursor().subwordRegExp();
      const subwordRangesByRow: Record<number, Range[]> = {};
      occurrenceRanges = occurrenceRanges.filter((range) => {
        const row = range.start.row;
        if (!subwordRangesByRow[row]) subwordRangesByRow[row] = collectRangeByScan(editor, subwordRegex, { row });
        return subwordRangesByRow[row].some((subwordRange) => subwordRange.isEqual(range));
      });
    }

    for (const range of occurrenceRanges) this.markerLayer.markBufferRange(range);
  }

  /** Repaint the occurrence highlight from the current marker ranges. */
  private renderMarkers(): void {
    const layer = this.decorations.layer('vim-occurrence');
    layer.clear();
    for (const marker of this.getMarkers()) layer.decorate(marker.getBufferRange(), 'highlight');
  }

  // Callback gets `{pattern, occurrenceType}`; `pattern` is undefined on reset.
  private onDidChangePatterns(fn: (event: { pattern?: RegExp; occurrenceType?: string }) => void) {
    return this.emitter.on('did-change-patterns', fn as (value: unknown) => void);
  }

  destroy(): void {
    this.decorations.layer('vim-occurrence').clear();
    this.markerLayer.destroy();
  }

  // --- Patterns --------------------------------------------------------------
  hasPatterns(): boolean {
    return this.patterns.length > 0;
  }

  resetPatterns(): void {
    this.patterns = [];
    this.emitter.emit('did-change-patterns', {});
  }

  addPattern(pattern: RegExp | null = null, { reset = false, occurrenceType = 'base' } = {}): void {
    if (reset) this.clearMarkers();
    if (pattern) this.patterns.push(pattern);
    this.emitter.emit('did-change-patterns', { pattern, occurrenceType });
  }

  saveLastPattern(occurrenceType?: string): void {
    this.vimState.globalState.set('lastOccurrencePattern', this.buildPattern());
    this.vimState.globalState.set('lastOccurrenceType', occurrenceType ?? null);
  }

  // Union of every added pattern, as a single global regex. Cached onto the
  // operator so `.` can repeat an occurrence operation.
  buildPattern(): RegExp {
    return new RegExp(this.patterns.map((regex) => regex.source).join('|'), 'g');
  }

  // --- Markers ---------------------------------------------------------------
  private clearMarkers(): void {
    this.markerLayer.clear();
  }

  destroyMarkers(markers: Marker[]): void {
    for (const marker of markers) marker.destroy();
  }

  hasMarkers(): boolean {
    return this.markerLayer.getMarkerCount() > 0;
  }

  getMarkers(): Marker[] {
    return this.markerLayer.getMarkers();
  }

  getMarkerBufferRanges(): Range[] {
    return this.markerLayer.getMarkers().map((marker) => marker.getBufferRange());
  }

  getMarkerCount(): number {
    return this.markerLayer.getMarkerCount();
  }

  // Occurrence markers intersecting `selection`. quilx's findMarkers can't do a
  // range query, so iterate all markers and test intersection directly.
  getMarkersIntersectsWithSelection(selection: { getBufferRange(): Range }, exclusive = false): Marker[] {
    const range = shrinkRangeEndToBeforeNewLine(selection.getBufferRange());
    return this.getMarkers().filter((marker) => range.intersectsWith(marker.getBufferRange(), exclusive));
  }

  getMarkerAtPoint(point: Point): Marker | undefined {
    // For `abc()` we mark `abc` and `(`; a cursor on `(` is contained by both,
    // so prefer the marker whose end is past the point.
    return this.markerLayer
      .findMarkers({ containsBufferPosition: point })
      .find((marker) => marker.getBufferRange().end.isGreaterThan(point));
  }

  // Select every occurrence-marker range intersecting the current selection(s),
  // re-creating selections from them, then migrate per-selection mutation state
  // onto the new selections. Returns whether anything was selected.
  select(wise?: string): boolean {
    const closestRangeIndexByOriginalSelection = new Map<Selection, number>();
    const rangesToSelect: Range[] = [];
    const markersSelected: Marker[] = [];
    const { editor } = this.vimState;

    for (const selection of editor.getSelections()) {
      const markers = this.getMarkersIntersectsWithSelection(selection, this.vimState.mode === 'visual');
      if (!markers.length) continue;

      const ranges = markers.map((marker) => marker.getBufferRange());
      markersSelected.push(...markers);
      // Move the closest occurrence to the end so it becomes the last selection
      // (where insert/autocomplete anchors after the operation).
      const closestRange = this.getClosestRangeForSelection(ranges, selection);
      ranges.splice(ranges.indexOf(closestRange), 1);
      ranges.push(closestRange);

      rangesToSelect.push(...ranges);
      closestRangeIndexByOriginalSelection.set(selection, rangesToSelect.indexOf(closestRange));
    }

    if (!rangesToSelect.length) return false;

    const reversed = editor.getLastSelection().isReversed();
    if (this.vimState.isMode('visual', 'blockwise')) {
      (this.vimState as { activate(mode: string, submode?: string): void }).activate('visual', 'characterwise');
    }

    editor.setSelectedBufferRanges(rangesToSelect, { reversed });
    const selections = editor.getSelections();
    closestRangeIndexByOriginalSelection.forEach((closestRangeIndex, originalSelection) => {
      this.vimState.mutationManager.migrateMutation(originalSelection, selections[closestRangeIndex]);
    });
    this.destroyMarkers(markersSelected);
    this.vimState.swrap.saveProperties(editor, { force: true });

    if (wise === 'linewise') {
      for (const $selection of this.vimState.swrap.getSelections(editor)) $selection.applyWise('linewise');

      // Merging adjacent linewise selections destroys some; migrate their
      // mutation onto the survivor that swallowed them. quilx selections don't
      // emit a destroy event, so snapshot ranges before the merge and detect
      // the merged-away selections by set difference afterward.
      const { mutationsBySelection } = this.vimState.mutationManager;
      const rangeByMutation = new Map<{ selection: unknown }, Range>();
      const before = [...mutationsBySelection.entries()];
      for (const [sel, mutation] of before) rangeByMutation.set(mutation, sel.getBufferRange());

      editor.mergeSelectionsOnSameRows(); // destroys merged selections
      this.vimState.swrap.saveProperties(editor, { force: true });

      const survivors = new Set(editor.getSelections());
      for (const [sel, mutation] of before) {
        if (survivors.has(sel)) continue;
        mutationsBySelection.delete(sel);
        const range = rangeByMutation.get(mutation);
        const selection = editor
          .getSelections()
          .find((s: { getBufferRange(): Range }) => range && s.getBufferRange().containsRange(range));
        mutation.selection = selection as Selection;
        if (selection) mutationsBySelection.set(selection, mutation);
      }
    }

    return true;
  }

  // Which occurrence becomes the last selection, in order of preference:
  //  1. under the original cursor  2. forward on the same row
  //  3. first on the same row      4. forward (wrapping to first)
  private getClosestRangeForSelection(ranges: Range[], selection: Selection): Range {
    const point: Point = this.vimState.mutationManager.mutationsBySelection.get(selection)!.initialPoint;

    const containing = ranges.find((range) => range.containsPoint(point));
    if (containing) return containing;

    const rangesInSameRow = ranges.filter((range) => range.start.row === point.row);
    if (rangesInSameRow.length) ranges = rangesInSameRow;
    return ranges.find((range) => range.start.isGreaterThan(point)) || ranges[0];
  }
}

/**
 * Sequential paste (vim-mode-plus's `p`-then-`p` register cycling): when a paste
 * command immediately follows the *same* paste command, the new paste replaces
 * the just-pasted text with the next entry from the yank history (a yank-pop
 * ring), grouped into the first paste's undo step. Any other command in between
 * breaks the chain and paste behaves normally. The register history is fed by
 * `RegisterManager` (gated on the `sequentialPaste` config), and the previously
 * pasted range is reselected through the `LastPastedRange` text object.
 */
// Operations are untyped JS; the manager pokes at operator fields by contract.
type PasteOperator = {
  name: string;
  repeated: boolean;
  target: unknown;
  setTarget(target: unknown): void;
  getInstance(name: string): unknown;
  onDidSetTarget(fn: (event: { target: unknown }) => void): void;
};

export class SequentialPasteManager {
  private readonly vimState: VimState;
  private readonly pastedRangeBySelection = new Map<unknown, unknown>();
  private originalTarget: unknown;
  // True while the cross-operation undo group (the initial paste + every cycle)
  // is open. See onExecute / finalizePasteGroup.
  private pasteGroupOpen = false;

  constructor(vimState: VimState) {
    this.vimState = vimState;
    vimState.onDidDestroy(() => this.destroy());
  }

  destroy(): void {
    this.finalizePasteGroup();
    this.pastedRangeBySelection.clear();
  }

  savePastedRangeForSelection(selection: unknown, range: unknown): void {
    this.pastedRangeBySelection.set(selection, range);
  }

  getPastedRangeForSelection(selection: unknown): unknown {
    return this.pastedRangeBySelection.get(selection);
  }

  private isSequentialPaste(operator: PasteOperator): boolean {
    return (
      Boolean(this.vimState.getConfig('sequentialPaste')) &&
      this.vimState.operationStack.getLastCommandName() === operator.name
    );
  }

  onInitialize(operator: PasteOperator): void {
    if (this.isSequentialPaste(operator)) {
      operator.target = 'LastPastedRange';
    } else {
      operator.onDidSetTarget(({ target }) => (this.originalTarget = target));
    }
  }

  onExecute(operator: PasteOperator): boolean {
    const sequentialPaste = this.isSequentialPaste(operator);

    // On `.` repeat, re-point the target (the original isn't re-resolved otherwise).
    if (operator.repeated) {
      operator.setTarget(sequentialPaste ? operator.getInstance('LastPastedRange') : this.originalTarget);
    }

    if (!sequentialPaste) {
      // Starting a fresh paste. Close any group left open by an earlier chain,
      // then open a new one BEFORE the edit. Each cycle is a separate operation,
      // but its `transact` nests inside this still-open GTK user action, so the
      // initial paste and every subsequent cycle coalesce into one undo step
      // (closed by finalizePasteGroupIfInterrupted on the next command).
      this.finalizePasteGroup();
      this.pastedRangeBySelection.clear();
      this.vimState.editor.beginUndoGroup();
      this.pasteGroupOpen = true;
    }
    return sequentialPaste;
  }

  /** Commit the open cycle group as a single undo step. Idempotent. */
  private finalizePasteGroup(): void {
    if (!this.pasteGroupOpen) return;
    this.pasteGroupOpen = false;
    this.vimState.editor.endUndoGroup();
  }

  /**
   * Called by the operation stack before every operation: any command that does
   * NOT continue the paste chain closes the open group, so the paste(s) so far
   * commit as one undo step ahead of (e.g.) the undo command itself. A continuing
   * paste leaves the group open for its nested `transact`.
   */
  finalizePasteGroupIfInterrupted(operation: PasteOperator): void {
    if (this.pasteGroupOpen && !this.isSequentialPaste(operation)) this.finalizePasteGroup();
  }
}
