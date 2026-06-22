/*
 * Search picker — full-text search across the project with ripgrep. Unlike the
 * file picker (which fuzzy-matches paths locally), this is a "remote search"
 * picker: each keystroke re-runs `rg` (debounced) and its results replace the
 * candidate pool, so local fuzzy filtering is off (`localFilter: false`) —
 * ripgrep does the matching. Each row is one matching line; choosing it opens
 * the file at that line/column.
 *
 * `rg` runs via `spawn` with streaming `data`/`close` handlers rather than a
 * promise or `execFile`'s buffered callback: Node's promise microtasks don't
 * resolve while node-gtk's GLib main loop is blocked (node-gtk#430), and the
 * stream-event form is the subprocess pattern proven to fire under the loop (the
 * same one the LSP client and the LSP installer use).
 */
import { spawn } from 'node:child_process';
import * as Path from 'node:path';
import { Buffer } from 'node:buffer';
import { escapeMarkup, HIGHLIGHT_COLOR, type PickerItem } from './Picker.ts';
import { openLocationPicker } from './LocationPicker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { Gtk } from '../gi.ts';
import { Icons } from './icons.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Navigate to a chosen result: absolute path + 0-based `[row, column]` cursor. */
export type SearchTarget = (path: string, cursor: [number, number]) => void;

const MAX_RESULTS = 500; // cap rows parsed from rg (and so shown)
const MAX_OUTPUT = 16 * 1024 * 1024; // cap accumulated stdout; kill rg past it
const MAX_LINE_LENGTH = 500; // crop very long matching lines for display

// A picker item carrying the location to jump to and the match span to accent.
interface SearchItem extends PickerItem {
  /** Absolute path of the matching file. */
  file: string;
  /** 0-based `[row, column]` of the match, for `restoreCursor`. */
  cursor: [number, number];
  /** Char span `[matchStart, matchEnd)` into `text` (post-trim) to highlight. */
  matchStart: number;
  matchEnd: number;
  /** Right-aligned, muted `path:line` location shown after the matched line. */
  detailText: string;
}

export function openSearchPicker(host: Overlay, cwd: string, onSelect: SearchTarget): void {
  openLocationPicker({
    host,
    placeholder: 'Search in project…',
    promptIcon: Icons.search, // doubles as the home for the fetch spinner
    // ripgrep filters server-side; show its results in order, no local refine.
    localFilter: false,
    // Render the matched line with the matched span accented, and the `path:line`
    // location as a muted right-aligned detail.
    renderRow: (item) => {
      const it = item as SearchItem;
      const t = it.text;
      const main =
        escapeMarkup(t.slice(0, it.matchStart)) +
        `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">` +
        escapeMarkup(t.slice(it.matchStart, it.matchEnd)) +
        '</span>' +
        escapeMarkup(t.slice(it.matchEnd));
      // Smaller, croppable `path:line`: it yields to the matched line when space is tight.
      return renderRowSingleLine({ main, detail: `<span size="smaller">${escapeMarkup(it.detailText)}</span>`, cropDetail: true });
    },
    fetch: (query, onResult, onError) => {
      const q = query.trim();
      if (q === '') {
        onResult([]); // nothing to search for yet
        return;
      }
      runRipgrep(cwd, q, (result) => {
        if (result.error !== undefined) onError(result.error);
        else onResult(result.items ?? []);
      });
    },
    locate: (item) => {
      const it = item as SearchItem;
      // Highlight the matched span in the preview: the match length (preserved
      // across the display trim) from the match's start column.
      const length = it.matchEnd - it.matchStart;
      return { path: it.file, line: it.cursor[0], column: it.cursor[1], endColumn: it.cursor[1] + length };
    },
    onJump: (loc) => onSelect(loc.path, [loc.line, loc.column]),
  });
}

interface RipgrepResult {
  items?: SearchItem[];
  error?: string;
}

function runRipgrep(cwd: string, query: string, onDone: (result: RipgrepResult) => void): void {
  // `--json` gives exact byte offsets per match (for accurate highlighting and
  // navigation); `--smart-case` matches the editor's search ergonomics. The `--`
  // stops a query that starts with `-` being read as a flag.
  const args = ['--json', '--smart-case', '--', query];
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    onDone({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (result: RipgrepResult) => {
    if (done) return;
    done = true;
    onDone(result);
  };

  // Spawn failure (e.g. rg not installed) surfaces here, not via `close`.
  proc.on('error', (err) => {
    finish({
      error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ripgrep (rg) is not installed' : err.message,
    });
  });
  proc.stdout?.on('data', (d) => {
    stdout += d.toString();
    // A query matching half the tree could stream forever; once we have plenty
    // (more than we'll show), stop rg and parse what arrived.
    if (stdout.length > MAX_OUTPUT) {
      proc.kill();
      finish({ items: parseRipgrep(stdout, cwd) });
    }
  });
  proc.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  proc.on('close', (code) => {
    // rg exits 0 (matches) or 1 (no matches); 2+ is a real error (bad regex…).
    if (code !== null && code > 1) {
      finish({ error: stderr.trim() || 'search failed' });
      return;
    }
    finish({ items: parseRipgrep(stdout, cwd) });
  });
}

/** Parse `rg --json` stdout (one JSON object per line) into search items. */
function parseRipgrep(stdout: string, cwd: string): SearchItem[] {
  const items: SearchItem[] = [];
  for (const line of stdout.split('\n')) {
    if (items.length >= MAX_RESULTS) break;
    if (line === '') continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== 'match') continue;

    const data = msg.data;
    const relPath: string | undefined = data.path?.text;
    const lineText: string | undefined = data.lines?.text;
    const submatch = data.submatches?.[0];
    // `path`/`lines` are absent (only `.bytes`) for non-UTF-8 content — skip it.
    if (relPath === undefined || lineText === undefined || !submatch) continue;

    // rg reports byte offsets into the line; convert to char indices so the
    // highlight span and cursor column are correct for non-ASCII lines too.
    const startChar = byteToChar(lineText, submatch.start);
    const endChar = byteToChar(lineText, submatch.end);
    const rawLine = lineText.replace(/\r?\n$/, '');

    // Trim leading indentation for display (code is usually indented) and shift
    // the match span to match; cap long lines so one row can't widen the card.
    const leading = rawLine.length - rawLine.trimStart().length;
    let display = rawLine.slice(leading);
    let matchStart = Math.max(0, startChar - leading);
    let matchEnd = Math.max(matchStart, endChar - leading);
    if (display.length > MAX_LINE_LENGTH) {
      display = display.slice(0, MAX_LINE_LENGTH) + '…';
      matchStart = Math.min(matchStart, MAX_LINE_LENGTH);
      matchEnd = Math.min(matchEnd, MAX_LINE_LENGTH);
    }

    const file = Path.join(cwd, relPath);
    items.push({
      value: file,
      text: display,
      file,
      cursor: [data.line_number - 1, startChar], // rg is 1-based; buffer is 0-based
      matchStart,
      matchEnd,
      detailText: `${relPath}:${data.line_number}`,
    });
  }
  return items;
}

/** Char index in `text` for a UTF-8 `byteOffset` (so non-ASCII lines map right). */
function byteToChar(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}
