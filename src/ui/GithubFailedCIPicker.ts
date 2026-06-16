/*
 * GitHub failed-CI picker — pick a failed CI run of the current branch's PR to
 * open in the browser.
 *
 * Fetches the failed checks via `gh` (see git/github.ts). With none, it notifies;
 * with exactly one, it opens it directly (no picker); with several, it opens the
 * fuzzy picker over the check names and opens the chosen run.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { openUrl } from './openUrl.ts';
import { quilx } from '../quilx.ts';
import { repoRoot } from '../git/cli.ts';
import { fetchFailedChecks } from '../git/github.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openGithubFailedCIPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({ host, placeholder: 'Open failed CI run…', onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  fetchFailedChecks(root, (checks) => {
    if (checks.length === 0) {
      quilx.notifications.addInfo('No failed CI runs');
      return;
    }
    if (checks.length === 1) {
      openUrl(checks[0].url);
      return;
    }
    // Several: pick one. Check names aren't unique (matrix jobs), so disambiguate
    // the label and map it back to the run URL.
    const byLabel = new Map<string, string>();
    const items: string[] = [];
    for (const check of checks) {
      const label = uniqueLabel(byLabel, check.name);
      byLabel.set(label, check.url);
      items.push(label);
    }
    openPicker({
      host,
      placeholder: 'Open failed CI run…',
      items,
      onSelect: (label) => {
        const url = byLabel.get(label);
        if (url) openUrl(url);
      },
    });
  });
}

/** Make `label` unique against already-used labels by appending " (2)", " (3)", … */
function uniqueLabel(used: Map<string, unknown>, label: string): string {
  if (!used.has(label)) return label;
  let n = 2;
  while (used.has(`${label} (${n})`)) n++;
  return `${label} (${n})`;
}
