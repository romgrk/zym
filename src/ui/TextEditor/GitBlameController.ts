/*
 * GitBlameController — current-line git blame as end-of-line virtual text, per view
 * (GitLens-style). Enabled by the `editor.lineBlame` config flag; while on, the line
 * under the cursor trails the blame for the commit that last touched it, formatted by
 * `editor.lineBlameFormat`.
 *
 * Built on `VirtualText` (the native annotation API, `AnnotationStyle.NONE` — plain
 * trailing text, no background), mirroring `InlayHintController`. Blame is fetched for
 * the whole file (`git blame --line-porcelain --contents -`, feeding the LIVE buffer so
 * line numbers and uncommitted lines match what the user sees) and cached; cursor moves
 * and fold toggles re-place the single annotation from the cache with no new git call.
 * An edit invalidates the cache, so the next render re-blames (debounced).
 */
import * as Path from 'node:path';
import type { SourceView } from '../../gi.ts';
import { zym } from '../../zym.ts';
import { VirtualText } from './VirtualText.ts';
import { escapeMarkup } from '../Picker.ts';
import { blame, blameLine, git, repoRoot } from '../../git.ts';
import { relativeTime } from '../../core/relativeTime.ts';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import type { TextEditor } from './TextEditor.ts';

export interface BlameLine {
  sha: string;
  author: string;
  timestamp: number; // author-time, epoch seconds
  summary: string;
}

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

/** True for the all-zero sha git blame assigns to not-yet-committed (working-tree) lines. */
export function isUncommitted(sha: string): boolean {
  return sha === UNCOMMITTED_SHA;
}

/** Blame the commit that last touched 0-based `modelLine` of `relPath` (blaming the live
 *  `contents`). Returns null when blame fails or the line is out of range. The line may be
 *  uncommitted — check `isUncommitted(info.sha)`. */
export function blameCommitForLine(
  root: string,
  relPath: string,
  modelLine: number,
  contents: string,
  onDone: (info: BlameLine | null) => void,
): void {
  blameLine(root, relPath, modelLine + 1, contents, (ok, stdout) => {
    if (!ok) return onDone(null);
    const [info] = parseBlame(stdout).values();
    onDone(info ?? null);
  });
}

/** Blame the commit that last touched the cursor's line of `editor` (live buffer). The
 *  callback gets null outside a repo / on a blame failure; an uncommitted line yields a
 *  zero-sha `BlameLine` (test with `isUncommitted`). Backs the commit popover + PR-for-line. */
export function blameCommitAtCursor(editor: TextEditor, onDone: (info: BlameLine | null) => void): void {
  const file = editor.currentFile;
  if (!file) return onDone(null);
  const root = repoRoot(Path.dirname(file));
  if (!root) return onDone(null);
  blameCommitForLine(root, Path.relative(root, file), editor.lspCursor().row, editor.sourceText, onDone);
}

/** Pop the full message of the commit that last touched the cursor line, above the cursor
 *  (the editor's hover card). Backs `git:show-commit`. */
export function showCommitAtCursor(editor: TextEditor): void {
  const file = editor.currentFile;
  if (!file) return;
  const root = repoRoot(Path.dirname(file));
  if (!root) return;
  blameCommitAtCursor(editor, (info) => {
    if (!info) return void zym.notifications.addInfo('No blame for this line');
    if (isUncommitted(info.sha)) return void zym.notifications.addInfo('Line is not committed yet');
    git(root, ['show', '-s', '--date=short', '--format=%h • %an, %ad%n%n%B', info.sha], (ok, stdout) => {
      if (!ok) return;
      const text = stdout.trimEnd();
      const nl = text.indexOf('\n');
      const head = nl < 0 ? text : text.slice(0, nl);
      const body = nl < 0 ? '' : text.slice(nl);
      editor.showHoverMarkup(`<b>${escapeMarkup(head)}</b>${escapeMarkup(body)}`);
    });
  });
}
const DEBOUNCE_MS = 400;
const DEFAULT_FORMAT = '[message, time, author]';

export class GitBlameController {
  private readonly annotations: VirtualText;
  private disposed = false;
  private cache: Map<number, BlameLine> | null = null;
  private cacheKey: string | null = null; // file path the cache was blamed from
  private seq = 0; // drops stale async blame responses
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Absolute path of the file in this view, or null (buffer-only editor).
  private readonly getFile: () => string | null;
  // The live buffer text (MODEL / full file) blamed via `--contents -`.
  private readonly getContents: () => string;
  // The cursor's VIEW row (0-based).
  private readonly getCursorViewRow: () => number;
  // VIEW row → MODEL (file) line: folds collapse text, so the two diverge.
  private readonly viewRowToModelLine: (viewRow: number) => number;

  constructor(
    view: SourceView,
    getFile: () => string | null,
    getContents: () => string,
    getCursorViewRow: () => number,
    viewRowToModelLine: (viewRow: number) => number,
  ) {
    this.annotations = new VirtualText(view);
    this.getFile = getFile;
    this.getContents = getContents;
    this.getCursorViewRow = getCursorViewRow;
    this.viewRowToModelLine = viewRowToModelLine;
  }

  private get enabled(): boolean {
    return zym.config.get('editor.lineBlame') === true;
  }

  // The hot per-edit/move hooks early-return when disabled, so a turned-off blame
  // costs only a config-flag read (no annotation churn, no git). `refresh()` — fired
  // by the config observer on the on→off transition — is the one path that clears.

  /** Cursor moved — re-place the annotation on the new line (cache hit: synchronous). */
  onCursorMoved(): void {
    if (this.enabled) this.render();
  }

