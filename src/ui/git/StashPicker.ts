/*
 * Stash picker — pick a stash to pop, apply, or drop.
 *
 * Lists stashes (`git stash list`) in the fuzzy picker and runs the chosen
 * action via the git facade (`git.ts`). Notifies when there are none, and reports the result.
 * (Stashing changes is the separate `git:stash-push` command.)
 */
import Gtk from 'gi:Gtk-4.0';
import { openPicker } from '../Picker.ts';
import { Icons } from '../icons.ts';
import { zym } from '../../zym.ts';
import { repoRoot, listStashes, type GitRepo, type GitOpResult } from '../../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;
type StashAction = 'pop' | 'apply' | 'drop';

// Each action maps to the coordinated GitRepo method (busy + refresh handled there).
const RUN: Record<StashAction, (git: GitRepo, ref: string) => Promise<GitOpResult>> = {
  pop: (git, ref) => git.stashPop(ref),
  apply: (git, ref) => git.stashApply(ref),
  drop: (git, ref) => git.stashDrop(ref),
};

export function openStashPicker(host: Overlay, cwd: string, action: StashAction, git: GitRepo): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: `Stash to ${action}…`,
      promptIcon: Icons.stash,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  listStashes(root, (stashes) => {
    if (stashes.length === 0) {
      zym.notifications.addInfo('No stashes');
      return;
    }
    // value = stash ref ("stash@{N}"); the description is what's matched/shown.
    const refByLabel = new Map<string, string>();
    const items = stashes.map((s) => {
      const label = s.description || s.ref;
      refByLabel.set(label, s.ref);
      return { value: label, text: label };
    });
    openPicker({
      host,
      placeholder: `Stash to ${action}…`,
      promptIcon: action === 'drop' ? Icons.trash : Icons.stash,
      items,
      onSelect: (label) => {
        const ref = refByLabel.get(label);
        if (!ref) return;
        void RUN[action](git, ref).then((result) => {
          // Success is silent — only failures notify.
          if (result.isErr()) zym.notifications.addError(`Stash ${action} failed`, { detail: result.unwrapErr().message.trim() });
        });
      },
    });
  });
}
