/*
 * projectSettings — the per-project settings file at `<cwd>/.zym/settings.json`, checked into
 * the repo and editable by the user. One file holds every per-project setting:
 *   - `actions`: the workbench's default runnable actions (see actions.ts for the vocabulary);
 *   - `search.presets`: named, options-only project-search presets (e.g. "Code" = exclude
 *     tests/docs), layered under a few built-ins (`BUILTIN_SEARCH_PRESETS`).
 * Reads are tolerant (missing / malformed → empty); writes preserve the rest of the file.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { parseActions, type Action } from './actions.ts';
import type { ProjectSearchOptions } from './ui/multibuffer/projectSearch.ts';

/** A named, options-only project-search preset (the query is always typed fresh). */
export interface SearchPreset {
  name: string;
  options: ProjectSearchOptions;
}

/** The normalized contents of the settings file (each section empty when absent). */
export interface ProjectSettings {
  actions: Action[];
  searchPresets: SearchPreset[];
}

/** Built-in presets offered in every project (overridable per-project by same-name presets). */
export const BUILTIN_SEARCH_PRESETS: readonly SearchPreset[] = [
  { name: 'Code', options: { globs: ['!*.test.*', '!*.spec.*', '!*.snap', '!*.md', '!docs/**'] } },
  { name: 'Tests', options: { globs: ['*.test.*', '*.spec.*'] } },
  { name: 'Docs', options: { globs: ['*.md', 'docs/**'] } },
];

/** Absolute path of a workbench root's settings file (`<cwd>/.zym/settings.json`). */
export function projectSettingsPath(cwd: string): string {
  return Path.join(cwd, '.zym', 'settings.json');
}

/** Read + JSON-parse the settings file into a plain object, or null when missing / unreadable /
 *  malformed / not an object (the file is optional). */
function readRaw(cwd: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = Fs.readFileSync(projectSettingsPath(cwd), 'utf8');
  } catch {
    return null;
  }
  if (text.trim() === '') return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeRaw(cwd: string, obj: Record<string, unknown>): void {
  const path = projectSettingsPath(cwd);
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/** The whole settings file, normalized. */
export function readProjectSettings(cwd: string): ProjectSettings {
  const raw = readRaw(cwd);
  const search = raw?.search;
  const presets = search && typeof search === 'object' ? (search as Record<string, unknown>).presets : undefined;
  return { actions: parseActions(raw?.actions), searchPresets: parseSearchPresets(presets) };
}

/** Just the action set (the common case for WorkbenchActions). */
export function readProjectActions(cwd: string): Action[] {
  return readProjectSettings(cwd).actions;
}

/** The presets offered for `cwd`: the project's own, then any built-ins it didn't override. */
export function projectSearchPresets(cwd: string): SearchPreset[] {
  const own = readProjectSettings(cwd).searchPresets;
  const taken = new Set(own.map((p) => p.name.toLowerCase()));
  return [...own, ...BUILTIN_SEARCH_PRESETS.filter((p) => !taken.has(p.name.toLowerCase()))];
}

/** Save (add or replace by name) a project search preset, leaving the rest of the file intact. */
export function saveSearchPreset(cwd: string, preset: SearchPreset): void {
  const raw = readRaw(cwd) ?? {};
  const search = raw.search && typeof raw.search === 'object' ? (raw.search as Record<string, unknown>) : {};
  const presets = Array.isArray(search.presets) ? [...search.presets] : [];
  const entry = { name: preset.name, options: preset.options };
  const idx = presets.findIndex((p) => p && typeof p === 'object' && (p as { name?: unknown }).name === preset.name);
  if (idx >= 0) presets[idx] = entry;
  else presets.push(entry);
  search.presets = presets;
  raw.search = search;
  writeRaw(cwd, raw);
}

/** Remove a project search preset by name (no-op if absent). Built-ins can't be deleted. */
export function deleteSearchPreset(cwd: string, name: string): void {
  const raw = readRaw(cwd);
  const search = raw?.search;
  if (!search || typeof search !== 'object') return;
  const presets = (search as Record<string, unknown>).presets;
  if (!Array.isArray(presets)) return;
  (search as Record<string, unknown>).presets = presets.filter(
    (p) => !(p && typeof p === 'object' && (p as { name?: unknown }).name === name),
  );
  writeRaw(cwd, raw!);
}

/** Normalize a raw `search.presets` value into validated presets (each needs a non-empty,
 *  unique name; options are coerced field-by-field). Malformed input yields an empty list. */
export function parseSearchPresets(raw: unknown): SearchPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchPreset[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; options?: unknown };
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, options: normalizeOptions(e.options) });
  }
  return out;
}

function normalizeOptions(raw: unknown): ProjectSearchOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const options: ProjectSearchOptions = {};
  if (typeof o.caseSensitive === 'boolean') options.caseSensitive = o.caseSensitive;
  if (typeof o.wholeWord === 'boolean') options.wholeWord = o.wholeWord;
  if (typeof o.regex === 'boolean') options.regex = o.regex;
  if (typeof o.includeIgnored === 'boolean') options.includeIgnored = o.includeIgnored;
  const globs = toStringArray(o.globs);
  if (globs.length) options.globs = globs;
  return options;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

// The seed for a new settings file (opened by `workbench:action-edit`): a self-documenting
// example with one action and one search preset.
const SEED_SETTINGS = `{
  "actions": [
    { "label": "Start app", "command": "pnpm run start", "terminal": true }
  ],
  "search": {
    "presets": [
      { "name": "Code", "options": { "globs": ["!*.test.*", "!docs/**"] } }
    ]
  }
}
`;

/** Seed `<cwd>/.zym/settings.json` with the example if absent, so the edit command always opens
 *  an editable, self-documenting file. Returns the path (best-effort on write failure). */
export function ensureProjectSettingsFile(cwd: string): string {
  const path = projectSettingsPath(cwd);
  try {
    if (!Fs.existsSync(path)) {
      Fs.mkdirSync(Path.dirname(path), { recursive: true });
      Fs.writeFileSync(path, SEED_SETTINGS);
    }
  } catch {
    /* best effort — the editor reports an unopenable path */
  }
  return path;
}
