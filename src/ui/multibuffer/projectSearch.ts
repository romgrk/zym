/*
 * projectSearch — the single project-wide ripgrep search backend, shared by the quick
 * SearchPicker and the full ProjectSearchView. `searchProject` streams `rg --json` matches as
 * they arrive (so results render progressively) and returns a handle to cancel the in-flight rg
 * when the query changes; `runProjectSearch` is a buffered convenience over it. The pure parts
 * (rg-record → `RgMatch`, group rows into context-padded merged regions, header flags → rg args)
 * are unit-tested without spawning rg. I/O routes through the streaming process runner, so the
 * giant node-gtk process never forks — docs/process-runner.md.
 */
import * as Path from 'node:path';
import { runProcessStream, type ProcHandle } from '../../process/runner.ts';
import type { ExcerptInput } from '../SearchResultsView.ts';
import type { MatchRange } from './MultiBufferModel.ts';

const MAX_MATCHES = 1000; // cap rows parsed from rg across all files
export const DEFAULT_CONTEXT = 2; // lines of context each side of a match

/** Matches in one file, in file order of first appearance; `rows` are 0-based, deduped.
 *  `matches` carries each individual hit's column span (for highlighting), one per rg
 *  submatch — possibly several per row. */
export interface FileMatches {
  path: string;
  rows: number[];
  matches?: MatchRange[];
}

/**
 * Group match rows into excerpt regions: pad each match by `context` lines, merge
 * overlapping or adjacent regions (so two nearby matches share one region with a continuous
 * body rather than two with a `⋯` between), clamp to the file bounds when a `lineCount` is
 * known. Pure — the place a region-merge bug surfaces in a test.
 */
export function matchesToExcerptInputs(
  files: FileMatches[],
  opts: { context?: number; lineCount?: (path: string) => number | undefined } = {},
): ExcerptInput[] {
  const context = opts.context ?? DEFAULT_CONTEXT;
  const out: ExcerptInput[] = [];
  for (const file of files) {
    const last = (opts.lineCount?.(file.path) ?? Infinity) - 1;
    const rows = [...new Set(file.rows)].sort((a, b) => a - b);
    const regions: Array<{ startRow: number; endRow: number }> = [];
    for (const row of rows) {
      const startRow = Math.max(0, row - context);
      const endRow = Number.isFinite(last) ? Math.min(last, row + context) : row + context;
      const prev = regions[regions.length - 1];
      // Merge into the previous region when this one overlaps or merely touches it.
      if (prev && startRow <= prev.endRow + 1) prev.endRow = Math.max(prev.endRow, endRow);
      else regions.push({ startRow, endRow });
    }
    if (regions.length > 0) {
      const input: ExcerptInput = { path: file.path, regions };
      if (file.matches?.length) input.matches = file.matches; // carry match spans through to highlight
      out.push(input);
    }
  }
  return out;
}

/**
 * Search-tuning flags surfaced in the project-search header, mapped to ripgrep options. The
 * defaults mirror a friendly search box: smart-case, literal (non-regex) matching, and
 * ripgrep's own ignore rules (so .gitignore'd and hidden files are skipped).
 */
export interface ProjectSearchOptions {
  /** false (default) → `--smart-case`; true → `--case-sensitive`. */
  caseSensitive?: boolean;
  /** `--word-regexp`: match only whole-word occurrences. */
  wholeWord?: boolean;
  /** false (default) → `--fixed-strings` (literal); true → treat the query as a regex. */
  regex?: boolean;
  /** File globs (`--glob <g>`). A `!`-prefixed glob excludes, matching ripgrep's own syntax —
   *  so include and exclude live in one field (e.g. `*.ts, !*.test.ts`). */
  globs?: string[];
  /** Also search git-ignored and hidden files (`--no-ignore --hidden`). */
  includeIgnored?: boolean;
}

/** Build the `rg --json …` argument list for `query` under `options`. Pure + exported so the
 *  flag→argument mapping is unit-testable without spawning ripgrep. */
