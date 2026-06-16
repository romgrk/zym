/*
 * GitHub PR picker — pick a pull request and switch to its branch (`gh pr
 * checkout`).
 *
 * Fetches PR matches in every state (open / closed / merged) from `gh` as the
 * user types — a debounced server-side search (see git/github.ts). Filtering is
 * entirely server-side (a GitHub search and local fzy disagree on matches, so
 * the picker's local refine is off). Rows show "#<n> <title>" prefixed with a
 * colour-coded state glyph, the author as a muted detail. The host wires it to a
 * command.
 */
import { Gtk } from '../gi.ts';
import { openPicker, type PickerItem } from './Picker.ts';
import { proseMarkup, escapeMarkup } from './proseMarkup.ts';
import { quilx } from '../quilx.ts';
import { repoRoot } from '../git/cli.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { Icons } from './icons.ts';
import { searchPullRequests, checkoutPullRequest, type GithubListItem, type PrState } from '../git/github.ts';
import { theme } from '../theme/theme.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Octicon glyph + GitHub-style colour for each PR state (open green, merged
// purple, closed red), rendered in the bundled icon font ahead of the title.
const STATE_STYLE: Record<PrState, { glyph: string; color: string }> = {
  open: { glyph: String.fromCodePoint(0xf407), color: theme.ui.prOpen }, // git-pull-request
  merged: { glyph: String.fromCodePoint(0xf419), color: theme.ui.prMerged }, // git-merge
  closed: { glyph: String.fromCodePoint(0xf407), color: theme.ui.prClosed }, // git-pull-request
};

export function stateGlyphMarkup(state: PrState): string {
  const { glyph, color } = STATE_STYLE[state];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span> `;
}

// A picker row carrying its PR (so `formatMain`/`onSelect` read it straight off
// the item — no shared map that a stale async response could clobber).
interface PrPickerItem extends PickerItem {
  pr: GithubListItem;
}

/** Pick a PR and switch to its branch (`gh pr checkout`). */
export function switchToGithubPrPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: 'Switch to pull request…',
      promptIcon: Icons.github,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  openPicker({
    host,
    placeholder: 'Switch to pull request…',
    promptIcon: Icons.github, // doubles as the home for the fetch spinner
    // Filter entirely via `gh` search (debounced): a GitHub search and local fzy
    // disagree on what matches, so don't refine locally — show what `gh` returns.
    localFilter: false,
    fetch: (query, onResult, onError) => {
      searchPullRequests(
        root,
        query,
        (prs) => {
          onResult(
            prs.map((pr): PrPickerItem => ({
              value: String(pr.number), // PR number is unique
              text: `#${pr.number} ${pr.title}`,
              pr,
            })),
          );
        },
        'all',
        (message) => onError(`Could not list pull requests: ${message}`),
      );
    },
    formatMain: (item, positions) => {
      const { pr } = item as PrPickerItem;
      const main = (pr ? stateGlyphMarkup(pr.state) : '') + proseMarkup(item.text, positions);
      return pr && pr.author ? { main, detail: `@${pr.author}` } : { main };
    },
    onSelect: (_value, item) => {
      const { pr } = item as PrPickerItem;
      if (!pr) return;
      checkoutPullRequest(root, pr.number, (ok, stderr) => {
        if (ok) quilx.notifications.addSuccess(`Switched to PR #${pr.number}`);
        else quilx.notifications.addError('Could not switch to pull request', { detail: stderr.trim() });
      });
    },
  });
}
