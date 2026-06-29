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
 * The prompt works in *shortened* path space, displayed against the workbench
 * `cwd`: a path under the cwd shows relative (`src/foo`, the cwd itself as the
 * empty prompt), else `$HOME` collapses to `~`, else it's absolute. The prompt,
 * the listed entries, and the fuzzy filter all use that same form (so the typed
 * path matches the rows). A shortened path is resolved back to a real absolute
 * path only at the filesystem boundary (`readdir`, open, create) and when handed
 * to the caller. Deleting the leading `~` navigates up out of home into its parent
 * (`/home`, or the OS-equivalent) rather than collapsing to nothing — see
 * `directoryOf`.
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
 * current (shortened) prompt, and the wrapper resolves it against `cwd` as needed.
 */
interface PathPickerAction {
  label: (query: string) => string;
  run: (query: string) => void;
  visible?: (query: string) => boolean;
}

interface PathPickerOptions {
  host: Overlay;
  placeholder: string;
  /** Base directory that paths are shortened against (the workbench cwd). */
  cwd: string;
  /** Initial prompt (a shortened path): a directory with a trailing slash to list
   *  its contents, or a file path to seed an edit (cursor lands at the end). */
  query: string;
  /** List only directories (the folder picker). */
  foldersOnly?: boolean;
  /** List the directory's entries as fuzzy-match candidates (default true). Off for
   *  the rename picker, where suggesting existing files is just an overwrite hazard
   *  — it's a pure name input driven by the action row. */
  completions?: boolean;
  /** Frecency namespace for ranking/recording chosen entries (omit to disable). */
  frecency?: string;
  /** Called with the real (resolved) absolute path of a chosen *file* entry. */
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
    // between (debounced re-list, instant filter). `completions: false` suppresses
    // the listing entirely (the rename picker).
    fetch: (query, sink) =>
      sink.replace(opts.completions === false ? [] : listDir(directoryOf(query, opts.cwd), opts.cwd, opts.foldersOnly)),
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
      // stays open, keeping the shortened form); hand a chosen file back as its
      // real absolute path (resolving any relative/`~` prefix).
      if ((item as FileItem).isDir) return withTrailingSlash(value);
      opts.onChoose?.(resolvePath(value, opts.cwd));
    },
    action: opts.action,
  });
}

/**
 * Open the path-navigating file opener with paths shortened against `cwd` (the
 * workbench cwd), starting by listing it. `onChoose` is called with the absolute
 * path of the chosen file; folders descend in place instead. The action row
 * creates the typed file (and any missing parent directories) when it doesn't
 * already exist.
 */
export function openFileOpener(host: Overlay, cwd: string, onChoose: (path: string) => void): void {
  openPathPicker({
    host,
    cwd,
    placeholder: 'Open file…',
    // Seed with the cwd itself — shortened to the empty prompt, listing its contents.
    query: listSeed(cwd, cwd),
    frecency: 'file',
    onChoose,
    action: {
      label: (query) => `Create: ${Path.basename(query)}`,
      // Only surface when the query names a file (non-empty basename, no trailing slash).
      visible: (query) => !query.endsWith('/') && Path.basename(query).length > 0,
      run: (query) => {
        const target = resolvePath(query, cwd);
        Fs.mkdirSync(Path.dirname(target), { recursive: true });
        if (!Fs.existsSync(target)) Fs.writeFileSync(target, '');
        onChoose(target);
      },
    },
  });
}

/**
 * Open a folder picker rooted at `dir`, paths shortened against `cwd`, listing
 * *only* directories. Navigate by descending into folders; the always-present
 * action row picks the directory currently being listed and hands its absolute
 * path to `onChoose` (e.g. a move destination).
 */
export function openFolderPicker(host: Overlay, cwd: string, dir: string, onChoose: (folder: string) => void): void {
  openPathPicker({
    host,
    cwd,
    placeholder: 'Move to folder…',
    query: listSeed(dir, cwd),
    foldersOnly: true,
    action: {
      // The directory whose contents are listed is the destination; `directoryOf`
      // is exactly what `fetch` lists, so it stays in step as you descend / filter.
      label: (query) => `Move here: ${directoryOf(query, cwd) || '.'}`,
      run: (query) => onChoose(resolvePath(directoryOf(query, cwd), cwd)),
    },
  });
}

