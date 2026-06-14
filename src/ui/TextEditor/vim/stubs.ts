/*
 * Stub managers for the vim layer.
 *
 * vim-mode-plus's VimState lazily instantiates ~15 managers; many are cosmetic
 * (cursor styling, hover overlays, flash) or belong to features not yet ported.
 * These no-op stands-in satisfy the `load()` contract so the mode/operation core
 * runs. They are replaced by real implementations as each feature lands.
 */
import type VimState from './vim-state.js';

/** Renders cursor decorations by mode in Atom; here the cursor is driven by EditorModel. */
export class CursorStyleManager {
  constructor(_vimState: VimState) {}
  refresh(): void {}
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
