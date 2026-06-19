/*
 * GithubButtons — a header-bar control for the current branch's pull request.
 *
 * A `.linked` pair of plain buttons: the PR segment (a state-coloured glyph —
 * open green / merged purple / closed red, the same icons as the
 * `github:pull-request-checkout` picker — followed by "#1234" in white) opens the pull
 * request, and the CI segment (a check / dot / times glyph in success / warning
 * / error) opens a picker of the PR's CI checks (`GithubCIChecksPicker`). When the
 * branch has no PR but isn't the default branch, the PR segment instead shows a
 * white PR glyph and opens the create-PR web page; the control is hidden only when
 * there's nothing actionable.
 *
 * This is a pure view over the reactive `GithubService` (PR/CI/default-branch
 * state + busy): it re-renders on `github.onChange` and reads the cached getters,
 * never querying `gh` itself. While the service is busy (a push and its follow-up
 * scheduled refresh, or any git operation) the CI segment is shown in the
 * in-progress (pending) look as a loading state, until the next status resolves.
 * The `github:*` commands cover the repo/actions/issues/pulls/issue pages too.
 * Assembled control exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { openUrl } from './openUrl.ts';
import { repoRoot } from '../git.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { stateGlyphMarkup } from './GithubPrPicker.ts';
import { repoWebUrl, createPullRequestWeb, type PrState, type CiStatus, type GithubService } from '../github.ts';
import type { GitRepo } from '../git.ts';

// CI status glyph + colour (bundled icon font): check / dot / times, drawn in
// the theme's success / warning / error.
const CI_STYLE: Record<CiStatus, { glyph: string; color: string }> = {
  success: { glyph: String.fromCodePoint(0xf00c), color: theme.ui.status.success }, // check
  warning: { glyph: String.fromCodePoint(0xf444), color: theme.ui.status.warning }, // dot-fill (smaller)
  error: { glyph: String.fromCodePoint(0xf467), color: theme.ui.status.error }, // oct-x (smaller)
};

// Markup for the PR segment: the state glyph (coloured) then "#1234" in the
// theme foreground.
function prMarkup(state: PrState, number: number): string {
  return `${stateGlyphMarkup(state)}<span foreground="${theme.ui.editor.foreground}">#${number}</span>`;
}

// Markup for the PR segment when there's no PR yet on a non-default branch: the
// PR glyph in the theme foreground — clicking opens the create-PR web page.
const CREATE_PR_GLYPH = String.fromCodePoint(0xf407); // git-pull-request
function createPrMarkup(): string {
  return `<span face="${ICON_FONT_FAMILY}" foreground="${theme.ui.editor.foreground}">${escapeMarkup(CREATE_PR_GLYPH)}</span>`;
}

// Markup for the CI segment: a single status glyph in the icon font.
function ciMarkup(ci: CiStatus): string {
  const { glyph, color } = CI_STYLE[ci];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span>`;
}

// The control is two linked buttons; each one carries its own side padding, so
// without this it sits ~2× wider than the single-button GitBranchButton. Trim the
// horizontal padding (leaving the vertical default) to match that compactness.
addStyles(`
  #GithubButtons button { padding-left: 8px; padding-right: 8px; }
`);

export interface GithubButtonsOptions {
  git: GitRepo;
  /** The reactive GitHub model (PR/CI/default-branch + busy) this view renders. */
  github: GithubService;
  /** A directory inside the repo (the repo root is resolved from it). */
  cwd: string;
  /**
   * Open the CI-checks picker for the current branch's PR. Provided by the host
   * because the picker needs its overlay, which doesn't exist yet when this
   * header control is constructed (so it's read lazily, at click time).
   */
  onShowChecks?: () => void;
}

export class GithubButtons {
  readonly root: InstanceType<typeof Gtk.Box>;

  // `git`/`repoDir` are swapped via `setRepo` when the active workbench changes;
  // `github` is the shared service (rebound internally), so its subscription stays.
  private git: GitRepo;
  private readonly github: GithubService;
  private repoDir: string | null;
  private readonly onShowChecks?: () => void;

  private readonly prLabel: InstanceType<typeof Gtk.Label>; // state glyph + "#1234"
  private readonly prButton: InstanceType<typeof Gtk.Button>;
  private readonly ciButton: InstanceType<typeof Gtk.Button>;
  private readonly ciIcon: InstanceType<typeof Gtk.Label>;

  // URLs / state derived from the model on each render; the command handlers and
  // click handlers read these (resolved lazily at dispatch time).
  private repoUrl: string | null = null;
  private actionsUrl: string | null = null; // the repo's CI Actions page
  private issuesUrl: string | null = null; // the repo's issues list
  private pullsUrl: string | null = null; // the repo's pull-requests list
  private prUrl: string | null = null; // this branch's PR
  private issueUrl: string | null = null; // the PR's linked issue
  // When there's no PR, the PR segment becomes a "create PR" affordance on a
  // non-default branch; the click handler branches on this.
  private prMode: 'view' | 'create' = 'view';
  private readonly unsubscribe: () => void;

