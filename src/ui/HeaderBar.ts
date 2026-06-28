/*
 * HeaderBar — the window's Adwaita header bar (the top chrome). It assembles and
 * owns the header's git chrome: the branch button + GitHub PR/CI pill packed on
 * the start side, and the per-workbench health cluster (diagnostics pill + LSP
 * indicator) on the end side. It also owns the git-chrome lifecycle the header
 * drives: re-pointing every control at the active workbench's repo on a person
 * switch / re-root (`rebind`), the upstream-behind "pull" prompt (`checkUpstream`),
 * and the background auto-fetch that feeds it (`startAutoFetch`).
 *
 * The host (AppWindow) hands it a `getWorkbench` accessor — read lazily for the
 * active repo/cwd on every rebind and tick, so the chrome always reflects the
 * shown workbench — plus action callbacks for the picker controls and the
 * diagnostics/log panels. The assembled widget is `root`; the reactive GitHub
 * model is exposed as `github` for the git:push command and the GitHub command
 * module.
 */
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { addStyles } from '../styles.ts';
import { GitBranchButton } from './GitBranchButton.ts';
import { GithubButtons } from './GithubButtons.ts';
import { WorkbenchStatus } from './WorkbenchStatus.ts';
import { WorkbenchActionsBar } from './workbench/WorkbenchActionsBar.ts';
import { openGithubService, type GithubService } from '../github.ts';
import { type Workbench } from './workbench/Workbench.ts';
import { zym } from '../zym.ts';

// Shared `replaceKey` for the upstream-pull lifecycle, so the "behind" prompt,
// the "pulling…" spinner, and the result all transform one toast in place.
const PULL_NOTICE_KEY = 'git:pull';

export interface HeaderBarOptions {
  /** The active workbench accessor — read lazily for git/cwd on every rebind and
   *  on each auto-fetch / upstream tick, so the chrome always reflects the shown
   *  workbench (typically `zym.workspace.getActiveWorkbench()`). */
  getWorkbench: () => Workbench;
  /** Open the branch picker (the branch button's click). */
  onBranchPicker: () => void;
  /** Open the GitHub CI-checks picker (the PR/CI pill's checks segment). */
  onShowChecks: () => void;
  /** Toggle the Diagnostics panel (the diagnostics pill). */
  onOpenDiagnostics: () => void;
  /** Toggle the notification log (the LSP indicator). */
  onOpenLog: () => void;
  /** Whether a path / server root belongs to the active workbench's worktree —
   *  scopes the diagnostics pill + LSP indicator to the shown workbench. */
  ownsPath: (path: string) => boolean;
  ownsServer: (rootDir: string) => boolean;
}

addStyles(/* css */`
  .HeaderBar {
    border-bottom: 1px solid var(--border-color);
  }
`)

export class HeaderBar {
  /** The assembled Adw.HeaderBar — added to the window's Adw.ToolbarView. */
  readonly root: InstanceType<typeof Adw.HeaderBar>;

  // Header-bar git chrome. The GitRepo itself lives on the active workbench
  // (`getWorkbench().git`); these widgets are re-pointed at it by `rebind`.
  private readonly branchButton: GitBranchButton;
  /** Reactive GitHub PR/CI model (busy-aware), shared by the header buttons.
   *  Exposed for the git:push command (CI refresh after a push) and the GitHub
   *  command module. */
  readonly github: GithubService;
  private readonly githubButtons: GithubButtons;
  private readonly workbenchStatus: WorkbenchStatus;
  // The active workbench's actions (docs/workbench.md), shown in the centre title
  // slot and rebound to the shown workbench's set on every `rebind`.
  private readonly actions: WorkbenchActionsBar;

  private readonly getWorkbench: () => Workbench;

  // Last-seen upstream "behind" count, to fire the pull notification only on the
  // transition into being behind (not on every status poll while behind).
  private lastBehind = 0;
  // Unsubscribe for the upstream-behind watch on the active workbench's git;
  // re-armed by `rebind` on every workbench switch.
  private upstreamUnsub: (() => void) | null = null;
  // Background git fetch interval timer (null when disabled).
  private autoFetchTimer: NodeJS.Timeout | null = null;

