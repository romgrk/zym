/*
 * Stub managers for the vim layer.
 *
 * vim-mode-plus's VimState lazily instantiates ~15 managers; many are cosmetic
 * (cursor styling, hover overlays, flash) or belong to features not yet ported.
 * These no-op stands-in satisfy the `load()` contract so the mode/operation core
 * runs. They are replaced by real implementations as each feature lands
 * (FlashManager and the visual-mode parts of CursorStyleManager are real now).
 */
import type VimState from './vim-state.js';
import { DecorationController } from '../DecorationController.ts';

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
  private readonly decorations: DecorationController;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(vimState: VimState) {
    this.decorations = new DecorationController(vimState.editor);
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
 * Tracks "occurrence" markers (the `o`/`O` occurrence operator-modifier). Every
 * operator queries `hasMarkers()` on init, so this reports none until the
 * occurrence feature is ported. The other methods are only reached once
 * occurrence is active, so they stay inert.
 */
export class OccurrenceManager {
  constructor(_vimState: VimState) {}
  hasMarkers(): boolean {
    return false;
  }
  getMarkerAtPoint(_point: unknown): null {
    return null;
  }
  buildPattern(): null {
    return null;
  }
  select(_wise?: unknown): boolean {
    return false;
  }
  addPattern(_pattern?: unknown, _options?: unknown): void {}
  resetPatterns(): void {}
  destroyMarkers(_markers?: unknown): void {}
  saveLastPattern(_type?: unknown): void {}
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
  private pasteCheckpoint?: number;

  constructor(vimState: VimState) {
    this.vimState = vimState;
    vimState.onDidDestroy(() => this.destroy());
  }

  destroy(): void {
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

    if (sequentialPaste) {
      // Fold the replacement into the first paste's undo step.
      this.vimState.onDidFinishOperation(() => this.vimState.editor.groupChangesSinceCheckpoint(this.pasteCheckpoint!));
    } else {
      this.pastedRangeBySelection.clear();
      const pasteCheckpoint = this.vimState.editor.createCheckpoint();
      this.vimState.onDidFinishOperation(() => (this.pasteCheckpoint = pasteCheckpoint));
    }
    return sequentialPaste;
  }
}