  constructor(options: GithubButtonsOptions) {
    this.git = options.git;
    this.github = options.github;
    this.repoDir = repoRoot(options.cwd);
    this.onShowChecks = options.onShowChecks;

    // PR segment: state glyph + "#1234"; opens the pull request (or, with no PR
    // on a non-default branch, opens the create-PR web page — see `prMode`).
    this.prLabel = new Gtk.Label();
    this.prButton = new Gtk.Button();
    this.prButton.addCssClass('flat');
    this.prButton.setChild(this.prLabel);
    this.prButton.setTooltipText('Open pull request');
    this.prButton.on('clicked', () => (this.prMode === 'create' ? this.createPr() : this.open(this.prUrl)));

    // "CI status" segment: a status glyph that opens the CI-checks picker.
    this.ciIcon = new Gtk.Label();
    this.ciButton = new Gtk.Button();
    this.ciButton.addCssClass('flat');
    this.ciButton.setChild(this.ciIcon);
    this.ciButton.setTooltipText('CI status — open checks');
    this.ciButton.on('clicked', () => this.onShowChecks?.());

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('GithubButtons'); // selector identity for command/keymap rules
    this.root.addCssClass('linked');
    this.root.setValign(Gtk.Align.CENTER);
    this.root.append(this.prButton);
    this.root.append(this.ciButton);
    this.root.setVisible(false); // shown only when a PR exists

    this.registerCommands();
    // Re-render on any model change — data (PR/CI/default branch) or busy state.
    this.unsubscribe = this.github.onChange(() => this.render());
    this.render();
  }

  /** Re-point at the active workbench's git + root (the shared GithubService is
   *  rebound separately); recompute the repo dir and re-render. */
  setRepo(git: GitRepo, cwd: string): void {
    this.git = git;
    this.repoDir = repoRoot(cwd);
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- commands --------------------------------------------------------------

  private registerCommands(): void {
    quilx.commands.add('#AppWindow', {
      'github:repository-open': { didDispatch: () => this.openOrNotify(this.repoUrl, 'GitHub repository'), description: 'Open the repository on GitHub' },
      'github:actions-open': { didDispatch: () => this.openOrNotify(this.actionsUrl, 'GitHub repository'), description: 'Open GitHub Actions' },
      'github:issues-open': { didDispatch: () => this.openOrNotify(this.issuesUrl, 'GitHub repository'), description: 'Open GitHub issues' },
      'github:pull-requests-open': { didDispatch: () => this.openOrNotify(this.pullsUrl, 'GitHub repository'), description: 'Open GitHub pull requests' },
      'github:pull-request-open': { didDispatch: () => this.openOrNotify(this.prUrl, 'pull request for this branch'), description: 'Open the pull request for this branch' },
      'github:issue-open': { didDispatch: () => this.openOrNotify(this.issueUrl, 'linked issue'), description: 'Open the linked issue' },
      'github:pull-request-create': { didDispatch: () => this.createPr(), description: 'Create a pull request' },
    });
  }

  private createPr(): void {
    if (!this.repoDir) {
      quilx.notifications.addInfo('No GitHub repository available');
      return;
    }
    createPullRequestWeb(this.repoDir, (ok, stderr) => {
      if (!ok) quilx.notifications.addError('Could not create pull request', { detail: stderr.trim() });
    });
  }

  // --- render ----------------------------------------------------------------

  // Reflect the model into the widgets. Driven entirely by the cached getters,
  // so it's cheap to call on every `onChange` (data or busy).
  private render(): void {
    const repo = this.github.getRepo();
    if (!repo) {
      this.repoUrl = this.actionsUrl = this.issuesUrl = this.pullsUrl = null;
      this.prUrl = this.issueUrl = null;
      this.root.setVisible(false);
      return;
    }
    this.repoUrl = repoWebUrl(repo);
    this.actionsUrl = `${this.repoUrl}/actions`;
    this.issuesUrl = `${this.repoUrl}/issues`;
    this.pullsUrl = `${this.repoUrl}/pulls`;

    const pr = this.github.getPullRequest();
    if (!pr) {
      this.prUrl = this.issueUrl = null;
      this.renderCreatePr();
      return;
    }
    this.prMode = 'view';
    this.prButton.setTooltipText(`Open ${pr.title || `#${pr.number}`}`);
    this.prUrl = pr.url;
    this.issueUrl = pr.issueUrl;
    this.prLabel.setMarkup(prMarkup(pr.state, pr.number));
    // CI glyph only for open/merged PRs that actually have checks.
    const showCi = (pr.state === 'open' || pr.state === 'merged') && pr.ci !== null;
    if (showCi) {
      // While the model is busy (a push + its scheduled refresh, or any git op),
      // the cached CI status is stale — show the in-progress (pending) look as a
      // loading state until the next status resolves.
      this.ciIcon.setMarkup(ciMarkup(this.github.isBusy() ? 'warning' : pr.ci!));
    }
    this.ciButton.setVisible(showCi);
    this.root.setVisible(true);
  }

  // With no PR for the current branch, offer "create PR" — but only on a real,
  // non-default branch. Otherwise hide the control entirely.
  private renderCreatePr(): void {
    const branch = this.git.getBranch();
    const defaultBranch = this.github.getDefaultBranch();
    if (!branch || defaultBranch === null || branch === defaultBranch) {
      this.prMode = 'view';
      this.root.setVisible(false);
      return;
    }
    this.prMode = 'create';
    this.prButton.setTooltipText('Create PR');
    this.prLabel.setMarkup(createPrMarkup());
    this.ciButton.setVisible(false); // no checks until the PR exists
    this.root.setVisible(true);
  }

  // --- helpers ---------------------------------------------------------------

  private open(url: string | null): void {
    if (url) openUrl(url);
  }

  private openOrNotify(url: string | null, label: string): void {
    if (url) this.open(url);
    else quilx.notifications.addInfo(`No ${label} available`);
  }
}