  constructor(options: HeaderBarOptions) {
    this.getWorkbench = options.getWorkbench;
    const wb = options.getWorkbench();

    // The git chrome targets the *active* workbench's git/cwd; `rebind` re-points
    // it (setRepo/rebind) on a person switch. The click closures are supplied by
    // the host and read its live workbench, so they always act on the shown one.
    this.branchButton = new GitBranchButton(wb.git, options.onBranchPicker);
    this.github = openGithubService(wb.git, {
      cwd: wb.cwd,
      remoteNames: () => {
        const upstream = (zym.config.get('git.remotes.upstream') as string) || 'upstream';
        const origin = (zym.config.get('git.remotes.origin') as string) || 'origin';
        return [upstream, origin];
      },
    });
    this.githubButtons = new GithubButtons({
      git: wb.git,
      github: this.github,
      cwd: wb.cwd,
      onShowChecks: options.onShowChecks,
    });
    this.workbenchStatus = new WorkbenchStatus({
      onOpenDiagnostics: options.onOpenDiagnostics,
      onOpenLog: options.onOpenLog,
      ownsPath: options.ownsPath,
      ownsServer: options.ownsServer,
    });
    this.actions = new WorkbenchActionsBar();
    this.actions.bind(wb.actions);

    this.root = new Adw.HeaderBar();
    this.root.addCssClass('HeaderBar');
    // The branch button and the GitHub PR pill are separate controls.
    this.root.packStart(this.branchButton.root);
    this.root.packStart(this.githubButtons.root);
    // Right-aligned: the per-workbench health pill (diagnostics + LSP) at the far edge,
    // the active workbench's actions just inside it.
    this.root.packEnd(this.workbenchStatus.root);
    this.root.packEnd(this.actions.root);
    // The project name and unsaved marker live in the sidebar header, so the centre
    // title slot would otherwise fall back to the duplicative window title; clear it
    // with an empty widget.
    this.root.setTitleWidget(new Gtk.Box());
  }

  // Re-point the header git chrome (branch button, GitHub model + buttons) and the
  // upstream-behind watch at the active workbench's git/cwd. Idempotent (the
  // widgets no-op when the repo is unchanged), so it also seeds the initial bind.
  rebind(): void {
    const workbench = this.getWorkbench();
    const { git, cwd } = workbench;
    this.branchButton.setRepo(git);
    this.github.rebind(git, cwd);
    this.githubButtons.setRepo(git, cwd);
    this.actions.bind(workbench.actions); // show the active workbench's actions
    this.upstreamUnsub?.();
    this.lastBehind = git.getAheadBehind()?.behind ?? 0;
    this.upstreamUnsub = git.onChange(() => this.checkUpstream());
  }

  /** Re-scope the diagnostics pill + LSP indicator to the active workbench (its
   *  worktree); called on a person switch / re-root. */
  refreshStatus(): void {
    this.workbenchStatus.refresh();
  }

  // Periodically `git fetch` in the background so the upstream-behind check sees
  // remote activity. Quiet (no success notification); the resulting onChange
  // drives the branch button and `checkUpstream`. `git.autoFetchMinutes` of 0
  // disables it. (Read once at startup.)
  startAutoFetch(): void {
    const minutes = Number(zym.config.get('git.autoFetchMinutes') ?? 0);
    if (!(minutes > 0)) return;
    this.autoFetchTimer = setInterval(() => {
      const { git } = this.getWorkbench();
      if (git.getBranch() !== null) void git.fetch();
    }, minutes * 60_000);
  }

  // On the transition into being behind the upstream, post an info notification
  // offering to pull. Only fires when `behind` goes from 0 to positive, so a
  // repo that stays behind across status polls isn't re-toasted every tick.
  private checkUpstream(): void {
    const behind = this.getWorkbench().git.getAheadBehind()?.behind ?? 0;
    if (behind > 0 && this.lastBehind === 0) {
      const commits = behind === 1 ? 'commit' : 'commits';
      // Sticky + a shared `replaceKey` so the prompt persists until acted on and
      // clicking Pull transforms this same toast into pulling…→pulled (mirrors the
      // LSP install flow).
      zym.notifications.addInfo(`Upstream is ahead by ${behind} ${commits}`, {
        detail: 'Your branch is behind its upstream — pull to update.',
        replaceKey: PULL_NOTICE_KEY,
        dismissable: true,
        buttons: [{ text: 'Pull', onDidClick: () => void this.pullWithProgress() }],
      });
    }
    this.lastBehind = behind;
  }

  // Pull from upstream, surfacing progress as a single in-place toast: a sticky
  // loading notice that transforms into success/error when it finishes (mirrors
  // the LSP install flow). Shares the prompt's `replaceKey` so the prompt, the
  // spinner, and the result are one card.
  private async pullWithProgress(): Promise<void> {
    zym.notifications.addInfo('Pull…', { replaceKey: PULL_NOTICE_KEY, loading: true, dismissable: true });
    const result = await this.getWorkbench().git.pull();
    if (result.isOk()) zym.notifications.addSuccess('Pull succeeded', { replaceKey: PULL_NOTICE_KEY });
    else zym.notifications.addError('Pull failed', { replaceKey: PULL_NOTICE_KEY });
  }

  dispose(): void {
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    this.upstreamUnsub?.();
    this.branchButton.dispose();
    this.githubButtons.dispose();
    this.workbenchStatus.dispose();
    this.actions.dispose();
    this.github.dispose();
  }
}
