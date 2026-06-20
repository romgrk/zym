/*
 * Branch pickers — quick-switchers over the repository's local branches.
 *
 * `openBranchPicker` switches (current branch marked; create-on-no-match);
 * `openDeleteBranchPicker` / `openMergeBranchPicker` act on a chosen other branch;
 * `openRenameBranchPicker` is an entry-only picker whose action renames the
 * current branch. All go through the git facade (`git.ts`); HEAD/working-tree changes make the
 * branch button and gutters update via `GitRepo.onChange`. Results surface
 * through `quilx.notifications`.
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup } from './Picker.ts';
import { Icons } from './icons.ts';
import { quilx } from '../quilx.ts';
import { repoRoot, listBranches, type GitRepo, type GitOpResult } from '../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openBranchPicker(host: Overlay, cwd: string, git: GitRepo): void {
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
  const current = git.getBranch(); // the cached current branch (no spawn)
  listBranches(root, (branches) => {
    // includes the current branch (marked below)
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
        void git.switchBranch(branch).then(report(`Switched to ${branch}`));
      },
      // Always offer to create the typed name off HEAD — shown after any matches
      // (whenever the query is non-empty), so it's available even when branches match.
      action: {
        label: (query) => `Create branch: ${query.trim()}`,
        run: (query) => {
          const name = query.trim();
          if (name) void git.createBranch(name).then(report(`Created branch ${name}`));
        },
      },
    });
  });
}

/** Pick another branch (not the current one) to delete. */
export function openDeleteBranchPicker(host: Overlay, cwd: string, git: GitRepo): void {
  pickOtherBranch(host, cwd, git, 'Delete branch…', Icons.trash, (branch) =>
    void git.deleteBranch(branch).then(report(`Deleted branch ${branch}`)),
  );
}

/** Pick another branch to merge into the current one. */
export function openMergeBranchPicker(host: Overlay, cwd: string, git: GitRepo): void {
  pickOtherBranch(host, cwd, git, 'Merge branch into current…', Icons.gitMerge, (branch) =>
    void git.mergeBranch(branch).then(report(`Merged ${branch}`)),
  );
}

/** Rename the current branch: an entry-only picker whose action does the rename. */
export function openRenameBranchPicker(host: Overlay, cwd: string, git: GitRepo): void {
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
  const current = git.getBranch();
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
        if (name && name !== current) void git.renameBranch(name).then(report(`Renamed to ${name}`));
      },
    },
  });
}

// Shared: pick a branch other than the current one, then run `onPick`.
function pickOtherBranch(
  host: Overlay,
  cwd: string,
  git: GitRepo,
  placeholder: string,
  promptIcon: string,
  onPick: (branch: string) => void,
): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({ host, placeholder, promptIcon, onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  const current = git.getBranch();
  listBranches(root, (all) => {
    const branches = all.filter((b) => b !== current);
    if (branches.length === 0) {
      quilx.notifications.addInfo('No other branches');
      return;
    }
    openPicker({
      host,
      placeholder,
      promptIcon,
      items: branches,
      onSelect: (branch) => onPick(branch),
    });
  });
}

// Report a coordinated git operation's result: success message, or an error with
// git's stderr. (Busy/refresh is handled by the GitRepo method itself.) Pass it to
// the mutation promise's `.then`.
function report(success: string): (result: GitOpResult) => void {
  return (result) => {
    if (result.isOk()) quilx.notifications.addSuccess(success);
    else quilx.notifications.addError('Git operation failed', { detail: result.unwrapErr().message.trim() });
  };
}
