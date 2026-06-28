/*
 * actions.ts — the tool-agnostic vocabulary for "workbench actions": a label + a
 * shell command the user (or an agent) registers so it can be run, tested, or
 * reviewed outside the chat (start the dev server, run the suite, open the app).
 * The editor surfaces them as buttons in an agent conversation and as the
 * `workbench:action-*` commands / picker (`space x`).
 *
 * Actions are **per-workbench** and first-class (see docs/workbench.md):
 *   - the project's default set lives in `<cwd>/.zym/actions.json`
 *     (`projectActionsPath` / `readProjectActions`), editable by the user;
 *   - each live workbench holds its own mutable copy, seeded from that file;
 *   - an agent can overwrite its workbench's set via the `set_actions` bridge tool
 *     (assets/mcp/zymBridge.mjs), which writes the raw JSON to an IPC file the host
 *     reads and `parseActions` normalizes into the shape below.
 * The first action is the default (no explicit flag). The runtime owner of the
 * per-workbench copy is `WorkbenchActions`.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';

/** A runnable action registered with a workbench. */
export interface Action {
  /** Stable id (slug of the label), used by the run commands and dedup. */
  id: string;
  /** Short button / command label. */
  label: string;
  /** The shell command the editor runs in the workbench's cwd. */
  command: string;
  /** Where the command runs: `true` (default) opens a terminal tab; `false` runs
   *  it as a background process the button can stop (no terminal widget). */
  terminal: boolean;
}

/**
 * Normalize whatever produced the actions (an array, or `{ actions: […] }` — the
 * `set_actions` tool and the project file both use these shapes) into a validated
 * `Action[]`: each entry needs a non-empty `label` and `command`; ids are
 * slugified from the label (deduped with a numeric suffix). The first action is
 * the default. A malformed / empty payload yields an empty list.
 */
export function parseActions(raw: unknown): Action[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { actions?: unknown }).actions)
      ? (raw as { actions: unknown[] }).actions
      : [];

  const used = new Set<string>();
  const actions: Action[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { label?: unknown; command?: unknown; terminal?: unknown };
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const command = typeof e.command === 'string' ? e.command.trim() : '';
    if (!label || !command) continue;
    const id = uniqueId(slugify(label) || 'action', used);
    actions.push({ id, label, command, terminal: e.terminal !== false });
  }
  return actions;
}

/** The default action of a set — the first one, or null when empty. */
export function defaultAction(actions: readonly Action[] | undefined): Action | null {
  return actions?.[0] ?? null;
}

/** Absolute path of a workbench root's project actions file (`<cwd>/.zym/actions.json`). */
export function projectActionsPath(cwd: string): string {
  return Path.join(cwd, '.zym', 'actions.json');
}

/** Read + parse the project default actions for `cwd`, or `[]` when the file is
 *  missing / unreadable / malformed (the file is optional). */
export function readProjectActions(cwd: string): Action[] {
  let text: string;
  try {
    text = Fs.readFileSync(projectActionsPath(cwd), 'utf8');
  } catch {
    return []; // no project file (the common case) — no defaults
  }
  if (text.trim() === '') return [];
  try {
    return parseActions(JSON.parse(text));
  } catch {
    return []; // malformed JSON — treat as no defaults
  }
}

/** Seed `<cwd>/.zym/actions.json` with an example set if it doesn't exist yet, so
 *  `workbench:action-edit` always opens an editable, self-documenting file.
 *  Returns the path. Best-effort — a write failure still returns the path. */
export function ensureProjectActionsFile(cwd: string): string {
  const path = projectActionsPath(cwd);
  try {
    if (!Fs.existsSync(path)) {
      Fs.mkdirSync(Path.dirname(path), { recursive: true });
      Fs.writeFileSync(path, SEED_ACTIONS);
    }
  } catch {
    /* best effort — the editor reports an unopenable path */
  }
  return path;
}

// The seed for a new project actions file: a JSON array of
// `{ label, command, terminal? }`. `terminal` defaults to true (a terminal tab);
// set it false to run in the background with a stop button.
const SEED_ACTIONS = `[
  { "label": "Start app", "command": "pnpm run start", "terminal": true }
]
`;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
