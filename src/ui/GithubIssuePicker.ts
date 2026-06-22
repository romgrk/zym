/*
 * GitHub issue picker — pick an open issue to open in the browser.
 *
 * Lists open issues via `gh` (see github.ts) and opens the fuzzy picker over
 * "#<n> <title>" with the author as a muted detail. Notifies when gh is
 * unavailable or there are no open issues.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup } from './proseMarkup.ts';
import { openUrl } from './openUrl.ts';
import { zym } from '../zym.ts';
import { repoRoot } from '../git.ts';
import { fetchIssues } from '../github.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openGithubIssuePicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({ host, placeholder: 'Open issue…', onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  fetchIssues(root, (issues) => {
    if (issues.length === 0) {
      zym.notifications.addInfo('No open issues');
      return;
    }
    const items = issues.map((issue) => ({
      value: issue.url,
      text: `#${issue.number} ${issue.title}`,
      data: issue.author,
    }));
    openPicker({
      host,
      placeholder: 'Open issue…',
      items,
      renderRow: (item, positions) => {
        const main = proseMarkup(item.text, positions);
        const author = item.data as string | undefined;
        return renderRowSingleLine(author ? { main, detail: `@${author}` } : { main });
      },
      onSelect: (url) => openUrl(url),
    });
  });
}
