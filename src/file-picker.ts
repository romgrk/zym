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
import { openFuzzyPicker } from './fuzzy-picker.ts';
import { GLib, Gtk } from './gi.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Directories that are rarely what you want to open and expensive to walk.
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.cache',
]);
const MAX_FILES = 20000;
const DIRS_PER_TICK = 24; // directories scanned per idle iteration

export function openFilePicker(host: Overlay, onSelect: (path: string) => void): void {
  const cwd = process.cwd();
  // Open immediately with an empty list; fill it as the background walk streams
  // results, so a large tree never blocks the UI.
  const picker = openFuzzyPicker({
    host,
    placeholder: 'Search files…',
    onSelect: (relative) => onSelect(Path.join(cwd, relative)),
  });
  collectFiles(cwd, (files) => picker.setItems(files));
}

/**
 * Walk `root` for files, calling `onUpdate` with the growing list (paths
 * relative to `root`) as directories are scanned. Non-blocking: a fixed number
 * of directories are scanned per GLib idle tick.
 */
function collectFiles(root: string, onUpdate: (files: string[]) => void): void {
  const files: string[] = [];
  const stack: string[] = [root];

  GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
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
    return !done; // keep the idle source alive until the walk finishes
  });
}