  /** A fold opened/closed — view rows shifted under the cursor; re-place. */
  rerender(): void {
    if (this.enabled) this.render();
  }

  /** The file content/identity changed — drop the cache so a re-enable re-blames fresh
   *  rather than painting stale line→commit mappings (still cheap while disabled). */
  invalidate(): void {
    this.cache = null;
    this.cacheKey = null;
    if (this.enabled) this.render();
  }

  /** Config (`editor.lineBlame` / `editor.lineBlameFormat`) changed — re-evaluate (this
   *  is what clears the annotation when the flag goes off). */
  refresh(): void {
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    if (!this.enabled) return void this.annotations.clear();
    const file = this.getFile();
    if (!file) return void this.annotations.clear();
    if (!repoRoot(Path.dirname(file))) return void this.annotations.clear();
    if (this.cache && this.cacheKey === file) {
      this.paint(file);
      return;
    }
    this.scheduleFetch(file);
  }

  /** (Re)blame the live buffer after a short idle (coalesces a burst of edits). */
  private scheduleFetch(file: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fetch(file);
    }, DEBOUNCE_MS);
  }

  private fetch(file: string): void {
    if (this.disposed || !this.enabled) return;
    const root = repoRoot(Path.dirname(file));
    if (!root) return void this.annotations.clear();
    const token = ++this.seq;
    blame(root, Path.relative(root, file), this.getContents(), (ok, stdout) => {
      if (this.disposed || token !== this.seq) return; // superseded / torn down
      if (!ok) return void this.annotations.clear();
      this.cache = parseBlame(stdout);
      this.cacheKey = file;
      if (this.enabled && this.getFile() === file) this.paint(file);
    });
  }

  /** Place the single annotation for the cursor's current line, from the cache. */
  private paint(file: string): void {
    if (!this.cache || this.cacheKey !== file) return;
    const info = this.cache.get(this.viewRowToModelLine(this.getCursorViewRow()));
    if (!info) return void this.annotations.clear();
    this.annotations.setAnnotations([{ line: this.getCursorViewRow(), text: formatBlame(info), style: 'none' }]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.annotations.dispose();
  }
}

/** Install current-line git blame across every text editor — a built-in conceived like a
 *  plugin: it plugs into the same `observeTextEditors` seam as decoration plugins rather
 *  than being wired into the editor itself. For each editor it owns a `GitBlameController`
 *  + the `git:show-commit` command, all torn down when that editor closes. Call once at
 *  startup; the returned Disposable removes the whole feature. */
export function installGitBlame(): Disposable {
  return zym.workspace.observeTextEditors((editor) => {
    const controller = new GitBlameController(
      editor.sourceView,
      () => editor.currentFile,
      () => editor.sourceText, // the canonical source text — folds don't substitute file lines
      () => editor.model.getCursorBufferPosition().row,
      (viewRow) => editor.documentLineForScreenLine(viewRow),
    );
    const subs = new CompositeDisposable(
      editor.onDidChangeCursorPosition(() => controller.onCursorMoved()),
      editor.onDidChangeFolds(() => controller.rerender()),
      editor.model.onDidChangeText(() => controller.invalidate()),
      zym.config.observe('editor.lineBlame', () => controller.refresh()),
      zym.config.observe('editor.lineBlameFormat', () => controller.refresh()),
      zym.commands.add(editor.sourceView, {
        'git:show-commit': {
          didDispatch: () => showCommitAtCursor(editor),
          description: 'Show the commit that last touched this line',
          when: () => editor.currentFile != null,
        },
      }),
    );
    return new Disposable(() => {
      subs.dispose();
      controller.dispose();
    });
  });
}

/** Parse `git blame --line-porcelain` into a map of MODEL line (0-based) → blame.
 *  Each line is a full porcelain block: a `<sha> <orig> <final>` header, repeated
 *  `author`/`author-time`/`summary` fields, then a `\t`-prefixed content line. */
export function parseBlame(out: string): Map<number, BlameLine> {
  const map = new Map<number, BlameLine>();
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)/;
  let cur: { sha: string; finalLine: number; author: string; timestamp: number; summary: string } | null = null;
  for (const line of out.split('\n')) {
    const header = headerRe.exec(line);
    if (header) {
      cur = { sha: header[1], finalLine: Number(header[2]), author: '', timestamp: 0, summary: '' };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('author ')) {
      cur.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      cur.timestamp = Number(line.slice(12));
    } else if (line.startsWith('summary ')) {
      cur.summary = line.slice(8);
    } else if (line.startsWith('\t')) {
      map.set(cur.finalLine - 1, { sha: cur.sha, author: cur.author, timestamp: cur.timestamp, summary: cur.summary });
      cur = null;
    }
  }
  return map;
}

/** Render a blame line per the `editor.lineBlameFormat` token list (message/time/
 *  author/date/sha, in the order they appear), joined by ` • `. */
export function formatBlame(info: BlameLine, format = blameFormat()): string {
  if (info.sha === UNCOMMITTED_SHA) return 'You • Uncommitted changes';
  const parts: string[] = [];
  for (const token of format.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (token === 'message') parts.push(info.summary);
    else if (token === 'time') parts.push(relativeTime(info.timestamp));
    else if (token === 'author') parts.push(info.author);
    else if (token === 'date') parts.push(absoluteDate(info.timestamp));
    else if (token === 'sha') parts.push(info.sha.slice(0, 7));
  }
  return parts.filter(Boolean).join(' • ');
}

function blameFormat(): string {
  const value = zym.config.get('editor.lineBlameFormat');
  return typeof value === 'string' && value.trim() ? value : DEFAULT_FORMAT;
}

function absoluteDate(epochSeconds: number): string {
  if (!epochSeconds) return 'unknown';
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
}
