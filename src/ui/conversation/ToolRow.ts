/*
 * ToolRow — the shared transcript row for tool activity (tool-use, Bash, and
 * unrecognised stream events). Layout:
 *
 *   ┌ row ─────────────────────────────────────┐
 *   │ ICON │ ┌ toggle ───────────────────────┐ │
 *   │      │ │ BUTTON  (header, flat)         │ │
 *   │      │ │ DETAILS (collapsible reveal)   │ │
 *   │      │ └───────────────────────────────┘ │
 *   └───────────────────────────────────────────┘
 *
 * The leading ICON identifies the tool (Bash → a terminal). The `toggle` — the
 * BUTTON + DETAILS column — is the expander: clicking the button reveals the
 * details, and the toggle's background fades to a message bubble's. The icon sits
 * outside the toggle, so it stays put while the toggle alone grows and tints.
 *
 * "Activate" rows (file tools) are the exception: their button click opens the file
 * instead of toggling, so their details show inline rather than behind a reveal.
 *
 * The widget owns only the layout, the toggle, and the fade — the conversation
 * builds each tool's header and fills `content`.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { iconSpan } from '../icons.ts';
import { setMarkupSafe } from '../proseMarkup.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  /* The leading tool icon. A size group ties its height to the header button's, so
     the label's own vertical centering keeps the glyph centered on the header row. */
  .ToolRow .tool-row-icon { padding-right: 8px; }
  /* The BUTTON + DETAILS expander: the only part that grows + gains the bubble bg. */
  .ToolRow .tool-row-toggle {
    border-radius: 8px;
    background: transparent;
    transition: background 150ms ease;
  }
  .ToolRow .tool-row-toggle.is-expanded { background: var(--t-ui-surface-popover); }
  /* The header button: a standard Adwaita flat button (its own hover tint), just
     left-aligned with no min size and rounded to match the toggle. */
  .ToolRow .tool-row-button {
    padding: 6px 8px; min-height: 0; border-radius: 8px;
  }
  .ToolRow .tool-row-detail { padding: 0 8px 6px 8px; }
