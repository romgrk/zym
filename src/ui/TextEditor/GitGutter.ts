/*
 * GitGutter — a VS Code-style change bar in the editor's left gutter.
 *
 * Draws a colored bar on each line that differs from HEAD: added (green),
 * modified (amber), and a marker on the line above a deletion (red). Updates
 * live as you type: the editor buffer is diffed in-process (Myers, see
 * util/lineDiff) against the file's HEAD blob, debounced. The HEAD blob is
 * (re)fetched on load and on any `GitRepo.onChange` (commits, staging, branch
 * switches), so the bars stay correct as both sides move.
 *
 * Mirrors DiagnosticsView: a `GtkSource.GutterRendererText` subclass driven by a
 * line→kind map, repainted with `queueDraw()`.
 */
import * as Path from 'node:path';
import { GLib, Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { diffLines } from '../../util/lineDiff.ts';
import { git, repoRoot } from '../../git.ts';
import { isLineFolded } from '../../syntax/syntax-controller.ts';
import type { GitRepo } from '../../git.ts';

type ChangeKind = 'added' | 'modified' | 'removed';

// Bar colors match the rest of the git UI (GitBranchButton / GitPanel): theme
// semantic colors.
const COLORS: Record<ChangeKind, string> = {
  added: theme.ui.success,
  modified: theme.ui.warning,
  removed: theme.ui.error,
};
// U+258F LEFT ONE EIGHTH BLOCK — the thinnest full-height block glyph (~1px), so
// stacked lines read as one continuous hairline bar.
const BAR = '▏';

// Coalesce keystrokes before re-diffing the buffer.
const DEBOUNCE_MS = 150;

// Split text into lines, tolerating CRLF and ignoring a single trailing newline
// (so a file's final newline isn't reported as a phantom change).
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

class GitGutterRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. (line is 0-based.)
  kindByLine!: Map<number, ChangeKind>;
  buffer!: any;

  queryData(_lines: any, line: number) {
    const kind = this.kindByLine?.get(line);
    // Blank for unchanged lines, and for changed lines hidden inside a fold (so
    // bars don't pile up at the collapsed position).
    if (!kind || isLineFolded(this.buffer, line)) {
      this.setMarkup(' ', -1);
      return;
    }
    this.setMarkup(`<span foreground="${COLORS[kind]}">${BAR}</span>`, -1);
  }
}
registerClass(GitGutterRenderer);

export class GitGutter {
  private readonly view: SourceView;
  private readonly getPath: () => string | null;
  private readonly getText: () => string;
  private readonly git: GitRepo;
  private readonly renderer: GitGutterRenderer;
  private readonly kindByLine = new Map<number, ChangeKind>();
  private readonly subs = new CompositeDisposable();

  // The current file's HEAD blob, split into lines; null until first fetched.
  private baseLines: string[] | null = null;
  // Bumped per base fetch so a late async result for a superseded file is dropped.
  private baseGeneration = 0;
  // Pending debounced recompute (a GLib timeout id; 0 when none).
  private updateTimer = 0;
  // Cache the repo root per path so the sync `rev-parse` isn't run on every fetch.
  private cachedRoot: string | null = null;
  private cachedRootPath: string | null = null;

  constructor(view: SourceView, getPath: () => string | null, getText: () => string, gitRepo: GitRepo) {
    this.view = view;
    this.getPath = getPath;
    this.getText = getText;
    this.git = gitRepo;

    this.renderer = new GitGutterRenderer();
    (this.renderer as any).kindByLine = this.kindByLine;
    (this.renderer as any).buffer = (view as any).getBuffer();
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);

    // HEAD moved (commit / checkout / staging): re-fetch the base and re-diff.
    this.subs.add({ dispose: this.git.onChange(() => this.refresh()) });
  }

  /** (Re)fetch the file's HEAD blob, then re-diff. Call on load / save / HEAD change. */
  refresh(): void {
    const path = this.getPath();
    const root = path ? this.rootFor(path) : null;
    if (!path || !root) {
      this.baseLines = [];
      this.recompute();
      return;
    }
    const rel = Path.relative(root, path);
    const generation = ++this.baseGeneration;
    git(root, ['show', `HEAD:${rel}`], (ok, stdout) => {
      if (generation !== this.baseGeneration) return; // superseded by a newer fetch
      // No HEAD blob (untracked / new / unborn HEAD) → empty base, so the whole
      // file reads as added.
      this.baseLines = ok ? splitLines(stdout) : [];
      this.recompute();
    });
  }

  /** Debounced re-diff of the live buffer against the cached base (on edits). */
  scheduleUpdate(): void {
    if (this.updateTimer) GLib.sourceRemove(this.updateTimer);
    this.updateTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this.updateTimer = 0;
      this.recompute();
      return false;
    });
  }

  /** Sorted buffer rows where each git hunk begins — a hunk is a maximal run of
   *  consecutive changed (added/modified/removed) lines. Drives vim `]h`/`[h`. */
  hunkStartRows(): number[] {
    const rows = [...this.kindByLine.keys()].sort((a, b) => a - b);
    const starts: number[] = [];
    let prev = -2;
    for (const row of rows) {
      if (row !== prev + 1) starts.push(row);
      prev = row;
    }
    return starts;
  }

  dispose(): void {
    if (this.updateTimer) GLib.sourceRemove(this.updateTimer);
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
    this.subs.dispose();
  }

  // --- internals -------------------------------------------------------------

  private rootFor(path: string): string | null {
    if (this.cachedRootPath !== path) {
      this.cachedRootPath = path;
      this.cachedRoot = repoRoot(Path.dirname(path));
    }
    return this.cachedRoot;
  }

  // Diff the live buffer against the base and rebuild the line→kind map.
  private recompute(): void {
    if (this.baseLines === null) return; // base not fetched yet; refresh() will drive it
    this.kindByLine.clear();

    const ops = diffLines(this.baseLines, splitLines(this.getText()));
    let row = 0; // 0-based line in the new (buffer) side
    let i = 0;
    while (i < ops.length) {
      if (ops[i] === 'eq') {
        row++;
        i++;
        continue;
      }
      // A change run: consecutive deletions/insertions, classified like git.
      let deletions = 0;
      const inserted: number[] = [];
      while (i < ops.length && ops[i] !== 'eq') {
        if (ops[i] === 'ins') inserted.push(row++);
        else deletions++;
        i++;
      }
      if (inserted.length === 0) {
        // Pure deletion: mark the surviving line above the gap (always exists).
        this.mark(Math.max(0, row - 1), 'removed');
      } else {
        const kind: ChangeKind = deletions === 0 ? 'added' : 'modified';
        for (const r of inserted) this.mark(r, kind);
      }
    }
    this.renderer.queueDraw();
  }

  private mark(row: number, kind: ChangeKind): void {
    // A deletion marker never overrides an added/modified bar on the same line.
    if (kind === 'removed' && this.kindByLine.has(row)) return;
    this.kindByLine.set(row, kind);
  }
}
