/*
 * zym-commands — vim operations original to zym (not vendored from vim-mode-plus).
 *
 *   - GoToFile (`gf`): open the file whose name is under the cursor, resolving the
 *     path against the current file's directory, then the project root, then as an
 *     absolute / `~`-relative path.
 *   - GoogleSearch (`gw`): open a Google search for the word under the cursor
 *     (normal mode) or the current selection (visual mode) in the default browser.
 *
 * Like the vendored operation modules, this self-registers its classes at import
 * time (see the `register()` loop at the bottom); `index.ts` imports it for that
 * side effect and wires the keymaps.
 */
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import { Base } from './base.ts';
import { zym } from '../../../zym.ts';
import { openUrl } from '../../openUrl.ts';

// Characters that make up a file name under the cursor (roughly vim's `isfname`):
// letters, digits, and the path/name punctuation that survives in real paths.
// Notably excludes whitespace, quotes, parens and `,;:` so a path embedded in
// prose or an import statement is picked up without its surrounding syntax.
const FILENAME_CHAR = /[A-Za-z0-9._/~$@+#%-]/;

/**
 * Extract the file-name token surrounding `column` in `line`. When the cursor sits
 * on a delimiter, it prefers the token ending just before the cursor, otherwise
 * scans forward to the next token on the line (matching vim's `gf` behaviour).
 * Returns `''` when the line holds no file-name characters at/after the cursor.
 */
export function filenameTokenAt(line: string, column: number): string {
  let i = column;
  if (i >= line.length || !FILENAME_CHAR.test(line[i])) {
    // Cursor on a delimiter: take the token it sits at the end of, else seek forward.
    if (i > 0 && FILENAME_CHAR.test(line[i - 1])) i -= 1;
    else while (i < line.length && !FILENAME_CHAR.test(line[i])) i += 1;
  }
  if (i >= line.length || !FILENAME_CHAR.test(line[i])) return '';

  let start = i;
  let end = i + 1;
  while (start > 0 && FILENAME_CHAR.test(line[start - 1])) start -= 1;
  while (end < line.length && FILENAME_CHAR.test(line[end])) end += 1;
  return line.slice(start, end);
}

/**
 * Resolve a file-name token to an existing file path, or `null` if none exists.
 * Tries, in order: absolute / `~`-relative as-is; relative to `currentFile`'s
 * directory; relative to `projectRoot` (the active workbench's root — not
 * process.cwd(), so a `gf` in a non-primary project resolves against its own root).
 */
export function resolveFilePath(token: string, currentFile: string | null, projectRoot: string): string | null {
  const expanded =
    token === '~' || token.startsWith('~/') ? Path.join(Os.homedir(), token.slice(1)) : token;

  const candidates: string[] = [];
  if (Path.isAbsolute(expanded)) {
    candidates.push(expanded);
  } else {
    if (currentFile) candidates.push(Path.resolve(Path.dirname(currentFile), expanded));
    candidates.push(Path.resolve(projectRoot, expanded));
  }

  for (const candidate of candidates) {
    try {
      if (Fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* candidate doesn't exist — try the next one */
    }
  }
  return null;
}

/** Build the Google search URL for `query`. */
export function googleSearchUrl(query: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

// gf — open the file named under the cursor.
class GoToFile extends Base {
  static operationKind = 'misc-command';

  // The file-name token under the cursor (exposed for tests / readability).
  getFileToken(): string {
    const point = this.getCursorBufferPosition();
    return filenameTokenAt(this.editor.lineTextForBufferRow(point.row), point.column);
  }

  execute(): void {
    const token = this.getFileToken();
    if (!token) {
      zym.notifications.addInfo('No file name under the cursor');
      return;
    }
    const currentFile = zym.workspace.getActiveTextEditor()?.currentFile ?? null;
    // The active workbench's root anchors a relative token; fall back to the launch dir only
    // when there is no workbench yet (headless/pre-init) — never as the routine project root.
    const projectRoot = zym.workspace.getActiveWorkbench()?.cwd ?? process.cwd();
    const resolved = resolveFilePath(token, currentFile, projectRoot);
    if (!resolved) {
      zym.notifications.addError('File not found', { detail: token });
      return;
    }
    zym.workspace.openFile(resolved);
  }
}

// gw — Google-search the word under the cursor (normal) or the selection (visual).
class GoogleSearch extends Base {
  static operationKind = 'misc-command';

  // The text to search for (exposed for tests / readability).
  getQuery(): string {
    if (this.mode === 'visual') return this.editor.getSelectedText();
    const { range } = this.getWordBufferRangeAndKindAtBufferPosition(this.getCursorBufferPosition());
    return this.editor.getTextInBufferRange(range);
  }

  execute(): void {
    const wasVisual = this.mode === 'visual';
    const query = this.getQuery().trim();
    if (!query) {
      zym.notifications.addInfo('Nothing under the cursor to search for');
      return;
    }
    openUrl(googleSearchUrl(query));
    if (wasVisual) this.activateMode('normal');
  }
}

const __operations = { GoToFile, GoogleSearch };
for (const klass of Object.values(__operations)) klass.register();
export default __operations;
