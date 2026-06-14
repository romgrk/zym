/*
 * BranchButton — a header-bar indicator showing the repository's current git
 * branch (e.g. "⎇ master"). It reads the branch from an injected `GitRepo` and
 * refreshes on checkout via `GitRepo.onChange`; outside a repo it hides itself.
 *
 * It is a flat button so it can later grow into a branch switcher (open a popover
 * on click). The assembled widget is exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import type { GitRepo } from '../git.ts';

// U+2387 ALTERNATIVE KEY SYMBOL — the conventional "branch" glyph, avoiding a
// dependency on a vcs icon being present in the icon theme.
const BRANCH_GLYPH = '⎇';

export class BranchButton {
  readonly root: InstanceType<typeof Gtk.Button>;

  private readonly repo: GitRepo;
  private readonly label: InstanceType<typeof Gtk.Label>;
  private readonly unsubscribe: () => void;

  constructor(repo: GitRepo) {
    this.repo = repo;

    this.label = new Gtk.Label();
    this.root = new Gtk.Button();
    this.root.setName('BranchButton'); // selector identity for command/keymap rules
    this.root.addCssClass('flat');
    this.root.addCssClass('quilx-branch');
    this.root.setChild(this.label);
    this.root.setVisible(false); // shown once a branch is resolved

    this.unsubscribe = repo.onChange(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const branch = this.repo.getBranch();
    if (branch) {
      this.label.setText(`${BRANCH_GLYPH} ${branch}`);
      this.root.setVisible(true);
    } else {
      this.root.setVisible(false);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
