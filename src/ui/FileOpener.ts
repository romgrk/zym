/*
 * Path pickers — a family of path-navigating pickers over one directory-listing
 * core: open a file (`openFileOpener`), move the current file into a folder
 * (`openFolderPicker`), or rename/relocate it (`openRenamePicker`).
 *
 * Unlike `FilePicker` (a recursive fuzzy walk over relative paths), these keep a
 * *full path* in the prompt and list exactly the entries of whatever directory
 * that path currently denotes: the prompt's directory part (everything up to the
 * last `/`) chooses the directory, and the trailing part fuzzy-filters its
 * entries. Editing the path re-lists; choosing a folder descends into it (the
 * prompt is rewritten to that folder, in place — see Picker `onSelect`); choosing
 * a file, or running the prompt-driven action row, hands a path back to the caller.
 *
 * Listing a single directory is a cheap synchronous `readdirSync`, so it runs
 * through the Picker's `fetch` source (re-queried, debounced, as the directory
 * part changes) and resolves immediately — no background walk needed.
 *
 * The prompt works in *tilde-reduced* path space: `$HOME` and anything under it
 * shows as `~`, and the prompt, the listed entries, and the fuzzy filter all use
 * that form (so the typed `~/…` still matches the rows). `~` is expanded back to
 * `$HOME` only at the filesystem boundary (`readdir`, open, create) and when a
 * path is handed back to the caller. Deleting the `~` navigates up out of home
 * into its parent (`/home`, or the OS-equivalent) rather than collapsing to
 * nothing — see `directoryOf`.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, escapeMarkup, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { tildify, expandTilde } from '../util/tilde.ts';
import Gtk from 'gi:Gtk-4.0';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** A directory entry, carrying its kind so the row and selection can branch on it. */
interface FileItem extends PickerItem {
  isDir: boolean;
}

/**
 * A prompt-driven action row (e.g. "Create:", "Move here:", "Rename to:"). Same
 * shape as the Picker's `PickerAction`; `label`/`visible`/`run` all receive the
 * current (tilde-form) prompt, and the wrapper expands `~` as needed.
 */
interface PathPickerAction {
  label: (query: string) => string;
  run: (query: string) => void;
  visible?: (query: string) => boolean;
}

interface PathPickerOptions {
  host: Overlay;
  placeholder: string;
  /** Initial prompt (a tilde-form path): a directory with a trailing slash to list
   *  its contents, or a file path to seed an edit (cursor lands at the end). */
  query: string;
  /** List only directories (the folder picker). */
  foldersOnly?: boolean;
  /** Frecency namespace for ranking/recording chosen entries (omit to disable). */
  frecency?: string;
  /** Called with the real (expanded) absolute path of a chosen *file* entry. */
  onChoose?: (path: string) => void;
  /** The prompt-driven action row, if any. */
  action?: PathPickerAction;
}

/** Shared core behind the path-navigating pickers; see the public wrappers below. */
function openPathPicker(opts: PathPickerOptions): void {
  openPicker({
    host: opts.host,
    placeholder: opts.placeholder,
    promptIcon: fileIconGlyph('', true), // the folder glyph, matching the directory rows
    disableIconPadding: true, // rows render their own icons via renderRow; skip the prompt-indent
    query: opts.query,
    // Re-list whenever the directory part of the path changes; the Picker's local
    // fuzzy filter narrows + highlights the entries against the typed path in
    // between (debounced re-list, instant filter).
    fetch: (query, onResult) => onResult(listDir(directoryOf(query), opts.foldersOnly)),
    // Show just the entry's name with a file/folder glyph and (folders) a trailing
    // slash; the shared directory prefix is already in the prompt, so a muted detail
    // column would only repeat it on every row. The glyph needs a blank cell for
    // files so names align, so it stays inline in the markup rather than using the
    // renderer's icon slot.
    renderRow: (item, positions) => {
      const f = item as FileItem;
      const base = Path.basename(item.text);
      const start = item.text.length - base.length;
      const name = highlightSegment(item.text, start, item.text.length, positions);
      // Only folders carry a glyph (a leading folder icon); files get a blank cell
      // in its place so their names still line up under the folders'.
      const icon = f.isDir ? escapeMarkup(fileIconGlyph(base, true)) : ' ';
      const row = `${icon}  ${name}${f.isDir ? '/' : ''}`;
      return renderRowSingleLine({ main: row });
    },
    frecency: opts.frecency,
    onSelect: (value, item) => {
      // Descend into a folder by rewriting the prompt to it (Picker re-lists and
      // stays open, keeping the `~` form); hand a chosen file back as its real
      // absolute path (expanding any `~`).
      if ((item as FileItem).isDir) return withTrailingSlash(value);
      opts.onChoose?.(expandTilde(value));
    },
    action: opts.action,
  });
}

