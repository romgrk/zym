/*
 * Branch pickers — quick-switchers over the repository's local branches.
 *
 * `openBranchPicker` switches (current branch marked; create-on-no-match);
 * `openDeleteBranchPicker` / `openMergeBranchPicker` act on a chosen other branch;
 * `openRenameBranchPicker` is an entry-only picker whose action renames the
 * current branch. All go through `git/cli.ts`; HEAD/working-tree changes make the
 * branch button and gutters update via `GitRepo.onChange`. Results surface
 * through `quilx.notifications`.
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup } from './Picker.ts';
import { Icons } from './icons.ts';
import { quilx } from '../quilx.ts';
import {
  repoRoot,
  currentBranch,
  listBranches,
  switchBranch,
  createBranch,
  deleteBranch,
  mergeBranch,
  renameBranch,
  type GitDone,
} from '../git/cli.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openBranchPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: 'Switch branch…',
      promptIcon: Icons.git,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  const current = currentBranch(root);
  const branches = listBranches(root); // includes the current branch (marked below)

  openPicker({
    host,
    placeholder: 'Switch branch…',
    promptIcon: Icons.git,
    items: branches,
    // Highlight the fuzzy match; tag the current branch with a muted "current".
    // Branch names are identifiers — render them in the picker's (app) monospace
    // font rather than the prose/sans face.
    formatMain: (item, positions) => {
      const main = highlightMarkup(item.text, positions);
      return item.value === current ? { main, detail: 'current' } : main;
    },
    onSelect: (branch) => {
      if (branch === current) return; // already here — nothing to do
      switchBranch(root, branch, report(`Switched to ${branch}`));
    },
    // Always offer to create the typed name off HEAD — shown after any matches
    // (whenever the query is non-empty), so it's available even when branches match.
    action: {
      label: (query) => `Create branch: ${query.trim()}`,
      run: (query) => {
        const name = query.trim();
        if (name) createBranch(root, name, report(`Created branch ${name}`));
      },
    },
  });
}

/** Pick another branch (not the current one) to delete. */
export function openDeleteBranchPicker(host: Overlay, cwd: string): void {
  pickOtherBranch(host, cwd, 'Delete branch…', Icons.trash, (root, branch) =>
    deleteBranch(root, branch, report(`Deleted branch ${branch}`)),
  );
}

/** Pick another branch to merge into the current one. */
export function openMergeBranchPicker(host: Overlay, cwd: string): void {
  pickOtherBranch(host, cwd, 'Merge branch into current…', Icons.gitMerge, (root, branch) =>
    mergeBranch(root, branch, report(`Merged ${branch}`)),
  );
}

/** Rename the current branch: an entry-only picker whose action does the rename. */
export function openRenameBranchPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: 'Rename current branch to…',
      promptIcon: Icons.pencil,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  const current = currentBranch(root);
  openPicker({
    host,
    placeholder: 'Rename current branch to…',
    promptIcon: Icons.pencil,
    items: [], // no list — just the entry + action
    query: current ?? '',
    onSelect: () => {}, // never called (no items); the action does the rename
    action: {
      label: (query) => `Rename to: ${query.trim()}`,
      run: (query) => {
        const name = query.trim();
        if (name && name !== current) renameBranch(root, name, report(`Renamed to ${name}`));
      },
    },
  });
}

// Shared: pick a branch other than the current one, then run `onPick`.
function pickOtherBranch(
  host: Overlay,
  cwd: string,
  placeholder: string,
  promptIcon: string,
  onPick: (root: string, branch: string) => void,
): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({ host, placeholder, promptIcon, onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  const current = currentBranch(root);
  const branches = listBranches(root).filter((b) => b !== current);
  if (branches.length === 0) {
    quilx.notifications.addInfo('No other branches');
    return;
  }
  openPicker({
    host,
    placeholder,
    promptIcon,
    items: branches,
    onSelect: (branch) => onPick(root, branch),
  });
}

// Report a git result: success message, or an error with git's stderr.
function report(success: string): GitDone {
  return (ok, _stdout, stderr) => {
    if (ok) quilx.notifications.addSuccess(success);
    else quilx.notifications.addError('Git operation failed', { detail: stderr.trim() });
  };
}
