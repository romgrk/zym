/*
 * GitBranchButton — a header-bar indicator showing the repository's current git
 * branch (e.g. " master") plus a working-tree overview: "+N" inserted lines in
 * green and "-M" deleted lines in red (untracked files counted as insertions),
 * and the upstream delta "↑N"/"↓M" (commits ahead/behind). Each count is hidden
 * when zero. While a git operation is in flight (`GitRepo.isBusy`) the branch
 * icon is replaced by a spinner. It reads from an injected `GitRepo` and
 * refreshes on `GitRepo.onChange`; outside a repo it hides itself.
 *
 * A flat button; clicking it invokes `onClicked` (the host opens the branch
 * picker). The assembled widget is exposed via `root`.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import { ICON_FONT_FAMILY } from '../../fonts.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { NERDFONT } from '../nerdfont.ts';
import type { GitRepo } from '../../git.ts';

// Branch glyph, with a warning triangle shown instead while the working tree has
// merge conflicts. Bundled "Symbols Nerd Font Mono" (see fonts.ts).
const BRANCH_GLYPH = NERDFONT.GIT.BRANCH;
const CONFLICT_GLYPH = NERDFONT.STATUS.WARNING;

// Count colors in the theme palette (fallbacks are Adwaita's): working-tree
// insertions/deletions in success/error; upstream ahead in info, behind in
// warning, and both (a diverged branch) in danger/error.
const COLOR_ADDED = theme.ui.status.success;
const COLOR_REMOVED = theme.ui.status.error;
const COLOR_INFO = theme.ui.status.info;
const COLOR_WARNING = theme.ui.status.warning;
const COLOR_DANGER = theme.ui.status.error;

// The conflict icon is error-colored.
addStyles(`
  .zym-conflict { color: var(--t-ui-status-error); }
`);

// A "+N"/"-M"/"↑N"/"↓M" count, as an inline markup span: a smaller, coloured run
// after a normal-size separating space. Rendered inside the branch-name label so
// Pango baseline-aligns the smaller text with the full-size name (separate, CSS-
// shrunk labels can't share a baseline through the button and ride up too high).
// Empty when the count is zero.
function countSpan(sign: string, count: number, color: string): string {
  if (count <= 0) return '';
  return ` <span foreground="${color}" size="smaller">${sign}${count}</span>`;
}

export class GitBranchButton {
  readonly root: InstanceType<typeof Gtk.Button>;

  // The git repo this button reflects — swapped via `setRepo` when the active
  // workbench changes (per-workbench roots; see docs/agents.md).
  private repo: GitRepo;
  private readonly icon: InstanceType<typeof Gtk.Label>;
  private readonly spinner: InstanceType<typeof Gtk.Spinner>;
  // Branch name plus the working-tree/upstream counts, as one markup label (so
  // the smaller count spans baseline-align with the name — see `countSpan`).
  private readonly label: InstanceType<typeof Gtk.Label>;
  private unsubscribe: () => void;

  constructor(repo: GitRepo, onClicked?: () => void) {
    this.repo = repo;

    // [icon | spinner, "branch name +added -removed ↑ahead ↓behind"]. The icon is
    // a Nerd Font glyph in the bundled icon font; as plain label text it inherits
    // the theme foreground, matching FileTree's monochrome, theme-following icons.
    // It is swapped for the spinner while an operation runs.
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
    this.icon = new Gtk.Label({ label: BRANCH_GLYPH });
    this.icon.setAttributes(iconAttrs);
    this.spinner = new Gtk.Spinner();
    this.spinner.setVisible(false);

    this.label = new Gtk.Label({ useMarkup: true });

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.append(this.icon);
    box.append(this.spinner);
    box.append(this.label);

    this.root = new Gtk.Button();
    this.root.addCssClass('GitBranchButton');
    this.root.addCssClass('flat');
    this.root.addCssClass('zym-branch');
    this.root.setChild(box);
    this.root.setTooltipText('Switch branch');
    this.root.setVisible(false); // shown once a branch is resolved
    this.root.on('clicked', () => onClicked?.());

    this.unsubscribe = repo.onChange(() => this.refresh());
    this.refresh();
  }

  /** Point the button at a different repo (active-workbench switch): drop the old
   *  subscription, bind the new one, and re-render immediately. */
  setRepo(repo: GitRepo): void {
    if (repo === this.repo) return;
    this.unsubscribe();
    this.repo = repo;
    this.unsubscribe = repo.onChange(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const branch = this.repo.getBranch();
    if (!branch) {
      this.root.setVisible(false);
      return;
    }
    this.root.setVisible(true);

    // A merge/rebase with conflicts shows a warning icon (error-colored) in place
    // of the branch glyph, and changes the tooltip.
    const conflicts = this.repo.hasConflicts();
    this.icon.setText(conflicts ? CONFLICT_GLYPH : BRANCH_GLYPH);
    if (conflicts) this.icon.addCssClass('zym-conflict');
    else this.icon.removeCssClass('zym-conflict');
    this.root.setTooltipText(conflicts ? 'Merge conflicts — resolve them' : 'Switch branch');

    // Swap the branch icon for a spinner while a git operation is running.
    const busy = this.repo.isBusy();
    this.icon.setVisible(!busy);
    this.spinner.setVisible(busy);
    if (busy) this.spinner.start();
    else this.spinner.stop();

    // Branch name + counts as one markup string so the smaller count spans
    // baseline-align with the name. Each count is omitted when zero.
    const status = this.repo.getStatus();
    const sync = this.repo.getAheadBehind();
    const ahead = sync?.ahead ?? 0;
    const behind = sync?.behind ?? 0;
    // A diverged branch (both ahead and behind) is the dangerous case.
    const diverged = ahead > 0 && behind > 0;
    this.label.setMarkup(
      escapeMarkup(branch) +
        countSpan('+', status?.added ?? 0, COLOR_ADDED) +
        countSpan('-', status?.removed ?? 0, COLOR_REMOVED) +
        countSpan('↑', ahead, diverged ? COLOR_DANGER : COLOR_INFO) +
        countSpan('↓', behind, diverged ? COLOR_DANGER : COLOR_WARNING),
    );
  }

  dispose(): void {
    this.unsubscribe();
  }
}
