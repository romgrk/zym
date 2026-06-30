/*
 * ToolRow — the shared transcript row for tool activity (tool-use, Bash, and
 * unrecognised stream events). Layout:
 *
 *   ┌ row ─────────────────────────────────────┐
 *   │ ┌ toggle ───────────────────────────────┐ │
 *   │ │ BUTTON  [ ICON  header ]  (flat)       │ │
 *   │ │ DETAILS (collapsible reveal)           │ │
 *   │ └───────────────────────────────────────┘ │
 *   └───────────────────────────────────────────┘
 *
 * The leading ICON identifies the tool (Bash → a terminal) and sits INSIDE the
 * header button, left of the title — so the whole single-button row (icon + title)
 * is one click target that grows + tints together. The `toggle` — the BUTTON +
 * DETAILS column — is the expander: clicking the button reveals the details, and the
 * toggle's background fades to a message bubble's.
 *
 * (Grouped file-tool rows — Read/Edit/… collapsed into one consecutive run — keep
 * their icon OUTSIDE, beside the run's head; that layout lives in Transcript, not
 * here.)
 *
 * "Activate" rows (file tools / monitor) are the exception: their button click opens
 * the file/page instead of toggling, so their details show inline rather than behind
 * a reveal.
 *
 * The widget owns only the layout, the toggle, and the fade — the conversation
 * builds each tool's header and fills `content`.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { addStyles } from '../../styles.ts';
import { iconSpan } from '../icons.ts';
import { setMarkupSafe } from '../proseMarkup.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  /* The leading tool icon, inline at the start of the header button (left of the
     title). The trailing pad sets it off the title; both share the button's row, so
     the label's own vertical centering keeps the glyph centered on the title. */
  .ToolRow .tool-row-icon { padding-right: calc(2 * var(--t-spacing)); }
  /* The BUTTON (icon + title) + DETAILS expander: grows + gains the bubble bg. */
  .ToolRow .tool-row-toggle {
    border-radius: 8px;
    background: transparent;
    transition: background 150ms ease;
  }
  .ToolRow .tool-row-toggle.is-expanded { background: alpha(currentColor, 0.1); }
  /* The header button: a standard Adwaita flat button (its own hover tint), just
     left-aligned with no min size and rounded to match the toggle. */
  .ToolRow .tool-row-button {
    padding: 6px 8px; min-height: 0; border-radius: 8px;
  }
  .ToolRow .tool-row-detail { padding: 0 8px 6px 8px; }
