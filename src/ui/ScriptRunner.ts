/*
 * Script runner — a picker over the `scripts` of the workbench's `package.json`.
 *
 * Reads `package.json` in the given directory, lists its `scripts` as a
 * two-column picker (the script name on the left, its command muted on the
 * right), and hands the chosen script's name back to the caller — which spawns
 * the package manager (`npm`/`pnpm`/`yarn`/`bun`, detected from the lockfile)
 * running it in a terminal tab.
 *
 * Reading and parsing one `package.json` is a cheap synchronous file read, so a
 * missing file / absent `scripts` / malformed JSON surfaces inside the picker
 * itself (an error row) rather than as a separate notification.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { Icons } from './icons.ts';
import { Gtk } from '../gi.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** A node package manager, named by the binary the runner invokes. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * The package manager for the project rooted at `dir`, chosen from the lockfile
 * present (pnpm/yarn/bun, else npm). Only `dir` itself is inspected — the
 * workbench cwd is the project root.
 */
export function detectPackageManager(dir: string): PackageManager {
  if (Fs.existsSync(Path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (Fs.existsSync(Path.join(dir, 'yarn.lock'))) return 'yarn';
  if (Fs.existsSync(Path.join(dir, 'bun.lockb')) || Fs.existsSync(Path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/**
 * Open the script runner over the `package.json` in `dir`. `onRun` is called
 * with the chosen script's name; the caller spawns the package manager running
 * it. With no package.json (or no scripts) the picker opens straight into an
 * error state instead of bailing.
 */
export function openScriptRunner(host: Overlay, dir: string, onRun: (name: string) => void): void {
  const { scripts, error } = readScripts(dir);

  // Each script is a two-column row: the name (matched + highlighted on the
  // left) and its command (muted, right-aligned). `text` packs both so the query
  // matches either; `data` carries the name length so the row can carve them
  // apart (the name can't be recovered from `text` by searching for the gap).
  const items: PickerItem[] = scripts.map(({ name, command }) => ({
    value: name,
    text: `${name}  ${command}`,
    data: name.length,
  }));

  openPicker({
    host,
    placeholder: 'Run script…',
    promptIcon: Icons.terminal,
    items,
    error: error ?? undefined,
    renderRow: (item, positions) => {
      const split = item.data as number;
      return renderRowSingleLine({
        main: highlightSegment(item.text, 0, split, positions),
        detail: highlightSegment(item.text, split + 2, item.text.length, positions),
      });
    },
    onSelect: (name) => onRun(name),
  });
}

interface Script {
  name: string;
  command: string;
}

/** Parse `dir/package.json`'s `scripts`, or an error message describing why not. */
function readScripts(dir: string): { scripts: Script[]; error: string | null } {
  const file = Path.join(dir, 'package.json');
  let raw: string;
  try {
    raw = Fs.readFileSync(file, 'utf8');
  } catch {
    return { scripts: [], error: 'No package.json in this folder' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { scripts: [], error: 'package.json is not valid JSON' };
  }
  const table = (parsed as { scripts?: unknown })?.scripts;
  if (!table || typeof table !== 'object') {
    return { scripts: [], error: 'No scripts in package.json' };
  }
  const scripts = Object.entries(table as Record<string, unknown>)
    .filter(([, command]) => typeof command === 'string')
    .map(([name, command]) => ({ name, command: command as string }));
  if (scripts.length === 0) return { scripts: [], error: 'No scripts in package.json' };
  return { scripts, error: null };
}
