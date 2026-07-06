/*
 * GlobalJumpList — the workspace-wide jump trail behind `workspace:jump-backward`
 * / `workspace:jump-forward` (ctrl-o / ctrl-i in vim normal mode; each editor's
 * own list — vim/position-history.ts — keeps its commands but no default keys).
 *
 * One time-ordered ring across every editor. Rather than trust any one command to
 * announce a jump (search `*`/`n`, in-file `g d`, and other direct cursor moves
 * bypass the vim jump list, so ctrl-o used to skip straight past them to the last
 * cross-editor hop), it watches the caret at the source: any far same-file move of
 * the *focused* editor (≥ JUMP_MIN_LINES rows, matching vim's jumpListMinLines) is
 * a jump and records where the caret left. Vim's own jump recordings still feed in
 * (they add precise sub-threshold jumps like `}`/`%`; duplicates collapse), and the
 * position left behind on every active-editor change (tab switch, cross-file open)
 * is recorded too — so walking backward re-traces navigation across tabs the way
 * vim's jump list crosses buffers. Entries are plain (path, point) pairs — not
 * marker-backed like the per-editor lists — so a position can drift when lines are
 * inserted above it; vim accepts the same drift for unloaded buffers.
 */
import { Point } from '../text/Point.ts';
import { CompositeDisposable, Disposable, type DisposableLike } from '../util/eventKit.ts';
import { zym } from '../zym.ts';
import type { OpenFileOptions } from '../Workspace.ts';

const MAX_ENTRIES = 100;

// The jump-distance threshold is the shared `vim-mode-plus.jumpListMinLines` config
// key (registered by the vim layer's settings.ts): a same-file caret move of at
// least this many rows, in one step, counts as a jump; smaller moves are
// incremental navigation. `0` disables distance recording, exactly as in the vim
// layer (`motion.ts` `moveWithSaveJump`). This fallback only covers the window
// before that key is registered on import.
const MIN_LINES_KEY = 'vim-mode-plus.jumpListMinLines';
const DEFAULT_MIN_LINES = 6;

/** The slice of TextEditor the jump list needs — narrow so tests can stub it. */
export interface JumpEditor {
  readonly currentFile: string | null;
  getCursorBufferPosition(): Point;
  onDidRecordJump(fn: (point: Point) => void): DisposableLike;
  onDidChangeCursorPosition(fn: () => void): DisposableLike;
}

/** The workspace surface the list runs against — `zym.workspace` in the app. */
export interface GlobalJumpListDeps {
  observeTextEditors(callback: (editor: JumpEditor) => DisposableLike | void): DisposableLike;
  onDidChangeActiveTextEditor(callback: (editor: JumpEditor | null) => void): DisposableLike;
  getActiveTextEditor(): JumpEditor | null;
  openFile(path: string, options?: OpenFileOptions): void;
}

interface Entry {
  path: string;
  point: Point;
}

export class GlobalJumpList {
  private readonly d: GlobalJumpListDeps;
  private readonly disposables = new CompositeDisposable();
  private entries: Entry[] = [];
  private index = 0; // entries.length === "at the present" (not navigating)
  // The editor whose departure the next active-editor change records; also the one
  // whose caret moves count as navigation (background edits in other splits don't).
  private lastActive: JumpEditor | null = null;
  // The caret's last-known spot — the "present" a far move departs from. Kept in
  // sync by the focused editor's caret moves and by active-editor changes.
  private current: Entry | null = null;
  // Guards against a jump's own openFile/tab-switch re-recording as a departure.
  private navigating = false;
  // Set while a jump into a not-yet-loaded file settles: its cursor restore is
  // async (`TextEditor` applies it on load, after `navigating` has closed), so the
  // caret moves that land it must be swallowed instead of read as a fresh jump.
  private pendingTarget: Entry | null = null;
  // Live copy of `vim-mode-plus.jumpListMinLines` (0 = distance recording off).
  private minLines = DEFAULT_MIN_LINES;

  constructor(deps: GlobalJumpListDeps = zym.workspace) {
    this.d = deps;
    this.disposables.add(
      zym.config.observe(MIN_LINES_KEY, (value) => {
        this.minLines = typeof value === 'number' ? value : DEFAULT_MIN_LINES;
      }),
      this.d.observeTextEditors((editor) => {
        const jumpSub = editor.onDidRecordJump((point) => this.record(editor.currentFile, point));
        const moveSub = editor.onDidChangeCursorPosition(() => this.cursorMoved(editor));
        return new Disposable(() => {
          jumpSub.dispose();
          moveSub.dispose();
          if (this.lastActive === editor) this.lastActive = null;
        });
      }),
      this.d.onDidChangeActiveTextEditor((editor) => this.activeEditorChanged(editor)),
      zym.commands.add('.AppWindow', {
        'workspace:jump-backward': { didDispatch: () => this.goBackward(), description: 'Jump back (across editors)' },
        'workspace:jump-forward': { didDispatch: () => this.goForward(), description: 'Jump forward (across editors)' },
      }),
    );
    this.lastActive = this.d.getActiveTextEditor();
    this.current = this.snapshot(this.lastActive);
  }

