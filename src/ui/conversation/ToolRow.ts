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
import { iconSpan } from '../icons.ts';
import { setMarkupSafe } from '../proseMarkup.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

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
  private readonly toggle: InstanceType<typeof Gtk.Box>; // BUTTON + DETAILS; the bg-fade target
  private readonly revealer: InstanceType<typeof Gtk.Revealer> | null;
  private readonly onToggle?: (expanded: boolean) => void;

  constructor(opts: ToolRowOptions) {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('zym-conversation-toolrow-container');

    this.icon = new Gtk.Label({ valign: Gtk.Align.START });
    this.icon.addCssClass('zym-conversation-toolrow-icon');
    this.setIcon(opts.icon, opts.iconColor);
    this.root.append(this.icon);

    // The BUTTON + DETAILS column: the expander that grows + gains the bubble bg.
    this.toggle = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    this.toggle.addCssClass('zym-conversation-toolrow-toggle');

    const button = new Gtk.Button();
    button.addCssClass('flat');
    button.addCssClass('zym-conversation-toolrow-button');
    opts.header.setHexpand(true);
    button.setChild(opts.header);
    this.toggle.append(button);

    // Center the icon against the header button — not the whole toggle. A vertical
    // size group ties the icon's height to the button's, so the (top-aligned) icon
    // stays centered on the header row even once the details expand below it.
    const iconSizing = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
    iconSizing.addWidget(this.icon);
    iconSizing.addWidget(button);

    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.content.addCssClass('zym-conversation-toolrow-detail');

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
    if (expanded) this.toggle.addCssClass('zym-conversation-toolrow-expanded');
    else this.toggle.removeCssClass('zym-conversation-toolrow-expanded');
    this.onToggle?.(expanded);
  }

  /** Set the leading icon (glyph + optional color); used for the error ✗ too. */
  setIcon(glyph: string, color?: string): void {
    setMarkupSafe(this.icon, iconSpan(glyph, color), glyph);
  }
}
