/*
 * File picker — the first user of the fuzzy picker. Walks the current working
 * directory for files and opens the fuzzy picker over their paths (relative for
 * display), invoking `onSelect` with the absolute path of the chosen file.
 *
 * The walk runs incrementally from a GLib idle source rather than `await
 * fs.promises`: Node's promise microtasks don't run while the GLib main loop is
 * blocked (node-gtk#430), so the loop would never see the result. Scanning a
 * bounded number of directories per idle tick keeps the UI responsive and
 * streams results into the picker as they're found.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, type PickerItem } from './Picker.ts';
import { renderRowStacked } from './PickerRow.ts';
import { Gtk } from '../gi.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Directories that are rarely what you want to open and expensive to walk.
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.cache',
]);
const MAX_FILES = 20_000;
const DIRS_PER_TICK = 24; // directories scanned per idle iteration

export function openFilePicker(host: Overlay, cwd: string, onSelect: (path: string) => void): void {
  // Open immediately with an empty list; fill it as the background walk streams
  // results, so a large tree never blocks the UI.
  const picker = openPicker({
    host,
    placeholder: 'Search files…',
    // Surface recently/frequently opened files first, and nudge them up the
    // ranking once a query is typed.
    frecency: 'file',
    // Two-line rows: the filename on top, its directory muted below. Both index
    // into the relative path (`item.text`) so the match highlight spans them.
    renderRow: (item, positions) => {
      const rel = item.text;
      const dirEnd = rel.length - Path.basename(rel).length; // where the filename starts
      // Directory (trailing slash dropped); a root-level file has no directory, so
      // show `.` rather than a blank second line.
      const dir = highlightSegment(rel, 0, Math.max(0, dirEnd - 1), positions);
      return renderRowStacked({
        main: highlightSegment(rel, dirEnd, rel.length, positions),
        detail: dir || '.',
      });
    },
    onSelect,
  });
  collectFiles(cwd, (files) => picker.setItems(files.map((rel) => fileItem(cwd, rel))));
}

/**
 * Build a picker item for a file at `rel` (relative to `cwd`). Matching runs
 * against the whole relative path, but the filename portion is boosted so it
 * outranks directory-only matches; the row's two-line split (filename over
 * directory) is done in the picker's `renderRow`.
 */
function fileItem(cwd: string, rel: string): PickerItem {
  const base = Path.basename(rel);
  const dirEnd = rel.length - base.length; // index where the filename starts
  return {
    value: Path.join(cwd, rel),
    text: rel,
    boostFrom: dirEnd,
  };
}

/**
 * Walk `root` for files, calling `onUpdate` with the growing list (paths
 * relative to `root`) as directories are scanned. Non-blocking: a fixed number
 * of directories are scanned per GLib idle tick.
 */
function collectFiles(root: string, onUpdate: (files: string[]) => void): void {
  const files: string[] = [];
  const stack: string[] = [root];

  const tick = () => {
    let scanned = 0;
    let added = false;
    while (stack.length > 0 && scanned < DIRS_PER_TICK && files.length < MAX_FILES) {
      const dir = stack.pop();
      if (dir === undefined) break;
      scanned++;

      let entries: Fs.Dirent[];
      try {
        entries = Fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip it
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const full = Path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
        } else if (entry.isFile()) {
          files.push(Path.relative(root, full));
          added = true;
        }
      }
    }

    if (added) onUpdate(files.slice());
    const done = stack.length === 0 || files.length >= MAX_FILES;
    if (!done) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}
