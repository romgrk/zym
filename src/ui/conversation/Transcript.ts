/*
 * Transcript — the scrollable column of conversation "entries" shared by the main
 * AgentConversation and each subagent page (SubagentView). It is the single owner of:
 *   - the entries box,
 *   - the uniform inter-entry spacing (the `.transcript-entry` class, applied
 *     ONLY in appendEntry — so no caller ever repeats the class or its style),
 *   - stick-to-bottom autoscroll.
 *
 * Callers append top-level entries through `appendEntry`; they never touch the box or
 * the class directly.
 */
import { Gtk, Adw } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { clearChildren, setMarkupSafe, escapeMarkup } from '../proseMarkup.ts';
import { describeTool, toolFilePath } from '../toolDisplay.ts';
import { iconSpan } from '../icons.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(/* css */`
  .Transcript {
    font-size: 1.05em;
  }

  .Transcript viewport {
    padding: calc(2 * var(--t-spacing)) 0;
  }

  .Transcript .transcript-entry {
    padding: 0 calc(2 * var(--t-spacing));
    margin-bottom: calc(2 * var(--t-spacing));
  }

  /* Shared tool rows (tool-use / Bash / unknown event): a leading tool icon next to
     a toggle (a flat header button over a collapsible detail). The container owns
     the horizontal padding; the extra left indent nests tool activity under the
     turn. (The toggle/expand styling lives in ToolRow.ts.) */
  .Transcript .transcript-entry-tool {
    padding: 0 calc(2 * var(--t-spacing)) 0 calc(6 * var(--t-spacing));
   }

  /* Collapsed file-tool rows (Read/Write/Edit): a non-clickable tool-name label and
     each file path are all flat buttons, so they share the default button padding +
     metrics and line up. The head reads as a muted title; paths read as links (the
     .link class supplies the accent color). */
  .Transcript .transcript-file-icon { padding-right: 8px; }
  .Transcript .transcript-file-head { opacity: 0.85; }
  .Transcript .transcript-file-path {
    color: var(--window-fg-color);
    font-family: var(--t-font-monospace-family);
  }
