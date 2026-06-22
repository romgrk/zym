/*
 * Worktree picker — choose which git worktree to launch an agent in.
 *
 * Lists every worktree of the repo (the main checkout first, then linked ones
 * from `git worktree add`); selecting one calls `onChoose(path)`, and the host
 * launches a new agent rooted there — that path becomes the agent's workbench
 * cwd, file tree, and git (see docs/agents.md "git worktree integration"). The
 * agent itself still creates *new* worktrees; this only picks existing ones.
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { Icons } from './icons.ts';
import { listWorktrees } from '../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Open a picker over the repo's worktrees; `onChoose` gets the chosen root. */
export function openWorktreePicker(host: Overlay, cwd: string, onChoose: (path: string) => void): void {
  const worktrees = listWorktrees(cwd);
  if (worktrees.length === 0) {
    openPicker({
      host,
      placeholder: 'Start agent in worktree…',
      promptIcon: Icons.git,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  type Worktree = (typeof worktrees)[number];

  openPicker({
    host,
    placeholder: 'Start agent in worktree…',
    promptIcon: Icons.git,
    // Carry each worktree on its item so the row reads it off `data` directly.
    items: worktrees.map((w) => ({ value: w.path, text: w.name, data: w })),
    // Highlight the fuzzy match on the worktree name; tag the branch in the detail
    // column, and mark the main checkout so it's distinguishable from linked ones.
    renderRow: (item, positions) => {
      const w = item.data as Worktree;
      const branch = w.branch ?? 'detached';
      return renderRowSingleLine({
        main: highlightMarkup(item.text, positions),
        detail: w.linked ? branch : `${branch} · main`,
      });
    },
    onSelect: (path) => onChoose(path),
  });
}
