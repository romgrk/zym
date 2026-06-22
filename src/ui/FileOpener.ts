/*
 * File opener — a path-navigating "open file" picker.
 *
 * Unlike `FilePicker` (a recursive fuzzy walk over relative paths), this opener
 * keeps a *full path* in its prompt and lists exactly the entries of whatever
 * directory that path currently denotes: the prompt's directory part (everything
 * up to the last `/`) chooses the directory, and the trailing part fuzzy-filters
 * its entries. Editing the path re-lists; choosing a folder descends into it
 * (the prompt is rewritten to that folder, in place — see Picker `onSelect`),
 * and choosing a file opens it.
 *
 * Listing a single directory is a cheap synchronous `readdirSync`, so it runs
 * through the Picker's `fetch` source (re-queried, debounced, as the directory
 * part changes) and resolves immediately — no background walk needed.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, escapeMarkup, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { LsColors, type LsColorStyle } from '../util/lsColors.ts';
import { zym } from '../zym.ts';
import { Gtk } from '../gi.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** A directory entry, carrying its kind so the row and selection can branch on it. */
interface FileItem extends PickerItem {
  isDir: boolean;
}

/**
 * Open the path-navigating file opener rooted at `dir` (an absolute path, e.g.
 * the workbench cwd). `onChoose` is called with the absolute path of the chosen
 * file; folders descend in place instead.
 */
export function openFileOpener(host: Overlay, dir: string, onChoose: (path: string) => void): void {
  // Color file names like `ls --color`, from $LS_COLORS, when enabled (and the
  // variable is exported into the app's environment).
  const lsColors = zym.config.get('ui.lsColors') === true ? LsColors.fromEnv() : null;
  openPicker({
    host,
    placeholder: 'Open file…',
    promptIcon: fileIconGlyph('', true), // the folder glyph, matching the directory rows
    disableIconPadding: true, // rows render their own icons via renderRow; skip the prompt-indent
    // The prompt holds a full path; seed it with the starting directory (trailing
    // slash → list its contents, with an empty filter).
    query: withTrailingSlash(dir),
    // Re-list whenever the directory part of the path changes; the Picker's local
    // fuzzy filter narrows + highlights the entries against the typed path in
    // between (debounced re-list, instant filter).
    fetch: (query, onResult) => onResult(listDir(directoryOf(query))),
    // Show just the entry's name (with a file/folder glyph and a trailing slash on
    // folders); the shared directory prefix is already in the prompt, so a muted
    // detail column would only repeat it on every row.
    // Show just the entry's name with a file/folder glyph and (folders) a trailing
    // slash. The glyph is tinted with the name by LS_COLORS and needs a blank cell
    // for files so names align — so it stays inline in the markup rather than using
    // the renderer's icon slot.
    renderRow: (item, positions) => {
      const f = item as FileItem;
      const base = Path.basename(item.text);
      const start = item.text.length - base.length;
      const name = highlightSegment(item.text, start, item.text.length, positions);
      // Only folders carry a glyph (a leading folder icon); files get a blank cell
      // in its place so their names still line up under the folders'.
      const icon = f.isDir ? escapeMarkup(fileIconGlyph(base, true)) : ' ';
      const row = `${icon}  ${name}${f.isDir ? '/' : ''}`;
      // Tint the whole row (glyph + name) with the LS_COLORS style; the inner
      // match-highlight spans still override the matched characters.
      return renderRowSingleLine({ main: colorize(row, lsColors?.styleFor(base, { isDir: f.isDir })) });
    },
    frecency: 'file',
    onSelect: (value, item) => {
      // Descend into a folder by rewriting the prompt to it (Picker re-lists and
      // stays open); open a file by closing and handing back its absolute path.
      if ((item as FileItem).isDir) return withTrailingSlash(value);
      onChoose(value);
    },
    action: {
      label: (query) => `Create: ${Path.basename(query)}`,
      // Only surface when the query names a file (non-empty basename, no trailing slash).
      visible: (query) => !query.endsWith('/') && Path.basename(query).length > 0,
      run: (query) => {
        Fs.mkdirSync(Path.dirname(query), { recursive: true });
        if (!Fs.existsSync(query)) Fs.writeFileSync(query, '');
        onChoose(query);
      },
    },
  });
}

/** Wrap `markup` in a Pango span carrying an LS_COLORS style (a no-op when absent). */
function colorize(markup: string, style: LsColorStyle | undefined): string {
  if (!style?.fg && !style?.bold && !style?.underline) return markup;
  let attrs = '';
  if (style.fg) attrs += ` foreground="${style.fg}"`;
  if (style.bold) attrs += ' weight="bold"';
  if (style.underline) attrs += ' underline="single"';
  return `<span${attrs}>${markup}</span>`;
}

/** The directory part of a typed path: everything up to (and not past) the last `/`. */
function directoryOf(input: string): string {
  const slash = input.lastIndexOf('/');
  if (slash < 0) return '.';
  return input.slice(0, slash) || '/'; // keep root as "/", not ""
}

/** `path` with exactly one trailing slash (so it reads as "this directory"). */
function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * List `dir`'s entries as picker items (folders first, then files, each sorted
 * by name). Each item's `text` is its absolute path so it fuzzy-matches the typed
 * path, with `boostFrom` at the filename so name matches outrank directory ones.
 * An unreadable directory yields no entries (the picker shows "No matches").
 */
function listDir(dir: string): FileItem[] {
  let entries: Fs.Dirent[];
  try {
    entries = Fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: FileItem[] = [];
  const files: FileItem[] = [];
  for (const entry of entries) {
    const value = Path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    const item: FileItem = { value, text: value, boostFrom: value.length - entry.name.length, isDir };
    (isDir ? dirs : files).push(item);
  }
  const byName = (a: FileItem, b: FileItem) => a.text.localeCompare(b.text);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}