`);

/** A tool row's header label: the title/detail shown on the header button. Kept to a
 *  single ellipsized line so a long title (or detail) never wraps to multiple lines or
 *  pushes the row past the transcript's max width — the full content lives behind the
 *  toggle (the expandable detail) or in the file the row opens. The caller fills it via
 *  `setMarkupSafe`. */
export function toolHeaderLabel(): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ xalign: 0, hexpand: true });
  label.addCssClass('conversation-tool-header');
  label.setEllipsize(Pango.EllipsizeMode.END);
  label.setSingleLineMode(true); // also collapses any embedded newline to one line
  return label;
}

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
  /** The owner's disposable bag. The row routes its header-button `clicked` handler
   *  through it and registers itself for disposal, so the node-gtk-rooted closure is
   *  severed when the owner (conversation / monitor / subagent view) is torn down.
   *  Without it the row's handler pins the row's subtree after the conversation closes. */
  subs?: CompositeDisposable;
}

export class ToolRow {
  readonly root: InstanceType<typeof Gtk.Box>; // [icon][toggle]
  /** The details section below the header — append result/output/JSON/progress here. */
  readonly content: InstanceType<typeof Gtk.Box>;
  // The leading slot holds the glyph icon and (lazily, while running) a spinner that
  // swaps in for it — only one is visible at a time (see setRunning).
  private readonly iconSlot: InstanceType<typeof Gtk.Box>;
  private readonly icon: InstanceType<typeof Gtk.Label>;
  private spinner: InstanceType<typeof Adw.Spinner> | null = null;
  private readonly header: Widget; // the title widget — status-tinted alongside the icon
  private readonly toggle: InstanceType<typeof Gtk.Box>; // BUTTON + DETAILS; the bg-fade target
  private readonly revealer: InstanceType<typeof Gtk.Revealer> | null;
  private readonly onToggle?: (expanded: boolean) => void;
  // The leading icon's glyph + its explicit colour (used only when no status owns it).
  private iconGlyph = '';
  private iconColor?: string;
  private status: ToolRowStatus = null;
  // Severs the header-button `clicked` handler (node-gtk roots it) on dispose. Disposed by
  // the owner via `opts.subs` when given; otherwise the caller must call `dispose()`.
  private readonly subs = new CompositeDisposable();

  constructor(opts: ToolRowOptions) {
    opts.subs?.use(this); // owner tears this row (and its handler) down on close
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('ToolRow');
    // The transcript wraps this in a .transcript-entry-tool box (Transcript.appendToolEntry);
    // the row itself carries no entry class.

    this.header = opts.header;

    // The BUTTON + DETAILS column: the expander that grows + gains the bubble bg.
    this.toggle = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    this.toggle.addCssClass('tool-row-toggle');

    // The header button carries the leading tool icon INLINE: a horizontal [icon][header]
    // box as its child, so the whole single-button row is one click target. The icon
    // shares the button's row, so it centers on the title without the size-group trick
    // the old outside-the-toggle slot needed.
    const button = new Gtk.Button();
    button.addCssClass('flat');
    button.addCssClass('tool-row-button');
    const buttonContent = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.iconSlot = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, valign: Gtk.Align.CENTER });
    this.icon = new Gtk.Label({ valign: Gtk.Align.CENTER });
    this.icon.addCssClass('tool-row-icon');
    this.setIcon(opts.icon, opts.iconColor);
    this.iconSlot.append(this.icon);
    buttonContent.append(this.iconSlot);
    opts.header.setHexpand(true);
    buttonContent.append(opts.header);
    button.setChild(buttonContent);
    this.toggle.append(button);

    if (opts.status) this.setStatus(opts.status);

    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.content.addCssClass('tool-row-detail');

    this.onToggle = opts.onToggle;
    if (opts.onActivate) {
      // Activate row (file tools): the click opens the file; details stay inline.
      this.revealer = null;
      this.toggle.append(this.content);
      this.subs.connect(button, 'clicked', opts.onActivate);
    } else {
      // Toggle row: the details live in a slide-down reveal the click flips.
      this.revealer = new Gtk.Revealer();
      this.revealer.setTransitionType(Gtk.RevealerTransitionType.SLIDE_DOWN);
      this.revealer.setChild(this.content);
      this.toggle.append(this.revealer);
      this.subs.connect(button, 'clicked', () => this.setExpanded(!this.expanded));
      if (opts.expanded) this.setExpanded(true);
    }
    this.root.append(this.toggle);
  }

  /** Sever the header-button `clicked` handler (node-gtk roots its closure). Idempotent;
   *  invoked by the owner's bag when constructed with `opts.subs`. */
  dispose(): void {
    this.subs.dispose();
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

  /** Show a spinner in the leading slot while the tool is executing, swapping back to
   *  the glyph once the result lands. Live rows only — the conversation arms it on
   *  tool-use and clears it on the result (or when the turn ends); replayed / static
   *  rows never spin. Idempotent. */
  setRunning(running: boolean): void {
    if (running) {
      if (!this.spinner) {
        this.spinner = new Adw.Spinner();
        this.spinner.setSizeRequest(14, 14); // Adw.Spinner fills its allocation otherwise
        this.spinner.setValign(Gtk.Align.CENTER); // centered on the title, like the glyph it replaces
        this.spinner.addCssClass('tool-row-icon'); // same trailing pad as the glyph it replaces
        this.iconSlot.append(this.spinner);
      }
      this.spinner.setVisible(true);
      this.icon.setVisible(false);
    } else {
      this.icon.setVisible(true);
      this.spinner?.setVisible(false);
    }
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