export function buildRipgrepArgs(query: string, options: ProjectSearchOptions = {}): string[] {
  const args = ['--json'];
  args.push(options.caseSensitive ? '--case-sensitive' : '--smart-case');
  if (options.wholeWord) args.push('--word-regexp');
  if (!options.regex) args.push('--fixed-strings'); // literal query unless regex is enabled
  if (options.includeIgnored) args.push('--no-ignore', '--hidden');
  // One glob field; rg reads a leading `!` as "exclude", so pass each verbatim.
  for (const g of options.globs ?? []) if (g.trim() !== '') args.push('--glob', g.trim());
  // `--` stops a query that starts with `-` being read as a flag; the trailing `.` is the
  // search path. The path is REQUIRED: the process runner hands rg a pipe on stdin, and rg
  // searches stdin (blocking forever) whenever it's given no path — so we always pass `.` to
  // force a recursive directory search of `cwd`.
  args.push('--', query, '.');
  return args;
}

/** Codepoint column at UTF-8 byte offset `byteOffset` within `text` — rg reports submatch
 *  offsets in BYTES, but the editor's columns are codepoints (a GtkTextIter line offset). */
export function byteToColumn(text: string, byteOffset: number): number {
  return [...Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8')].length;
}

/** One matching line, normalized from an `rg --json` `match` record — the unit both search
 *  surfaces consume (the picker shows one row per match; the view groups them into files). */
export interface RgMatch {
  /** Absolute path. */
  file: string;
  /** Path as rg reported it (relative to `cwd`). */
  relPath: string;
  /** 0-based row of the match. */
  row: number;
  /** The matched line (trailing newline stripped); `''` for non-UTF-8 matches. */
  lineText: string;
  /** Column spans (codepoints) of each hit on this line; empty for non-UTF-8 matches. */
  spans: Array<{ startCol: number; endCol: number }>;
}

/** Parse one `rg --json` line into an `RgMatch`, or null for any non-`match` / unparseable /
 *  non-UTF-8-path line. Pure + exported so the rg-record mapping is unit-testable. */
export function parseRgMatch(line: string, cwd: string): RgMatch | null {
  if (line === '') return null;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg?.type !== 'match') return null;
  const data = msg.data;
  const relPath: string | undefined = data?.path?.text;
  const lineNumber: number | undefined = data?.line_number;
  if (relPath === undefined || lineNumber === undefined) return null; // non-UTF-8 path: skip
  // `lines.text` is the matched line; absent on non-UTF-8 matches (rg emits `bytes`) — keep the
  // row but drop column spans (and so highlighting) for it.
  const lineText: string = typeof data?.lines?.text === 'string' ? data.lines.text.replace(/\r?\n$/, '') : '';
  const spans: Array<{ startCol: number; endCol: number }> = [];
  if (lineText !== '' && Array.isArray(data.submatches)) {
    for (const sub of data.submatches) {
      if (typeof sub.start !== 'number' || typeof sub.end !== 'number') continue;
      spans.push({ startCol: byteToColumn(lineText, sub.start), endCol: byteToColumn(lineText, sub.end) });
    }
  }
  return { file: Path.join(cwd, relPath), relPath, row: lineNumber - 1, lineText, spans };
}

/** Reduce a flat match stream into per-file rows + column spans (file order = first seen). */
export function groupMatches(matches: RgMatch[]): FileMatches[] {
  const byPath = new Map<string, { rows: number[]; matches: MatchRange[] }>();
  const order: string[] = [];
  for (const m of matches) {
    let entry = byPath.get(m.file);
    if (!entry) { entry = { rows: [], matches: [] }; byPath.set(m.file, entry); order.push(m.file); }
    entry.rows.push(m.row);
    for (const s of m.spans) entry.matches.push({ row: m.row, startCol: s.startCol, endCol: s.endCol });
  }
  return order.map((path) => {
    const entry = byPath.get(path)!;
    return { path, rows: entry.rows, matches: entry.matches };
  });
}

