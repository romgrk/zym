/*
 * Diff collapse-by-glob prompt — collapse every file in the *current* continuous diff whose path
 * matches a glob (`z x`).
 *
 * A bare text prompt (no candidate list — `hideMatches`): the entry is a **comma-separated glob
 * filter** (each term `!`-prefixed to negate — e.g. `src/**, *.ts, !*.test.ts`), and the single
 * `action` row shows the live match count and, on Enter, collapses them all and returns focus to the
 * diff editor (the picker closes without restoring focus itself — see `FloatingCard.close`). Opened
 * over the diff editor.
 */
import Gtk from 'gi:Gtk-4.0';
import { openPicker } from './Picker.ts';
import { NERDFONT } from './nerdfont.ts';
import type { DiffView } from './DiffView.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Open the collapse-by-glob prompt over `diff`; collapses every matching file on Enter. */
export function openDiffCollapseGlobPicker(host: Overlay, diff: DiffView): void {
  if (diff.fileList().length === 0) return;

  openPicker({
    host,
    anchor: { to: diff.root }, // centre over the diff editor, not the whole window
    dim: false, // sit over the diff without darkening it
    placeholder: 'Collapse files matching glob — e.g.  src/**, *.ts, !*.test.ts',
    promptIcon: NERDFONT.NAV.CHEVRON_RIGHT, // the collapsed-file chevron
    searchDelay: 0, // recompute the match count synchronously on every keystroke
    hideMatches: true, // a bare glob prompt — no candidate list, just the entry + the action row
    onSelect: () => {}, // unused (no candidate rows); the `action` carries the behaviour
    action: {
      label: (query) => {
        const n = diff.filesMatching(query).length;
        return `Collapse ${n} matching file${n === 1 ? '' : 's'}`;
      },
      run: (query) => {
        diff.collapseFilesMatching(query);
        diff.focus(); // the picker closed without restoring focus — hand it back to the diff
      },
    },
  });
}
