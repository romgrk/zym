/*
 * GitHub issue picker — pick an open issue to open in the browser.
 *
 * Lists open issues via `gh` (see git/github.ts) and opens the fuzzy picker over
 * "#<n> <title>" with the author as a muted detail. Notifies when gh is
 * unavailable or there are no open issues.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup } from './proseMarkup.ts';
import { openUrl } from './openUrl.ts';
import { quilx } from '../quilx.ts';
import { repoRoot } from '../git/cli.ts';
import { fetchIssues } from '../git/github.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openGithubIssuePicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({ host, placeholder: 'Open issue…', onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  fetchIssues(root, (issues) => {
    if (issues.length === 0) {
      quilx.notifications.addInfo('No open issues');
      return;
    }
    const authorByUrl = new Map<string, string>();
    const items = issues.map((issue) => {
      authorByUrl.set(issue.url, issue.author);
      return { value: issue.url, text: `#${issue.number} ${issue.title}` };
    });
    openPicker({
      host,
      placeholder: 'Open issue…',
      items,
      formatMain: (item, positions) => {
        const main = proseMarkup(item.text, positions);
        const author = authorByUrl.get(item.value);
        return author ? { main, detail: `@${author}` } : main;
      },
      onSelect: (url) => openUrl(url),
    });
  });
}