/**
 * Open a rename/relocate picker seeded with `file`'s path (shortened against
 * `cwd`, cursor at the end). It's a pure name input — no completion candidates,
 * so existing files aren't suggested (and can't be picked into by accident);
 * editing the path and confirming via the always-present action row renames to
 * the typed path. `onChoose` receives the real (resolved) absolute destination
 * (the caller prompts before overwriting / when it equals the source).
 */
export function openRenamePicker(host: Overlay, cwd: string, file: string, onChoose: (path: string) => void): void {
  openPathPicker({
    host,
    cwd,
    placeholder: 'Rename to…',
    query: relativize(file, cwd),
    completions: false,
    action: {
      label: (query) => `Rename to: ${Path.basename(query)}`,
      // The only row, so keep it whenever the query names a file (non-empty
      // basename, no trailing slash); a no-op same-name confirm is caught downstream.
      visible: (query) => !query.endsWith('/') && Path.basename(query).length > 0,
      run: (query) => onChoose(resolvePath(query, cwd)),
    },
  });
}

/**
 * Shorten an absolute `path` for display against the workbench `cwd`: the cwd
 * itself is the empty string, a path under it is cwd-relative (`src/foo`), and
 * anything else falls back to `~`/absolute (see `tildify`). Inverse of
 * `resolvePath`.
 */
function relativize(path: string, cwd: string): string {
  if (path === cwd) return '';
  if (path.startsWith(cwd + Path.sep)) return path.slice(cwd.length + 1);
  return tildify(path);
}

/**
 * Resolve a shortened prompt `input` back to a real absolute path: the empty
 * string is the cwd, a `~`-rooted path expands to `$HOME`, an absolute path is
 * itself, and anything else is relative to `cwd`. Inverse of `relativize`.
 */
function resolvePath(input: string, cwd: string): string {
  if (input === '') return cwd;
  if (input === '~' || input.startsWith('~' + Path.sep)) return expandTilde(input);
  if (Path.isAbsolute(input)) return input;
  return Path.resolve(cwd, input);
}

/** The prompt that lists `dir`'s contents (empty filter): its shortened form with
 *  a trailing slash, or the empty prompt when `dir` is the cwd itself. */
function listSeed(dir: string, cwd: string): string {
  const rel = relativize(dir, cwd);
  return rel === '' ? '' : withTrailingSlash(rel);
}

/**
 * The directory part of a typed path: everything up to (and not past) the last
 * `/`, resolved against `cwd` and re-shortened. The empty prompt is the cwd. A
 * slashless prompt lists the parent of whatever it resolves to (so `src` filters
 * the cwd and `~` — the home shorthand with its slash deleted — lands in home's
 * parent, `/home` or the OS-equivalent), which is what makes deleting the `~`
 * navigate up out of home.
 */
function directoryOf(input: string, cwd: string): string {
  if (input === '') return relativize(cwd, cwd); // the cwd lists itself
  const slash = input.lastIndexOf('/');
  if (slash < 0) return relativize(parentOf(resolvePath(input, cwd)), cwd);
  return relativize(resolvePath(input.slice(0, slash) || '/', cwd), cwd); // keep root as "/", not ""
}

/** The parent directory of an absolute `path` (root stays root). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** `path` with exactly one trailing slash (so it reads as "this directory"). */
function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * List `dir`'s entries as picker items (folders first, then files, each sorted
 * by name; `foldersOnly` drops the files). `dir` is a shortened path; it's
 * resolved against `cwd` for the `readdir`, but each item's path is re-shortened
 * so its `text` stays in the same form as the typed prompt. `text` is that path
 * so it fuzzy-matches the typed prompt, with `boostFrom` at the filename so name
 * matches outrank directory ones. An unreadable directory yields no entries (the
 * picker shows "No matches").
 */
function listDir(dir: string, cwd: string, foldersOnly = false): FileItem[] {
  const abs = resolvePath(dir, cwd);
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
    const full = Path.join(abs, entry.name);
    // `relativize` collapses the cwd itself to "" — fine as the listing root, but a
    // blank row when the cwd shows up as an *entry* (listing its parent), so fall
    // back to its `~`/absolute form there.
    const value = relativize(full, cwd) || tildify(full);
    // basename(value), not entry.name: the shortened value may rename the leading
    // segment (e.g. home collapsed to `~`), so derive the boost from `value` itself.
    const item: FileItem = { value, text: value, boostFrom: value.length - Path.basename(value).length, isDir };
    (isDir ? dirs : files).push(item);
  }
  const byName = (a: FileItem, b: FileItem) => a.text.localeCompare(b.text);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}
