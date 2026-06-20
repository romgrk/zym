/*
 * load.ts — register the keymaps at startup.
 *
 * Layers two sources by priority: the built-in `DEFAULT_KEYMAP` (priority 0) and
 * an optional user keymap (priority 100) read from `$XDG_CONFIG_HOME/quilx/
 * keymap.json` (falling back to `~/.config`). The user file uses the same
 * `{ selector: { keystroke: command } }` shape and, being higher priority, wins
 * when it binds the same keystroke as a default.
 *
 * Both sources are validated first: unparseable selectors/keystrokes and empty
 * commands are reported as warnings (never thrown), so a single typo disables one
 * binding rather than the whole app.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gio } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { parseSelector } from '../util/selectors.ts';
import { Key } from '../keymap/Key.ts';
import { Disposable } from '../util/eventKit.ts';
import { DEFAULT_KEYMAP } from './default.ts';

// node-gtk quirk: Gio.File instance methods resolve to undefined on the concrete
// wrapper, so reach them through the interface prototype (see config/load.ts).
const FileProto = (Gio.File as any).prototype;

type Binding = string | { command?: string; args?: unknown[] };
type Keymap = Record<string, Record<string, Binding>>;
type RegisterableKeymap = Record<string, Record<string, string | { command: string; args?: unknown[] }>>;

const DEFAULT_PRIORITY = 0;
const USER_PRIORITY = 100;

// The live registration of the user keymap, disposed + recreated on file change.
let userKeymapDisposable: Disposable | null = null;

// Seed for a freshly-created user keymap — an empty table the user fills in
// (mirrors config/load.ts's SEED).
const SEED = '{}\n';

/** Absolute path to the user keymap file (`$XDG_CONFIG_HOME/quilx/keymap.json`). */
export function userKeymapPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  return Path.join(configHome, 'quilx', 'keymap.json');
}

/**
 * Ensure the user keymap file exists (creating its directory and an empty-table
 * seed if missing), then return its path — so a command can open it for editing
 * even before the user has written one. The file watcher installed by
 * `loadKeymaps` picks up subsequent edits.
 */
export function ensureUserKeymap(): string {
  const path = userKeymapPath();
  try {
    Fs.mkdirSync(Path.dirname(path), { recursive: true });
    if (!Fs.existsSync(path)) Fs.writeFileSync(path, SEED);
  } catch (error) {
    console.warn(`[keymap] could not create ${path}: ${(error as Error).message}`);
  }
  return path;
}

// Warn (don't throw) on malformed entries: bad selectors, keystrokes that don't
// parse, or empty command names.
function validateKeymap(source: string, keymap: Keymap): void {
  for (const selector of Object.keys(keymap)) {
    const rules = parseSelector(selector); // also warns on unparseable / too-broad selectors
    if (rules.length === 0)
      console.warn(`[keymap:${source}] selector "${selector}" parsed to no rules`);

    const bindings = keymap[selector];
    for (const sequence of Object.keys(bindings)) {
      const value = bindings[sequence];
      const command = typeof value === 'string' ? value : value?.command;
      if (!command)
        console.warn(`[keymap:${source}] empty command for "${sequence}" (${selector})`);
      if (value && typeof value === 'object' && value.args !== undefined && !Array.isArray(value.args))
        console.warn(`[keymap:${source}] "args" for "${sequence}" (${selector}) must be an array`);
      for (const stroke of sequence.trim().split(/\s+/)) {
        if (Key.fromDescription(stroke) === null)
          console.warn(`[keymap:${source}] unparseable key "${stroke}" in "${sequence}" (${selector})`);
      }
    }
  }
}

function readUserKeymap(): Keymap | null {
  const path = userKeymapPath();
  let text: string;
  try {
    text = Fs.readFileSync(path, 'utf8');
  } catch {
    return null; // no user keymap — that's fine
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`[keymap:user] ${path} is not a JSON object`);
      return null;
    }
    return parsed as Keymap;
  } catch (error) {
    console.warn(`[keymap:user] failed to parse ${path}: ${(error as Error).message}`);
    return null;
  }
}

// (Re)register the user keymap: drop the previous registration, then validate +
// add the current file (if any). Dispose-before-add matters — the source id is
// reused, so the old Disposable must remove the old entries before new ones land.
function reloadUserKeymap(): void {
  userKeymapDisposable?.dispose();
  userKeymapDisposable = null;

  const userKeymap = readUserKeymap();
  if (userKeymap) {
    validateKeymap('user', userKeymap);
    // Untrusted JSON (its `command` may be missing); validation above has already
    // warned, and a binding with no command resolves to nothing at dispatch.
    userKeymapDisposable = quilx.keymaps.add(
      'user-keymap',
      userKeymap as RegisterableKeymap,
      USER_PRIORITY,
    );
  }
  reportConflicts();
}

// Warn on keystrokes bound to more than one command at the same selector+priority.
function reportConflicts(): void {
  for (const c of quilx.keymaps.findConflicts()) {
    console.warn(
      `[keymap] "${c.keystroke}" on ${c.selectorKey} (priority ${c.priority}) is bound to ` +
        `multiple commands: ${c.commands.join(', ')}`,
    );
  }
}

/**
 * Register the built-in keymap and, if present, the user's keymap on top (higher
 * priority), validating each first. Watches `keymap.json` so edits re-register
 * the user layer live (like `config.json`). Returns a Disposable that stops the
 * watcher.
 */
export function loadKeymaps(): Disposable {
  validateKeymap('default', DEFAULT_KEYMAP);
  quilx.keymaps.add('default-keymap', DEFAULT_KEYMAP, DEFAULT_PRIORITY);

  reloadUserKeymap();

  let monitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  try {
    const file = Gio.File.newForPath(userKeymapPath());
    monitor = FileProto.monitorFile.call(file, Gio.FileMonitorFlags.WATCH_MOVES, null);
    // Editors save via truncate or temp+rename (several events); reloading on
    // each is idempotent (a partial read parses as null and is skipped).
    monitor!.on('changed', () => reloadUserKeymap());
  } catch (error) {
    console.warn(`[keymap] could not watch ${userKeymapPath()}: ${(error as Error).message}`);
  }

  return new Disposable(() => {
    monitor?.cancel();
    monitor = null;
  });
}
