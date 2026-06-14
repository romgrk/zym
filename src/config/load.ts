/*
 * load.ts — create and watch the user config file.
 *
 * At startup this ensures `$XDG_CONFIG_HOME/quilx/config.json` (falling back to
 * `~/.config`) exists — creating the directory and seeding an empty `{}` if
 * absent — then applies its contents to the global `quilx.config` and installs a
 * Gio file monitor so live edits sync straight back into the store.
 *
 * The file is a flat map of dotted config keys to values, mirroring the schema
 * key paths exactly (e.g. `{ "editor.tabLength": 4 }`). Each key is applied as an
 * override on top of the schema default; deleting a key reverts it to its
 * default. Values are coerced/validated by `Config.set`; rejected values are
 * warned about and skipped. Like the keymap loader, every error is reported as a
 * warning and never thrown, so a malformed config never blocks startup.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gio } from '../gi.ts';
import { quilx } from '../quilx.ts';
import type { ConfigValue } from '../util/Config.ts';
import { Disposable } from '../util/eventKit.ts';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper, so we reach them through the interface prototype. Same workaround as
// git.ts / FileTree.
const FileProto = (Gio.File as any).prototype;

const SEED = '{}\n';

function configDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  return Path.join(configHome, 'quilx');
}

function configPath(): string {
  return Path.join(configDir(), 'config.json');
}

// Read and parse the config file. Returns null on any problem (missing, a
// truncated mid-write, or not a JSON object), so callers simply skip that tick.
function readConfig(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = Fs.readFileSync(path, 'utf8');
  } catch {
    return null; // missing or mid-write — nothing to apply this tick
  }
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[config] ${path} is not a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`[config] failed to parse ${path}: ${(error as Error).message}`);
    return null;
  }
}

// Apply the file's keys as overrides, returning the keys that took effect. Keys
// applied last time but now absent are reverted to their schema default, so the
// file stays the single source of truth for what is overridden.
function applyConfig(parsed: Record<string, unknown>, previous: Set<string>): Set<string> {
  const applied = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (quilx.config.set(key, value as ConfigValue)) applied.add(key);
    else console.warn(`[config] rejected value for "${key}": ${JSON.stringify(value)}`);
  }
  for (const key of previous) {
    if (!applied.has(key)) quilx.config.unset(key);
  }
  return applied;
}

/**
 * Ensure the user config exists, apply it to `quilx.config`, and watch it for
 * live edits. Returns a Disposable that stops the watcher.
 */
export function loadConfig(): Disposable {
  const dir = configDir();
  const path = configPath();

  try {
    Fs.mkdirSync(dir, { recursive: true });
    if (!Fs.existsSync(path)) Fs.writeFileSync(path, SEED);
  } catch (error) {
    console.warn(`[config] could not create ${path}: ${(error as Error).message}`);
  }

  // Track which keys the file currently overrides, so a later edit that drops a
  // key can revert it.
  let applied = new Set<string>();
  const initial = readConfig(path);
  if (initial) applied = applyConfig(initial, applied);

  let monitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  try {
    const file = Gio.File.newForPath(path);
    monitor = FileProto.monitorFile.call(file, Gio.FileMonitorFlags.WATCH_MOVES, null);
    // Editors save via truncate or temp+rename, firing several events; re-reading
    // on each is idempotent (a partial read just parses as null and is skipped).
    monitor!.on('changed', () => {
      const next = readConfig(path);
      if (next) applied = applyConfig(next, applied);
    });
  } catch (error) {
    console.warn(`[config] could not watch ${path}: ${(error as Error).message}`);
  }

  return new Disposable(() => {
    monitor?.cancel();
    monitor = null;
  });
}
