/*
 * SideBySideDiffView — a two-column (old | new) diff pane. From a `DiffModel`,
 * `splitSides` produces two line-aligned, equally-tall line arrays (each changed
 * row paired, the shorter side padded with blank fillers). Each side is a
 * read-only buffer pane with its own line backgrounds (`removed`/`added`/`filler`)
 * and a `+`/`−` gutter; the two views' vertical scroll is hard-locked.
 *
 * Equal line counts + no wrapping mean row N sits at the same pixel y on both
 * sides, so scroll-sync is a value copy. Built at runtime (vfunc gutter); the
 * assembled widget is `root`. See tasks/code-editing/diff.md.
 */
import { Gtk, type SourceView } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { DiffLineNumberGutter, sideLineLabels } from './DiffLineNumberGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow, changeStartRows } from './diffNav.ts';
import {
  splitSides,
  foldUnchanged,
  diffFoldLabel,
  diffBufferText,
  needsTrailingNewline,
  type DiffModel,
  type SideLine,
} from '../../util/DiffModel.ts';

// `Tab` switches focus between the two panes — registered once (selector-scoped to
// this widget's descendant views); each instance registers the command handler.
// With two panes, Tab alone toggles, so no Shift-Tab is needed.
let diffKeymapsRegistered = false;
function registerDiffKeymapsOnce(): void {
  if (diffKeymapsRegistered) return;
  diffKeymapsRegistered = true;
  quilx.keymaps.add('diff-view', {
    '#SideBySideDiff #TextEditor': { tab: 'diff:focus-other-pane' },
  });
}

export class SideBySideDiffView {
  readonly root: InstanceType<typeof Gtk.Paned>;
  private readonly left: TextEditor;
  private readonly right: TextEditor;
  private readonly gutters: DiffGutter[];
  private readonly lineNumbers: DiffLineNumberGutter[];
  // Hunk navigation: padded-buffer (model) rows where each changed region starts
  // (left and right are aligned). `hunkIndex` last revealed.
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    const { left, right } = splitSides(model);
    // The two sides have context (and therefore fold) rows at identical indices,
    // so the fold plans match index-for-index — fold them in lockstep to stay aligned.
    // Terminate both panes identically (so they stay equal-height for scroll-sync) when
    // either side's last row is an empty changed line needing a newline for its background.
    const terminate = needsTrailingNewline(left) || needsTrailingNewline(right);
    this.left = makePane(left, terminate, options.languagePath);
    this.right = makePane(right, terminate, options.languagePath);
    const leftToModel = (line: number) => this.left.modelLineForViewLine(line);
    const rightToModel = (line: number) => this.right.modelLineForViewLine(line);
    // Each side shows its own file's line numbers (old on the left, new on the right),
    // left of the +/− mark; both key by MODEL row (translated through the folds).
    this.lineNumbers = [
      new DiffLineNumberGutter(this.left.sourceView, sideLineLabels(left), leftToModel, 1),
      new DiffLineNumberGutter(this.right.sourceView, sideLineLabels(right), rightToModel, 1),
    ];
    this.gutters = [
      new DiffGutter(this.left.sourceView, left, leftToModel, 2),
      new DiffGutter(this.right.sourceView, right, rightToModel, 2),
    ];
    // Each pane folds its own unchanged runs (same indices); then mirror toggles so a
    // chevron click or z-fold command on either pane folds the other in lockstep.
    // Both sides fold the same unchanged runs (context rows align); label each from
    // the left side's context line (identical content) so the two markers match.
    const folds = foldUnchanged(left).map((f) => ({
      startLine: f.bodyStart,
      endLine: f.bodyEnd,
      whole: true,
      folded: true,
      placeholder: diffFoldLabel(left, f.bodyStart, f.count),
    }));
    this.left.setProvidedFolds(folds);
    this.right.setProvidedFolds(folds);
    this.left.setFoldMirror((i) => this.right.toggleProvidedFold(i));
    this.right.setFoldMirror((i) => this.left.toggleProvidedFold(i));
    this.hunkRows = changeStartRows(left.map((line) => line.kind));

    syncScroll(this.left.sourceView, this.right.sourceView);

    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('SideBySideDiff'); // the keymap selector targets its views
    this.root.setStartChild(this.left.root);
    this.root.setEndChild(this.right.root);
    this.root.setResizeStartChild(true);
    this.root.setResizeEndChild(true);
    this.root.setWideHandle(true);

    // `Tab` switches focus between the panes — via the command/keymap system, not a
    // raw controller, so it stays consistent with the rest of the app's bindings.
    quilx.commands.add(this.root, {
      'diff:focus-other-pane': { didDispatch: () => this.toggleFocus(), description: 'Focus the other diff pane' },
    });
    registerDiffKeymapsOnce();
  }

  /** Focus the diff (the left pane; Tab switches to the right). */
  focus(): void {
    this.left.focus();
  }

  /** Move focus to the other pane (defaults to the left when neither has it). */
  private toggleFocus(): void {
    const target = (this.right.sourceView as any).hasFocus?.() ? this.left : this.right;
    target.focus();
  }

  get hunkCount(): number {
    return this.hunkRows.length;
  }

  nextHunk(): void {
    this.gotoHunk(this.hunkIndex + 1);
  }

  prevHunk(): void {
    this.gotoHunk(this.hunkIndex - 1);
  }

  private gotoHunk(index: number): void {
    if (this.hunkRows.length === 0) return;
    const n = this.hunkRows.length;
    this.hunkIndex = ((index % n) + n) % n;
    // hunkRows are model rows; map through the left pane's folds. Reveal on the left;
    // the scroll-sync carries the right pane along.
    revealRow(this.left.sourceView, this.left.viewLineForModelLine(this.hunkRows[this.hunkIndex]));
  }

  dispose(): void {
    for (const gutter of this.gutters) gutter.dispose();
    for (const gutter of this.lineNumbers) gutter.dispose();
    // Tear both panes down explicitly: on a mode switch the root is detached (not
    // destroyed), so each TextEditor's `destroy` fallback never fires and its global
    // StyleManager handler would otherwise leak.
    this.left.dispose();
    this.right.dispose();
  }
}

/** A read-only pane for one side, with per-line diff backgrounds applied. Folding
 *  is left enabled (the caller installs the diff folds via `setProvidedFolds`). The
 *  caller decides `terminate` jointly for both panes so they stay equal-height. */
function makePane(lines: SideLine[], terminate: boolean, languagePath?: string): TextEditor {
  const editor = new TextEditor({
    buffer: { readOnly: true, initialText: diffBufferText(lines, terminate), languagePath },
  });
  applyDiffDecorations(editor.decorations.layer('diff'), lines, terminate);
  return editor;
}

/** Hard-lock the two views' vertical scroll (value copy, reentrancy-guarded). */
function syncScroll(a: SourceView, b: SourceView): void {
  const adjA = (a as any).getVadjustment?.();
  const adjB = (b as any).getVadjustment?.();
  if (!adjA || !adjB) return;
  let syncing = false;
  const link = (from: any, to: any) =>
    from.on('value-changed', () => {
      if (syncing) return;
      syncing = true;
      to.setValue(from.getValue());
      syncing = false;
    });
  link(adjA, adjB);
  link(adjB, adjA);
}