/**
 * Open the path-navigating file opener rooted at `dir` (an absolute path, e.g.
 * the workbench cwd). `onChoose` is called with the absolute path of the chosen
 * file; folders descend in place instead. The action row creates the typed file
 * (and any missing parent directories) when it doesn't already exist.
 */
export function openFileOpener(host: Overlay, dir: string, onChoose: (path: string) => void): void {
  openPathPicker({
    host,
    placeholder: 'Open file…',
    // The prompt holds a full path (with `$HOME` shown as `~`); seed it with the
    // starting directory (trailing slash → list its contents, with an empty filter).
    query: withTrailingSlash(tildify(dir)),
    frecency: 'file',
    onChoose,
    action: {
      label: (query) => `Create: ${Path.basename(query)}`,
      // Only surface when the query names a file (non-empty basename, no trailing slash).
      visible: (query) => !query.endsWith('/') && Path.basename(query).length > 0,
      run: (query) => {
        const target = expandTilde(query);
        Fs.mkdirSync(Path.dirname(target), { recursive: true });
        if (!Fs.existsSync(target)) Fs.writeFileSync(target, '');
        onChoose(target);
      },
    },
  });
}

/**
 * Open a folder picker rooted at `dir`, listing *only* directories. Navigate by
 * descending into folders; the always-present action row picks the directory
 * currently being listed and hands its absolute path to `onChoose` (e.g. a move
 * destination).
 */
export function openFolderPicker(host: Overlay, dir: string, onChoose: (folder: string) => void): void {
  openPathPicker({
    host,
    placeholder: 'Move to folder…',
    query: withTrailingSlash(tildify(dir)),
    foldersOnly: true,
    action: {
      // The directory whose contents are listed is the destination; `directoryOf`
      // is exactly what `fetch` lists, so it stays in step as you descend / filter.
      label: (query) => `Move here: ${directoryOf(query)}`,
      run: (query) => onChoose(expandTilde(directoryOf(query))),
    },
  });
}

/**
 * Open a rename/relocate picker seeded with `file`'s full path (cursor at the
 * end, the directory listed and filtered by the current name). Edit the path and
 * confirm via the action row to rename to the typed path; selecting an existing
 * file targets it instead (the caller prompts before overwriting). `onChoose`
 * receives the real (expanded) absolute destination path.
 */
export function openRenamePicker(host: Overlay, file: string, onChoose: (path: string) => void): void {
  openPathPicker({
    host,
    placeholder: 'Rename to…',
    query: tildify(file),
    onChoose,
    action: {
      label: (query) => `Rename to: ${Path.basename(query)}`,
      // Surface when the query names a file (non-empty basename, no trailing slash)
      // that differs from the source path.
      visible: (query) =>
        !query.endsWith('/') && Path.basename(query).length > 0 && expandTilde(query) !== file,
      run: (query) => onChoose(expandTilde(query)),
    },
  });
}

/**
 * The directory part of a typed path: everything up to (and not past) the last
 * `/`. Computed on the expanded (`~`→`$HOME`) path and re-tildified, so `~`
 * behaves exactly like the home path it stands for — in particular, the bare
 * `~` (its trailing slash deleted) yields home's parent (`/home`, or the
 * OS-equivalent), so deleting the `~` navigates up out of home.
 */
function directoryOf(input: string): string {
  const expanded = expandTilde(input);
  const slash = expanded.lastIndexOf('/');
  if (slash < 0) return '.';
  return tildify(expanded.slice(0, slash) || '/'); // keep root as "/", not ""
}

/** `path` with exactly one trailing slash (so it reads as "this directory"). */
function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * List `dir`'s entries as picker items (folders first, then files, each sorted
 * by name; `foldersOnly` drops the files). `dir` may be `~`-rooted; it's expanded
 * for the `readdir`, but each item's path is re-tildified so its `text` stays in
 * the same `~` form as the typed prompt (and so home itself, listed from `/home`,
 * reads as `~`). `text` is that path so it fuzzy-matches the typed prompt, with
 * `boostFrom` at the filename so name matches outrank directory ones. An
 * unreadable directory yields no entries (the picker shows "No matches").
 */
function listDir(dir: string, foldersOnly = false): FileItem[] {
  const abs = expandTilde(dir);
  let entries: Fs.Dirent[];
  try {
    entries = Fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: FileItem[] = [];
  const files: FileItem[] = [];
  for (const entry of entries) {
    const isDir = entry.isDirectory();
    if (foldersOnly && !isDir) continue;
    const value = tildify(Path.join(abs, entry.name));
    // basename(value), not entry.name: tildify collapses home itself to `~`, whose
    // basename is `~` rather than the directory's real name.
    const item: FileItem = { value, text: value, boostFrom: value.length - Path.basename(value).length, isDir };
    (isDir ? dirs : files).push(item);
  }
  const byName = (a: FileItem, b: FileItem) => a.text.localeCompare(b.text);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}
