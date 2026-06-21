/*
 * GitHub CI-checks picker — list the current branch PR's CI runs and open one in
 * the browser.
 *
 * The picker opens immediately (with a loading state) and fills in once `gh pr
 * checks` resolves (see github.ts). Each row is prefixed with a state glyph
 * (failed ✗ red / pending ● amber / passed ✓ green); failed runs are weighted to
 * the top (then pending, then passed). Choosing a run opens its page in the
 * browser. The GitHub mark is the prompt icon (and the loading spinner's home).
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup, type PickerItem } from './Picker.ts';
import { openUrl } from './openUrl.ts';
import { repoRoot } from '../git.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { fetchChecks, type CiCheck, type CheckState } from '../github.ts';
import { theme } from '../theme/theme.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Glyph + colour per check state — the same check / dot / cross icons (in
// success / warning / error) the header CI button uses.
const CHECK_STYLE: Record<CheckState, { glyph: string; color: string }> = {
  pass: { glyph: NERDFONT.STATUS.CHECK, color: theme.ui.status.success },
  pending: { glyph: NERDFONT.STATUS.DOT, color: theme.ui.status.warning },
  fail: { glyph: NERDFONT.STATUS.CROSS, color: theme.ui.status.error },
};

// Sort/weight key: failed first, then pending, then passed.
const STATE_RANK: Record<CheckState, number> = { fail: 2, pending: 1, pass: 0 };

function stateGlyphMarkup(state: CheckState): string {
  const { glyph, color } = CHECK_STYLE[state];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span> `;
}

// A picker row carrying its check, so weight/formatMain read it off the item.
interface CiCheckItem extends PickerItem {
  check: CiCheck;
}

/** Pick one of the current branch PR's CI checks and open it in the browser. */
export function openGithubCIChecksPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: 'Open CI check…',
      promptIcon: Icons.github,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  // Open immediately with a loading state; fill in once `gh pr checks` resolves.
  const picker = openPicker({
    host,
    placeholder: 'Open CI check…',
    promptIcon: Icons.github, // doubles as the home for the loading spinner
    loading: true,
    items: [],
    // Float failed runs to the top (then pending), and bias them up once a
    // query is typed too.
    weight: (item) => STATE_RANK[(item as CiCheckItem).check.state],
    formatMain: (item, positions) =>
      stateGlyphMarkup((item as CiCheckItem).check.state) + highlightMarkup(item.text, positions),
    onSelect: (url) => openUrl(url),
  });
  fetchChecks(root, (checks) => {
    picker.setItems(
      checks.map((check): CiCheckItem => ({
        value: check.url, // the run/job URL is unique (deduped in fetchChecks)
        text: check.name,
        check,
      })),
    );
  });
}
