/*
 * GitHub PR picker — pick a pull request and switch to its branch (`gh pr
 * checkout`).
 *
 * Fetches PR matches in every state (open / closed / merged) from `gh` as the
 * user types — a debounced server-side search (see github.ts). Filtering is
 * entirely server-side (a GitHub search and local fzy disagree on matches, so
 * the picker's local refine is off). Rows show "#<n> <title>" prefixed with a
 * colour-coded state glyph, the author as a muted detail. The host wires it to a
 * command.
 */
import Gtk from 'gi:Gtk-4.0';
import { openPicker, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup, escapeMarkup } from './proseMarkup.ts';
import { zym } from '../zym.ts';
import { repoRoot } from '../git.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { searchPullRequests, type GithubListItem, type PrState } from '../github.ts';
import type { GitRepo } from '../git.ts';
import { theme } from '../theme/theme.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Glyph + GitHub-style colour for each PR state (open green, merged purple,
// closed red), rendered in the bundled icon font ahead of the title.
const STATE_STYLE: Record<PrState, { glyph: string; color: string }> = {
  open: { glyph: NERDFONT.GIT.PULL_REQUEST, color: theme.ui.pr.open },
  merged: { glyph: NERDFONT.GIT.MERGE, color: theme.ui.pr.merged },
  closed: { glyph: NERDFONT.GIT.PULL_REQUEST, color: theme.ui.pr.closed },
};

export function stateGlyphMarkup(state: PrState): string {
  const { glyph, color } = STATE_STYLE[state];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span> `;
}

// A picker row carrying its PR (so `renderRow`/`onSelect` read it straight off
// the item — no shared map that a stale async response could clobber).
interface PrPickerItem extends PickerItem {
  pr: GithubListItem;
}

/** Pick a PR and switch to its branch (`gh pr checkout`). */
export function switchToGithubPrPicker(host: Overlay, cwd: string, git: GitRepo): void {
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
    fetch: (query, sink) => {
      searchPullRequests(
        root,
        query,
        (prs) => {
          sink.replace(
            prs.map((pr): PrPickerItem => ({
              value: String(pr.number), // PR number is unique
              text: `#${pr.number} ${pr.title}`,
              pr,
            })),
          );
        },
        'all',
        (message) => sink.error(`Could not list pull requests: ${message}`),
      );
    },
    // A colour-coded state glyph leads each row; the title is prose, the author a
    // muted detail. (`stateGlyphMarkup` is kept for GithubButtons; the row uses
    // the renderer's icon slot.)
    renderRow: (item, positions) => {
      const { pr } = item as PrPickerItem;
      const style = pr ? STATE_STYLE[pr.state] : undefined;
      return renderRowSingleLine({
        icon: style?.glyph,
        iconColor: style?.color,
        main: proseMarkup(item.text, positions),
        detail: pr?.author ? `@${pr.author}` : undefined,
      });
    },
    onSelect: (_value, item) => {
      const { pr } = item as PrPickerItem;
      if (!pr) return;
      // `git.checkoutPullRequest` runs `gh pr checkout` with busy + refresh
      // coordination (it can take seconds — switches branch, fetches forks).
      void git.checkoutPullRequest(pr.number).then((result) => {
        // Success is silent — only failures notify.
        if (result.isErr()) zym.notifications.addError('Could not switch to pull request', { detail: result.unwrapErr().message.trim() });
      });
    },
  });
}