`);

export interface TranscriptOptions {
  /** Cap the entries column to this width (px) via an Adw.Clamp pinned to the left. */
  maxWidth?: number;
}

export class Transcript {
  /** The scrollable root — mount this in the layout. */
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;
  // The vertical column of entries.
  private readonly box: InstanceType<typeof Gtk.Box>;
  // Follow new content to the bottom; released when the user scrolls up, re-armed within
  // REARM_GAP of the bottom (see setupAutoScroll).
  private stickToBottom = true;
  // Set while we pin, so the `value-changed` our pin emits isn't read as a user scroll.
  private pinning = false;
  // Previous value + upper, to tell a user scroll up (value fell, height held) from our
  // own pin and from a clamp on shrinking content.
  private lastValue = 0;
  private lastUpper = 0;
  // Distance from the bottom (px) that still counts as "at the bottom" for re-arming.
  private static readonly REARM_GAP = 16;
  // The open collapsed file-tool row (Read/Write/Edit/…), while a CONSECUTIVE run of
  // the SAME tool is appended to it. Any other entry clears it (see appendEntry).
  private fileGroup: { tool: string; files: InstanceType<typeof Gtk.Box> } | null = null;

  constructor(opts: TranscriptOptions = {}) {
    this.box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

    let child: Widget = this.box;
    if (opts.maxWidth != null) {
      // Cap the column to a readable measure (GTK CSS has no max-width). halign START
      // pins it left (Clamp centres by default); threshold == max → a hard cap.
      const clamp = new Adw.Clamp();
      clamp.setMaximumSize(opts.maxWidth);
      clamp.setTighteningThreshold(opts.maxWidth);
      clamp.setHalign(Gtk.Align.START);
      clamp.setChild(this.box);
      child = clamp;
    }
    this.root = new Gtk.ScrolledWindow({ vexpand: true });
    this.root.addCssClass('Transcript');
    this.root.setChild(child);
    this.setupAutoScroll();
  }

  /** Append a top-level entry, tagging it with the shared entry class — the single
   *  owner of inter-entry spacing. Used directly only for MESSAGE entries; every
   *  non-message entry goes through appendToolEntry. */
  appendEntry(widget: Widget): void {
    this.fileGroup = null; // any other entry breaks a consecutive file-tool run
    widget.addCssClass('transcript-entry');
    this.box.append(widget);
  }

  /** Append a NON-message entry (tool rows, single rows, cards, …). The ONLY way to
   *  add such an entry: it wraps `widget` in a `.transcript-entry-tool` box, so the
   *  tool-entry gutter/indent is owned in exactly one place — no caller sets that
   *  class itself. */
  appendToolEntry(widget: Widget): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.addCssClass('transcript-entry-tool');
    box.append(widget);
    this.appendEntry(box);
  }

  /** Append a Read/Write/Edit (file-path tool) call as a collapsed row: a leading
   *  tool icon + a non-clickable tool-name label, with each call's file path stacked
   *  to its right as a clickable link that opens the file. CONSECUTIVE calls of the
   *  SAME tool extend one row; any other entry starts a fresh one. Returns an
   *  `onResult` the caller wires to the tool's result so a FAILURE still surfaces. */
  appendFileTool(
    name: string,
    input: unknown,
    opts: { cwd: string; onOpenFile: (path: string) => void },
  ): (isError: boolean, text: string) => void {
    const view = describeTool(name, input, opts.cwd);
    const absPath = toolFilePath(name, input) ?? '';
    const display = view.detail || absPath;

    if (!this.fileGroup || this.fileGroup.tool !== name) {
      const container = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      container.addCssClass('transcript-file-row');

      const icon = new Gtk.Label({ valign: Gtk.Align.START });
      icon.addCssClass('transcript-file-icon');
      setMarkupSafe(icon, iconSpan(view.icon), view.icon);
      container.append(icon);

      // The tool name as a non-clickable flat button, so it carries the EXACT same
      // padding/metrics as the file-path buttons beside it — they line up.
      const head = new Gtk.Button({ valign: Gtk.Align.START });
      head.addCssClass('flat');
      head.addCssClass('transcript-file-head');
      head.setCanTarget(false); // a label, not a control — no hover, no click
      head.setFocusable(false);
      const headLabel = new Gtk.Label({ xalign: 0 });
      setMarkupSafe(headLabel, `<b>${escapeMarkup(view.title || name)}</b>`, view.title || name);
      head.setChild(headLabel);
      container.append(head);

      // Center the icon against the head ROW (not the whole stack): a vertical size
      // group ties the icon's height to the head button's, so its glyph centers on
      // that first row even as more paths stack below (same trick as ToolRow).
      const sizing = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
      sizing.addWidget(icon);
      sizing.addWidget(head);

      const files = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
      container.append(files);
      this.appendToolEntry(container); // wraps + clears fileGroup → assign it right after
      this.fileGroup = { tool: name, files };
    }

    const button = new Gtk.Button({ halign: Gtk.Align.START });
    button.addCssClass('flat');
    button.addCssClass('link');
    button.addCssClass('transcript-file-path');
    button.setChild(new Gtk.Label({ xalign: 0, label: display }));
    button.setTooltipText(absPath);
    button.on('clicked', () => opts.onOpenFile(absPath));
    this.fileGroup.files.append(button);
    this.scrollToBottom();

    // A successful file op is boilerplate (suppressed); surface only a FAILURE — tint
    // the path link as an error and carry the message in its tooltip.
    return (isError, text) => {
      if (!isError) return;
      button.addCssClass('error');
      const msg = text.trim();
      if (msg) button.setTooltipText(msg);
    };
  }

  /** Remove a previously-appended entry (e.g. an answered permission card). */
  removeEntry(widget: Widget): void {
    this.box.remove(widget);
  }

  /** Drop every entry. */
  clear(): void {
    clearChildren(this.box);
  }

  /** Follow new content to the bottom while in stick mode. `force` re-arms and pins now
   *  (e.g. on show); otherwise the `changed` handler pins when the height changes. */
  scrollToBottom(force = false): void {
    if (force) { this.stickToBottom = true; this.pinToBottom(); }
  }

  // Jump to the bottom, flagged `pinning` so its value-change isn't read as a user
  // scroll. Called from `changed` (during layout, `upper` final) so it lands correctly.
  private pinToBottom(): void {
    const adj = this.root.getVadjustment();
    this.pinning = true;
    adj.setValue(adj.getUpper() - adj.getPageSize());
    this.pinning = false;
  }

  // Pin on the adjustment's `changed` (height) signal, NOT a per-frame tick loop: that
  // fought GTK's own scroll handling (kinetic / scrollbar) and made scrolling up janky.
  // `changed` fires only on a content-height change (never from a user scroll), so the
  // two never contend; `value-changed` tracks the user — a scroll up (value fell, height
  // held) releases stick mode, returning within REARM_GAP re-arms it. It runs before the
  // layout that emits `changed`, so a streaming-while-scrolling frame releases first.
  private setupAutoScroll(): void {
    const adj = this.root.getVadjustment();
    this.lastValue = adj.getValue();
    this.lastUpper = adj.getUpper();
    adj.on('changed', () => { if (this.stickToBottom) this.pinToBottom(); });
    adj.on('value-changed', () => {
      const value = adj.getValue();
      const upper = adj.getUpper();
      if (!this.pinning) {
        if (value < this.lastValue - 0.5 && upper >= this.lastUpper - 0.5) {
          this.stickToBottom = false; // user scrolled up — yield immediately
        } else if (upper - adj.getPageSize() - value <= Transcript.REARM_GAP) {
          this.stickToBottom = true; // back within the re-arm window
        }
      }
      this.lastValue = value;
      this.lastUpper = upper;
    });
  }
}
