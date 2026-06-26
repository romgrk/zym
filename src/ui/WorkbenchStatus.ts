/*
 * WorkbenchStatus — the right-hand cluster of the workbench header bar: a
 * diagnostics pill and a language-server indicator, the two per-workbench health
 * signals that otherwise have no home in the chrome.
 *
 *  - Diagnostics pill: per-severity totals across all open files (e.g.
 *    " 3   1"), each colour matching the gutter/squiggle severity. Which
 *    severities count is set by `diagnostics.statusSeverities` (default: all
 *    four). Hidden when there are none. Clicking opens the Diagnostics dock.
 *  - LSP indicator: a spinner while a server is starting or installing, an
 *    error glyph if one failed to start (otherwise an LSP failure is silent), or
 *    a muted "language intelligence" glyph once servers are ready. Hidden when
 *    no server is running. Clicking opens the notification log (where LSP
 *    notices land). The tooltip names the servers.
 *
 * Reads live from `zym.lsp` (the diagnostics store and the server status it now
 * exposes) and refreshes on their change events. The assembled widget is `root`.
 */
import { Gtk } from '../gi.ts';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { Icons, iconLabel } from './icons.ts';
import { severityStyle } from '../lsp/diagnostics/severity.ts';

// The language-server status glyph (nf-fa-server).
const LSP_GLYPH = Icons.server;

// Gap between severity groups in the pill — wider than the within-group glyph↔count
// space so the types read as distinct clusters. A Pango span of spaces, scaled up
// so one knob (the size) controls the gap.
const DIAG_SEPARATOR = '<span size="x-large"> </span>';

// The severities the pill can show, in display order, with the config key that
// toggles each and its singular/plural tooltip noun ("info" is uncountable).
const DIAG_SEVERITIES: { severity: DiagnosticSeverity; key: string; one: string; many: string }[] = [
  { severity: DiagnosticSeverity.Error, key: 'error', one: 'error', many: 'errors' },
  { severity: DiagnosticSeverity.Warning, key: 'warning', one: 'warning', many: 'warnings' },
  { severity: DiagnosticSeverity.Information, key: 'info', one: 'info', many: 'info' },
  { severity: DiagnosticSeverity.Hint, key: 'hint', one: 'hint', many: 'hints' },
];

// Diagnostics churn rapidly while editing (each keystroke can republish), so the
// pill update is debounced — it settles to the latest counts rather than flapping.
const DIAG_DEBOUNCE_MS = 500;
// Each content change fades+slides out then in (the FADE_SLIDE revealer animates
// opacity and width together); one direction takes this long.
const DIAG_ANIM_MS = 200;

// A ready server's glyph is muted (it's ambient, not an alert); a failed one is
// error-coloured to draw the eye. The diagnostics counts use the shared small
// secondary-text size (see docs/styling.md), matching GitBranchButton's counts.
// Both buttons get the same horizontal padding so the pill and the icon match.
addStyles(`
  .WorkbenchStatus button { min-width: 0; padding-left: 6px; padding-right: 6px; }
  .WorkbenchStatus .zym-lsp-ready { color: var(--t-ui-text-muted); }
  .WorkbenchStatus .zym-lsp-failed { color: var(--t-ui-status-error); }
  .WorkbenchStatus .zym-status-count { font-size: var(--t-font-ui-size-small); }
`);

export interface WorkbenchStatusOptions {
  /** Open the Diagnostics dock (diagnostics pill click). */
  onOpenDiagnostics: () => void;
  /** Open the notification log, where LSP notices land (LSP indicator click). */
  onOpenLog: () => void;
  /** Whether a diagnostic path belongs to the *active* workbench (its root) — so
   *  the pill counts only that workbench's files. Read live; call `refresh` on
   *  a workbench switch / re-root. Defaults to everything. */
  ownsPath?: (path: string) => boolean;
  /** Whether a language server (by its project root) serves the active workbench. */
  ownsServer?: (rootDir: string) => boolean;
}

export class WorkbenchStatus {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly diagnosticsButton: InstanceType<typeof Gtk.Button>;
  private readonly diagnosticsLabel: InstanceType<typeof Gtk.Label>;
  private readonly diagnosticsRevealer: InstanceType<typeof Gtk.Revealer>;
  // The markup currently displayed (and revealed); null when the pill is hidden.
  private shownDiag: string | null = null;
  // Severity keys the pill counts, from `diagnostics.statusSeverities` (observed).
  private enabledSeverities = new Set<string>();
  // Timers: the debounce that defers updates, and the in-flight out→in
  // transition step (null = none). Both cleared on dispose.
  private diagDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private diagAnimTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly lspButton: InstanceType<typeof Gtk.Button>;
  private readonly lspIcon: InstanceType<typeof Gtk.Label>;
  private readonly lspSpinner: InstanceType<typeof Gtk.Spinner>;