/** Callbacks for a streaming project search. */
export interface SearchCallbacks {
  /** A batch of new matches (coalesced per frame), in rg's streaming order. */
  onMatches: (matches: RgMatch[]) => void;
  /** The search finished cleanly; `capped` → the `MAX_MATCHES` cap was hit and rg was stopped. */
  onDone: (info: { capped: boolean }) => void;
  /** rg failed (bad regex, not installed, …). */
  onError: (message: string) => void;
}

// Coalesce rapid rg chunks into one batch per frame (~60fps) so neither surface re-renders per
// match. setTimeout fires under the GLib loop (a microtask would not) — see runner streaming.
const FLUSH_MS = 16;

/**
 * Stream `rg --json` over `cwd` for `query` (tuned by `options`), emitting matches as they
 * arrive and returning a handle to cancel the in-flight rg (e.g. when the query changes). The
 * single search backend behind both the picker and the full view. Routes through the streaming
 * process runner — the broker child spawns rg (docs/process-runner.md). rg exits 0 (matches) /
 * 1 (none) / >1 (real error, e.g. bad regex); a null code is a spawn failure (rg not installed).
 */
export function searchProject(cwd: string, query: string, options: ProjectSearchOptions, cb: SearchCallbacks): ProcHandle {
  const q = query.trim();
  if (q === '') {
    cb.onDone({ capped: false });
    return { cancel() {} };
  }

  let tail = ''; // incomplete trailing line carried between chunks
  let batch: RgMatch[] = [];
  let total = 0;
  let capped = false;
  let finished = false;
  let stderr = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let handle: ProcHandle | null = null;

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    cb.onMatches(out);
  };
  const scheduleFlush = () => {
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
  };
  const settle = (error?: string) => {
    if (finished) return;
    finished = true;
    flush();
    if (error !== undefined) cb.onError(error);
    else cb.onDone({ capped });
  };

  const ingest = (line: string) => {
    if (capped) return;
    const m = parseRgMatch(line, cwd);
    if (!m) return;
    batch.push(m);
    if (++total >= MAX_MATCHES) {
      capped = true;
      handle?.cancel(); // stop rg early; its (suppressed) onDone won't fire, so settle below
      settle();
    }
  };

  handle = runProcessStream(
    { file: 'rg', args: buildRipgrepArgs(q, options), cwd },
    {
      onStdout: (chunk) => {
        if (finished) return;
        const text = tail + chunk.toString('utf8');
        const lines = text.split('\n');
        tail = lines.pop() ?? ''; // last element is the incomplete line
        for (const line of lines) {
          ingest(line);
          if (finished) return; // capped mid-chunk
        }
        scheduleFlush();
      },
      onStderr: (chunk) => { stderr += chunk.toString('utf8'); },
      onDone: ({ code }) => {
        if (finished) return; // already capped / settled
        if (tail !== '') ingest(tail); // rg newline-terminates, but be safe
        if (code === null) settle(stderr.trim() || 'ripgrep (rg) is not installed');
        else if (code > 1) settle(stderr.trim() || 'search failed');
        else settle();
      },
    },
  );
  return { cancel() { handle?.cancel(); finished = true; if (flushTimer) clearTimeout(flushTimer); } };
}

/**
 * Buffered convenience over `searchProject`: collect the whole stream, then call back once with
 * matches grouped by file. Used where progressive rendering isn't needed.
 */
export function runProjectSearch(
  cwd: string,
  query: string,
  options: ProjectSearchOptions,
  onDone: (result: { files?: FileMatches[]; error?: string }) => void,
): void {
  const all: RgMatch[] = [];
  searchProject(cwd, query, options, {
    onMatches: (matches) => { all.push(...matches); },
    onDone: () => onDone({ files: groupMatches(all) }),
    onError: (error) => onDone({ error }),
  });
}
