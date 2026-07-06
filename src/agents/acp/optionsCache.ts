/*
 * agents/acp/optionsCache.ts — a tiny disk cache of the options an ACP agent
 * advertises, keyed by its argv.
 *
 * The problem: an ACP agent only reveals its real options (approval modes via
 * `session/new`'s `modes`, and generic `configOptions` — model / effort / …) once
 * it's spawned and the session handshake completes. The launcher, though, must
 * paint its option dropdowns *before* spawning anything. So we remember what each
 * agent advertised the last time it ran and seed the launcher from that — with no
 * separate probe spawn. `AcpSession` writes here on every handshake (and on every
 * live config change); `agents/profiles.ts` reads here to fill a profile's option
 * lists (see `importCachedOptions`). A brand-new agent simply has no entry yet and
 * falls back to the hardcoded seed / bare `default` until its first session fills
 * the cache in.
 *
 * Best-effort: every fs touch is guarded, a missing / corrupt file reads as "no
 * cache". Stored at `$XDG_STATE_HOME/zym/acp-options.json` — the same XDG state
 * base `SessionManager` uses (honours `XDG_STATE_HOME` so tests can isolate it).
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';

/** One approval/permission mode the agent advertised (ACP `SessionMode`). */
export interface CachedMode {
  id: string;
  name: string;
  description?: string;
}

/** One selectable value of a `select` config option. */
export interface CachedConfigChoice {
  value: string;
  name: string;
  description?: string;
}

/** One generic config option the agent advertised (ACP `SessionConfigOption`),
 *  minus the `mode` category — that rides the mode channel (`modes`) instead. */
export interface CachedConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  kind: 'select' | 'boolean';
  /** The value selected when the snapshot was taken (a value id, or a boolean). */
  current: string | boolean;
  /** Selectable values (`select` only). */
  choices?: CachedConfigChoice[];
}

/** What an agent advertised, as remembered for the next launch. */
export interface CachedAgentOptions {
  modes?: CachedMode[];
  currentModeId?: string;
  configOptions?: CachedConfigOption[];
}

/** The whole cache file: agent argv (joined by a space) → its last-seen options. */
type CacheFile = Record<string, CachedAgentOptions>;

/** The argv is the cache key — the exact command distinguishes one agent (and one
 *  configuration of it) from another. */
function keyFor(command: string[]): string {
  return command.join(' ');
}

function cacheFilePath(): string {
  const base = process.env.XDG_STATE_HOME || Path.join(Os.homedir(), '.local', 'state');
  return Path.join(base, 'zym', 'acp-options.json');
}

function readFile(): CacheFile {
  try {
    const parsed = JSON.parse(Fs.readFileSync(cacheFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as CacheFile) : {};
  } catch {
    return {}; // missing or corrupt → no cache
  }
}

/** The options `command` advertised last time it ran, or undefined if never seen. */
export function readAcpOptionsCache(command: string[]): CachedAgentOptions | undefined {
  const entry = readFile()[keyFor(command)];
  return entry && typeof entry === 'object' ? entry : undefined;
}

/** Remember what `command` advertised (replacing its previous entry). Best-effort:
 *  a filesystem failure is swallowed — the cache is an optimization, never a
 *  correctness dependency. */
export function writeAcpOptionsCache(command: string[], options: CachedAgentOptions): void {
  try {
    const file = readFile();
    file[keyFor(command)] = options;
    const path = cacheFilePath();
    Fs.mkdirSync(Path.dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    Fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
    Fs.renameSync(tmp, path); // atomic replace
  } catch {
    /* best-effort */
  }
}