`);

/** A tool row's status: warning / error tint the icon + header (via the Adwaita
 *  `.warning` / `.error` style classes), or `null` for the neutral default. */
export type ToolRowStatus = 'warning' | 'error' | null;

export interface ToolRowOptions {
  /** Nerd Font glyph for the leading icon slot (Bash → terminal, …). */
  icon: string;
  /** Optional color for the icon (e.g. a warning tint for unknown events). */
  iconColor?: string;
  /** The header content (title + detail / command / event title). Hexpands. */
  header: Widget;
  /** When set, a header click runs this (file tools open their file) instead of
   *  toggling; the details box is then shown inline rather than behind a reveal. */
  onActivate?: () => void;
  /** Initial status (warning/error): colours the icon + header via the Adwaita
   *  style class. Equivalent to calling `setStatus` after construction. */
  status?: ToolRowStatus;
  /** Start expanded (toggle rows only). */
  expanded?: boolean;
  /** Notified on every expand/collapse (toggle rows only) — e.g. Bash re-renders
   *  its command (first line vs. full) to match the new state. */
  onToggle?: (expanded: boolean) => void;
}

export class ToolRow {
  readonly root: InstanceType<typeof Gtk.Box>; // [icon][toggle]
  /** The details section below the header — append result/output/JSON/progress here. */
  readonly content: InstanceType<typeof Gtk.Box>;
  private readonly icon: InstanceType<typeof Gtk.Label>;
  private readonly header: Widget; // the title widget — status-tinted alongside the icon
  private readonly toggle: InstanceType<typeof Gtk.Box>; // BUTTON + DETAILS; the bg-fade target
  private readonly revealer: InstanceType<typeof Gtk.Revealer> | null;
  private readonly onToggle?: (expanded: boolean) => void;
  // The leading icon's glyph + its explicit colour (used only when no status owns it).
  private iconGlyph = '';
  private iconColor?: string;
  private status: ToolRowStatus = null;

  constructor(opts: ToolRowOptions) {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('ToolRow');
    // The transcript wraps this in a .transcript-entry-tool box (Transcript.appendToolEntry);
    // the row itself carries no entry class.

    this.header = opts.header;
    this.icon = new Gtk.Label({ valign: Gtk.Align.START });
    this.icon.addCssClass('tool-row-icon');
    this.setIcon(opts.icon, opts.iconColor);
    this.root.append(this.icon);

    // The BUTTON + DETAILS column: the expander that grows + gains the bubble bg.
    this.toggle = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    this.toggle.addCssClass('tool-row-toggle');

    const button = new Gtk.Button();
    button.addCssClass('flat');
    button.addCssClass('tool-row-button');
    opts.header.setHexpand(true);
    button.setChild(opts.header);
    this.toggle.append(button);

    if (opts.status) this.setStatus(opts.status);

    // Center the icon against the header button — not the whole toggle. A vertical
    // size group ties the icon's height to the button's, so the (top-aligned) icon
    // stays centered on the header row even once the details expand below it.
    const iconSizing = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
    iconSizing.addWidget(this.icon);
    iconSizing.addWidget(button);

    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.content.addCssClass('tool-row-detail');

    this.onToggle = opts.onToggle;
    if (opts.onActivate) {
      // Activate row (file tools): the click opens the file; details stay inline.
      this.revealer = null;
      this.toggle.append(this.content);
      button.on('clicked', opts.onActivate);
    } else {
      // Toggle row: the details live in a slide-down reveal the click flips.
      this.revealer = new Gtk.Revealer();
      this.revealer.setTransitionType(Gtk.RevealerTransitionType.SLIDE_DOWN);
      this.revealer.setChild(this.content);
      this.toggle.append(this.revealer);
      button.on('clicked', () => this.setExpanded(!this.expanded));
      if (opts.expanded) this.setExpanded(true);
    }
    this.root.append(this.toggle);
  }

  get expanded(): boolean { return this.revealer?.getRevealChild() ?? false; }

  setExpanded(expanded: boolean): void {
    if (!this.revealer || expanded === this.revealer.getRevealChild()) return;
    this.revealer.setRevealChild(expanded);
    // Fade only the toggle (BUTTON + DETAILS), not the whole row — a CSS transition.
    if (expanded) this.toggle.addCssClass('is-expanded');
    else this.toggle.removeCssClass('is-expanded');
    this.onToggle?.(expanded);
  }

  /** Set the leading icon (glyph + optional colour). A status, if set, owns the
   *  colour (via its Adwaita class), so the explicit colour applies only otherwise. */
  setIcon(glyph: string, color?: string): void {
    this.iconGlyph = glyph;
    this.iconColor = color;
    this.renderIcon();
  }

  /** Mark the row's status: `warning` / `error` tint the icon AND the header through
   *  the Adwaita `.warning` / `.error` style classes (no border, no inline colour);
   *  `null` clears it. Optionally swaps the icon glyph (e.g. ✗ for an error). */
  setStatus(status: ToolRowStatus, glyph?: string): void {
    this.status = status;
    if (glyph !== undefined) this.iconGlyph = glyph;
    for (const c of ['warning', 'error'] as const) { this.icon.removeCssClass(c); this.header.removeCssClass(c); }
    if (status) { this.icon.addCssClass(status); this.header.addCssClass(status); }
    this.renderIcon();
  }

  // Render the icon glyph. A status colours it through the CSS class, so it must
  // carry NO inline Pango colour (which would override the class); without a status
  // the explicit colour (if any) applies.
  private renderIcon(): void {
    const markup = this.status ? iconSpan(this.iconGlyph) : iconSpan(this.iconGlyph, this.iconColor);
    setMarkupSafe(this.icon, markup, this.iconGlyph);
  }
}
