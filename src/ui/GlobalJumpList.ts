/*
 * GlobalJumpList — the workspace-wide jump trail behind `workspace:jump-backward`
 * / `workspace:jump-forward` (ctrl-o / ctrl-i in vim normal mode; each editor's
 * own list — vim/position-history.ts — keeps its commands but no default keys).
 *
 * One time-ordered ring across every editor: it interleaves each editor's vim
 * jump recordings (flagged jump motions + `jumpListMinLines`-sized moves) with
 * the position left behind whenever the active editor changes (tab switch, file
 * open, go-to-definition into another file), so walking backward re-traces
 * navigation across tabs the way vim's jump list crosses buffers. Entries are
 * plain (path, point) pairs — not marker-backed like the per-editor lists — so
 * a position can drift when lines are inserted above it; vim accepts the same
 * drift for unloaded buffers.
 */
import { Point } from '../text/Point.ts';
import { CompositeDisposable, Disposable, type DisposableLike } from '../util/eventKit.ts';
import { zym } from '../zym.ts';
import type { OpenFileOptions } from '../Workspace.ts';

const MAX_ENTRIES = 100;

/** The slice of TextEditor the jump list needs — narrow so tests can stub it. */
export interface JumpEditor {
  readonly currentFile: string | null;
  getCursorBufferPosition(): Point;
  onDidRecordJump(fn: (point: Point) => void): DisposableLike;
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
  // The editor whose departure the next active-editor change records.
  private lastActive: JumpEditor | null = null;
  // Guards against a jump's own openFile/tab-switch re-recording as a departure.
  private navigating = false;

  constructor(deps: GlobalJumpListDeps = zym.workspace) {
    this.d = deps;
    this.disposables.add(
      this.d.observeTextEditors((editor) => {
        const sub = editor.onDidRecordJump((point) => this.record(editor, point));
        return new Disposable(() => {
          sub.dispose();
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
  }

  dispose(): void {
    this.disposables.dispose();
    this.entries = [];
    this.lastActive = null;
  }

  // A different editor took focus: record the position left in the previous
  // one, so a plain tab switch is a re-traceable jump. The identity check stays
  // even though the workspace dedups — `open()` re-syncs `lastActive` itself.
  private activeEditorChanged(active: JumpEditor | null): void {
    if (active === this.lastActive) return;
    const previous = this.lastActive;
    this.lastActive = active;
    if (this.navigating || !previous) return;
    this.record(previous, previous.getCursorBufferPosition());
  }

  private sameSpot(entry: Entry | undefined, path: string, point: Point): boolean {
    return Boolean(entry && entry.path === path && entry.point.row === point.row);
  }

  // Same ring semantics as the per-editor list (vim/position-history.ts):
  // append as newest, drop forward history, dedup a consecutive same-line entry.
  private record(editor: JumpEditor, point: Point): void {
    if (this.navigating) return;
    const path = editor.currentFile;
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
    this.navigating = true;
    try {
      this.d.openFile(entry.path, { cursor: [entry.point.row, entry.point.column] });
    } finally {
      this.navigating = false;
    }
    this.lastActive = this.d.getActiveTextEditor();
  }
}
