/*
 * File picker — the first user of the fuzzy picker. Walks the current working
 * directory for files and opens the fuzzy picker over their paths (relative for
 * display), invoking `onSelect` with the absolute path of the chosen file.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openFuzzyPicker } from './fuzzy-picker.ts';
import type { ApplicationWindow } from './gi.ts';

// Directories that are rarely what you want to open and expensive to walk.
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.cache',
]);
const MAX_FILES = 20000;

export function openFilePicker(parent: ApplicationWindow, onSelect: (path: string) => void): void {
  const cwd = process.cwd();
  const files = collectFiles(cwd);
  openFuzzyPicker({
    parent,
    title: 'Open File',
    placeholder: 'Search files…',
    items: files,
    onSelect: (relative) => onSelect(Path.join(cwd, relative)),
  });
}

/** Recursively collect file paths under `root`, relative to it. */
function collectFiles(root: string): string[] {
  const files: string[] = [];

  const walk = (dir: string) => {
    if (files.length >= MAX_FILES) return;
    let entries: Fs.Dirent[];
    try {
      entries = Fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = Path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        files.push(Path.relative(root, full));
      }
    }
  };

  walk(root);
  return files;
}