  dispose(): void {
    this.disposables.dispose();
    this.entries = [];
    this.lastActive = null;
    this.current = null;
    this.pendingTarget = null;
  }

  private snapshot(editor: JumpEditor | null): Entry | null {
    const path = editor?.currentFile;
    if (!editor || !path) return null;
    return { path, point: Point.fromObject(editor.getCursorBufferPosition()) };
  }

  // The focused editor's caret moved. A far same-file step is a jump no command had
  // to announce (search `*`/`n`, in-file `g d`, …): record where the caret left.
  // Always advance `current` so we never depart from a stale spot.
  private cursorMoved(editor: JumpEditor): void {
    if (editor !== this.lastActive) return; // only the focused caret is navigation
    const previous = this.current;
    this.current = this.snapshot(editor);
    if (this.navigating) return;
    // A jump into a freshly-loaded file is still settling: swallow the caret moves
    // in that file until the target row lands (a move to another file means the
    // navigation is moot — drop the guard and treat this move normally).
    if (this.pendingTarget) {
      if (this.current?.path === this.pendingTarget.path) {
        if (this.current.point.row === this.pendingTarget.point.row) this.pendingTarget = null;
        return;
      }
      this.pendingTarget = null;
    }
    if (!this.current || !previous || previous.path !== this.current.path) return;
    if (this.minLines > 0 && Math.abs(this.current.point.row - previous.point.row) >= this.minLines) {
      this.record(previous.path, previous.point);
    }
  }

  // A different editor took focus: record the position left in the previous
  // one, so a plain tab switch is a re-traceable jump, then re-anchor the present
  // to the newly-focused caret. The identity check stays even though the workspace
  // dedups — `open()` re-syncs `lastActive` itself.
  private activeEditorChanged(active: JumpEditor | null): void {
    if (active === this.lastActive) return;
    const previous = this.lastActive;
    this.lastActive = active;
    if (!this.navigating && previous) this.record(previous.currentFile, previous.getCursorBufferPosition());
    this.current = this.snapshot(active);
  }

  private sameSpot(entry: Entry | undefined, path: string, point: Point): boolean {
    return Boolean(entry && entry.path === path && entry.point.row === point.row);
  }

  // Same ring semantics as the per-editor list (vim/position-history.ts):
  // append as newest, drop forward history, dedup a consecutive same-line entry.
  private record(path: string | null, point: Point): void {
    if (this.navigating) return;
    if (!path) return; // scratch / diff / multibuffer tabs have no path to return to
    while (this.entries.length > this.index + 1) this.entries.pop();
    if (this.sameSpot(this.entries[this.entries.length - 1], path, point)) this.entries.pop();
    this.entries.push({ path, point: Point.fromObject(point) });
    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.index = this.entries.length;
  }

  goBackward(): void {
    if (this.index >= this.entries.length) {
      // First step from the present: stash the current position as the newest
      // entry so jump-forward can return to it.
      const active = this.d.getActiveTextEditor();
      const path = active?.currentFile;
      if (active && path) {
        const point = active.getCursorBufferPosition();
        if (!this.sameSpot(this.entries[this.entries.length - 1], path, point)) {
          this.entries.push({ path, point });
        }
      }
      this.index = this.entries.length - 1;
    }
    if (this.index <= 0) return;
    this.index -= 1;
    this.open(this.entries[this.index]);
  }

  goForward(): void {
    if (this.index >= this.entries.length - 1) return;
    this.index += 1;
    this.open(this.entries[this.index]);
  }

  private open(entry: Entry): void {
    this.pendingTarget = { path: entry.path, point: Point.fromObject(entry.point) };
    this.navigating = true;
    try {
      this.d.openFile(entry.path, { cursor: [entry.point.row, entry.point.column] });
    } finally {
      this.navigating = false;
    }
    this.lastActive = this.d.getActiveTextEditor();
    this.current = this.snapshot(this.lastActive); // the landed spot, not where we left
    // Already-loaded file: the caret restore was synchronous and is already on
    // target, so no async settle is coming — drop the guard now.
    if (this.current && this.sameSpot(this.pendingTarget ?? undefined, this.current.path, this.current.point)) {
      this.pendingTarget = null;
    }
  }
}
