/*
 * actions.ts — the tool-agnostic vocabulary for "workbench actions": a label + a
 * shell command the user (or an agent) registers so it can be run, tested, or
 * reviewed outside the chat (start the dev server, run the suite, open the app).
 * The editor surfaces them as buttons in an agent conversation and as the
 * `workbench:action-*` commands / picker (`space x`).
 *
 * Actions are **per-workbench** and first-class (see docs/workbench.md):
 *   - the project's default set lives in `<cwd>/.zym/settings.json` under `actions`
 *     (read via `projectSettings.ts`), editable by the user;
 *   - each live workbench holds its own mutable copy, seeded from that file;
 *   - an agent can overwrite its workbench's set via the `set_actions` bridge tool
 *     (assets/mcp/zymBridge.mjs), which writes the raw JSON to an IPC file the host
 *     reads and `parseActions` normalizes into the shape below.
 * The first action is the default (no explicit flag). The runtime owner of the
 * per-workbench copy is `WorkbenchActions`. This module is just the value
 * vocabulary — the settings-file I/O lives in `projectSettings.ts`.
 */

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

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
