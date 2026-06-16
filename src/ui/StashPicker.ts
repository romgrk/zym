/*
 * Stash picker — pick a stash to pop, apply, or drop.
 *
 * Lists stashes (`git stash list`) in the fuzzy picker and runs the chosen
 * action via `git/cli.ts`. Notifies when there are none, and reports the result.
 * (Stashing changes is the separate `git:stash-push` command.)
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { Icons } from './icons.ts';
import { quilx } from '../quilx.ts';
import {
  repoRoot,
  listStashes,
  stashPop,
  stashApply,
  stashDrop,
  type GitDone,
} from '../git/cli.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;
type StashAction = 'pop' | 'apply' | 'drop';

const RUN: Record<StashAction, (root: string, ref: string, onDone: GitDone) => void> = {
  pop: stashPop,
  apply: stashApply,
  drop: stashDrop,
};
const PAST: Record<StashAction, string> = { pop: 'popped', apply: 'applied', drop: 'dropped' };

export function openStashPicker(host: Overlay, cwd: string, action: StashAction): void {
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
  const stashes = listStashes(root);
  if (stashes.length === 0) {
    quilx.notifications.addInfo('No stashes');
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
      RUN[action](root, ref, (ok, _out, stderr) => {
        if (ok) quilx.notifications.addSuccess(`Stash ${PAST[action]}`);
        else quilx.notifications.addError(`Stash ${action} failed`, { detail: stderr.trim() });
      });
    },
  });
}