  private readonly options: WorkbenchStatusOptions;
  private readonly subs = new CompositeDisposable();

  constructor(options: WorkbenchStatusOptions) {
    this.options = options;
    // Diagnostics pill: a single markup label (icon-font glyph spans + count
    // spans share a baseline), wrapped in a revealer so each content change
    // fades+slides (opacity + width), inside a flat button.
    this.diagnosticsLabel = new Gtk.Label({ useMarkup: true });
    this.diagnosticsLabel.addCssClass('zym-status-count'); // small secondary-text size
    this.diagnosticsRevealer = new Gtk.Revealer({
      transitionType: Gtk.RevealerTransitionType.FADE_SLIDE_RIGHT,
      transitionDuration: DIAG_ANIM_MS,
      revealChild: false,
    });
    this.diagnosticsRevealer.setChild(this.diagnosticsLabel);
    this.diagnosticsButton = new Gtk.Button();
    this.diagnosticsButton.addCssClass('flat');
    this.diagnosticsButton.setChild(this.diagnosticsRevealer);
    this.diagnosticsButton.on('clicked', () => options.onOpenDiagnostics());

    // LSP indicator: a Nerd Font glyph swapped for a spinner while a server is
    // coming up (mirrors GitBranchButton's busy spinner).
    this.lspIcon = iconLabel(LSP_GLYPH);
    this.lspSpinner = new Gtk.Spinner();
    this.lspSpinner.setVisible(false);
    const lspBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    lspBox.append(this.lspIcon);
    lspBox.append(this.lspSpinner);
    this.lspButton = new Gtk.Button();
    this.lspButton.addCssClass('flat');
    this.lspButton.setChild(lspBox);
    this.lspButton.on('clicked', () => options.onOpenLog());

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('WorkbenchStatus');
    this.root.addCssClass('linked'); // join the two buttons into one grouped control
    this.root.append(this.diagnosticsButton);
    this.root.append(this.lspButton);

    this.subs.add(zym.lsp.diagnostics.onDidUpdate(() => this.scheduleDiagnostics()));
    this.subs.add(zym.lsp.onDidChangeServers(() => this.refreshLsp()));
    // observe() fires immediately (initial render — unmapped, so it snaps without
    // animation) and again whenever the config key is edited.
    this.subs.add(
      zym.config.observe('diagnostics.statusSeverities', (value) => {
        this.enabledSeverities = new Set(Array.isArray(value) ? value.map(String) : []);
        this.syncDiagnostics();
      }),
    );
    this.refreshLsp();
  }

  /** Re-evaluate against the (possibly new) active-workbench scope — call on a
   *  workbench switch or re-root, since neither fires an LSP/diagnostics event. */
  refresh(): void {
    this.syncDiagnostics();
    this.refreshLsp();
  }

  // Live diagnostics updates are debounced: reset the timer on each change so the
  // pill settles to the latest counts ~DIAG_DEBOUNCE_MS after editing stops.
  private scheduleDiagnostics(): void {
    if (this.diagDebounceTimer) clearTimeout(this.diagDebounceTimer);
    this.diagDebounceTimer = setTimeout(() => {
      this.diagDebounceTimer = null;
      this.syncDiagnostics();
    }, DIAG_DEBOUNCE_MS);
  }

  // The target pill content for the current diagnostics, or null when clean. Only
  // the configured severities (with a non-zero count) appear, in severity order.
  private diagnosticsTarget(): { markup: string; tooltip: string } | null {
    const counts = zym.lsp.diagnostics.countsBySeverity(this.options.ownsPath);
    const shown = DIAG_SEVERITIES.filter((s) => this.enabledSeverities.has(s.key) && (counts[s.severity] ?? 0) > 0);
    if (shown.length === 0) return null;
    const markup = shown.map((s) => countMarkup(counts[s.severity]!, severityStyle(s.severity))).join(DIAG_SEPARATOR);
    const parts = shown.map((s) => {
      const n = counts[s.severity]!;
      return `${n} ${n === 1 ? s.one : s.many}`;
    });
    return { markup, tooltip: `${parts.join(', ')} — open Diagnostics` };
  }

  // Animate the pill toward the current target. A change while shown fades+slides
  // the old content out, swaps to the latest target, then in (or hides when
  // clean). Re-entrant calls during a transition are ignored; the transition's
  // tail re-syncs, so changes that land mid-animation are never lost.
  private syncDiagnostics(): void {
    if (this.diagAnimTimer) return;
    const target = this.diagnosticsTarget();
    const markup = target?.markup ?? null;
    if (markup === this.shownDiag) return;

    if (this.shownDiag === null) {
      // Nothing shown → reveal the new content in.
      this.diagnosticsLabel.setMarkup(target!.markup);
      this.diagnosticsButton.setTooltipText(target!.tooltip);
      this.diagnosticsButton.setVisible(true);
      this.diagnosticsRevealer.setRevealChild(true);
      this.shownDiag = markup;
      this.scheduleDiagResync();
      return;
    }

    // Something shown → play the out transition, then swap to the latest target.
    this.diagnosticsRevealer.setRevealChild(false);
    this.diagAnimTimer = setTimeout(() => {
      this.diagAnimTimer = null;
      const next = this.diagnosticsTarget();
      if (!next) {
        this.diagnosticsButton.setVisible(false);
        this.shownDiag = null;
      } else {
        this.diagnosticsLabel.setMarkup(next.markup);
        this.diagnosticsButton.setTooltipText(next.tooltip);
        this.diagnosticsRevealer.setRevealChild(true);
        this.shownDiag = next.markup;
      }
      this.scheduleDiagResync();
    }, DIAG_ANIM_MS);
  }

  // After the in/settle phase, re-check the target so a change that arrived during
  // the animation is picked up once the widget is idle again.
  private scheduleDiagResync(): void {
    this.diagAnimTimer = setTimeout(() => {
      this.diagAnimTimer = null;
      this.syncDiagnostics();
    }, DIAG_ANIM_MS);
  }

  // Aggregate the per-server states into one indicator: spinner (starting/
  // installing) > error (a server failed) > ready glyph > hidden (nothing up).
  private refreshLsp(): void {
    const all = zym.lsp.serverStates();
    // Scope to the active workbench's servers (its worktree's project roots).
    const states = this.options.ownsServer ? all.filter((s) => this.options.ownsServer!(s.rootDir)) : all;
    const starting = zym.lsp.isInstalling || states.some((s) => s.state === 'starting');
    const failed = states.filter((s) => s.state === 'failed').map((s) => s.name);
    const ready = states.filter((s) => s.state === 'ready').map((s) => s.name);

    if (!starting && failed.length === 0 && ready.length === 0) {
      this.lspButton.setVisible(false);
      return;
    }
    this.lspButton.setVisible(true);

    if (starting) {
      this.lspIcon.setVisible(false);
      this.lspSpinner.setVisible(true);
      this.lspSpinner.start();
      this.lspButton.setTooltipText(zym.lsp.isInstalling ? 'Installing language server…' : 'Starting language server…');
      return;
    }
    this.lspSpinner.stop();
    this.lspSpinner.setVisible(false);
    this.lspIcon.setVisible(true);

    if (failed.length > 0) {
      this.lspIcon.setText(Icons.error);
      this.lspIcon.removeCssClass('zym-lsp-ready');
      this.lspIcon.addCssClass('zym-lsp-failed');
      this.lspButton.setTooltipText(`Language server failed: ${failed.join(', ')}`);
      return;
    }

    this.lspIcon.setText(LSP_GLYPH);
    this.lspIcon.removeCssClass('zym-lsp-failed');
    this.lspIcon.addCssClass('zym-lsp-ready');
    this.lspButton.setTooltipText(`Language server${ready.length === 1 ? '' : 's'}: ${ready.join(', ')}`);
  }

  dispose(): void {
    if (this.diagDebounceTimer) clearTimeout(this.diagDebounceTimer);
    if (this.diagAnimTimer) clearTimeout(this.diagAnimTimer);
    this.subs.dispose();
  }
}

// A "{glyph}{count}" run for one severity: the icon-font glyph and the count in
// the severity colour, baseline-aligned (a smaller count span after the glyph).
// Empty when the count is zero.
function countMarkup(count: number, style: ReturnType<typeof severityStyle>): string {
  if (count <= 0) return '';
  return (
    `<span font_family="${ICON_FONT_FAMILY}" foreground="${style.color}">${style.glyph}</span>` +
    `<span foreground="${style.color}"> ${count}</span>`
  );
}
