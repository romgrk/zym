/*
 * PickerRow — the row layout primitives a Picker caller chooses between. The
 * Picker itself is layout-agnostic: it computes fuzzy matches and hands each
 * (item, positions) pair to the caller's `renderRow`, which builds the widget —
 * usually by computing the markup for each piece (with the helpers in
 * pickerHighlight) and passing it to one of the renderers here.
 *
 * `renderRowSingleLine` is the default: a main label, optionally with a leading
 * icon and a right-aligned muted detail. `renderRowStacked` puts a muted detail
 * on a second line below the main label (e.g. the file picker's filename over
 * its directory). Both take already-built Pango markup so the caller controls
 * highlighting, prose vs. plain text, and emphasis.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { iconSpan } from './icons.ts';

addStyles(/* css */`
  /* Right-aligned muted detail column (single-line rows). Highlights still show
     through the dimming. */
  .PickerRow > .picker-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
  /* Second line of a stacked row (e.g. the file picker's directory): muted and a
     touch smaller, sitting tight under the main label. Descendant (not child)
     selector — with a leading icon the lines nest one level deeper. */
  .PickerRow .picker-detail-line {
    opacity: 0.5;
    font-size: 0.9em;
  }
  /* Leading icon column (file-type / state glyph), centred against the row. Margins
     (not padding — padding ate into the glyph's own box): a left inset plus a wider
     gap to the text, tuned so the icons line up under the prompt icon. */
  .PickerRow > .picker-row-icon {
    margin-left: ${theme.spacing}px;
    margin-right: ${theme.spacing * 2}px;
  }
`);

/**
 * The pieces of a row, as already-built Pango markup. The caller computes these
 * from its item (highlighting matched positions via `highlightMarkup` /
 * `highlightSegment`) and hands them to a renderer.
 */
export interface RowParts {
  /** Leading icon glyph (Nerd Font), rendered before the main markup. */
  icon?: string;
  /** Colour for `icon` (e.g. a CI/PR state colour); default follows the text. */
  iconColor?: string;
  /** Dim the icon — a quiet visual cue (e.g. a file-type glyph) rather than a
   *  status colour that should stay vivid. */
  iconMuted?: boolean;
  /** The row's main label, as Pango markup. */
  main: string;
  /** Optional secondary text, as Pango markup (right of `main`, or below it). */
  detail?: string;
  /**
   * Whether the detail is dimmed (the muted `.picker-detail` look). Default true;
   * set false when the caller controls emphasis in the markup itself (e.g. the
   * command palette's bold keybinding column). Single-line only.
   */
  detailMuted?: boolean;
  /** Dim the whole row (e.g. a command shown but not currently applicable). */
  dim?: boolean;
}

/** The leading icon column (a glyph in the icon font), or null when there's none.
 *  Shared by both renderers so the `.picker-row-icon` spacing/muting is uniform. */
function iconWidget(parts: RowParts): InstanceType<typeof Gtk.Label> | null {
  if (parts.icon === undefined) return null;
  const icon = new Gtk.Label({ useMarkup: true });
  icon.setMarkup(iconSpan(parts.icon, parts.iconColor));
  icon.setValign(Gtk.Align.CENTER);
  icon.addCssClass('picker-row-icon');
  if (parts.iconMuted) icon.setOpacity(0.55);
  return icon;
}

/** Wrap row `content` in a leading-icon column when one is given, else name and
 *  return `content` as the row itself. Applies the whole-row dimming. */
function withIconColumn(parts: RowParts, content: InstanceType<typeof Gtk.Widget>): InstanceType<typeof Gtk.Widget> {
  const icon = iconWidget(parts);
  if (!icon) {
    content.addCssClass('PickerRow');
    if (parts.dim) content.setOpacity(0.4);
    return content;
  }
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
  row.addCssClass('PickerRow');
  row.append(icon);
  row.append(content);
  if (parts.dim) row.setOpacity(0.4);
  return row;
}

/**
 * A single-line row: a main label that crops to the card width, optionally with a
 * leading icon and a right-aligned muted detail that keeps its natural width.
 */
export function renderRowSingleLine(parts: RowParts): InstanceType<typeof Gtk.Widget> {
  if (parts.detail === undefined) {
    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    label.setMarkup(parts.main);
    // Crop a long label to the card width rather than widening the row.
    label.setHexpand(true);
    label.setEllipsize(Pango.EllipsizeMode.END);
    return withIconColumn(parts, label);
  }

  // Main label on the left, a right-aligned muted detail on the right. The main
  // label expands and ellipsizes so a long label crops to the picker width rather
  // than pushing the detail off the edge; the secondary detail is the column that
  // yields first when the row is tight (see its ellipsize below), so the main keeps
  // priority.
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
  box.setHexpand(true);
  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(parts.main);
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  box.append(main);
  const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
  detail.setMarkup(parts.detail);
  // The detail is the secondary column, so it yields when the row is tight: it
  // ellipsizes from the *start*, keeping its informative tail visible (a path's
  // `filename:line`, a date, a keybinding) while the main label keeps priority.
  detail.setEllipsize(Pango.EllipsizeMode.START);
  // Dimmed by default; an un-muted detail keeps the spacing but not the opacity
  // (the caller's markup sets its own emphasis).
  if (parts.detailMuted === false) detail.setMarginStart(16);
  else detail.addCssClass('picker-detail');
  box.append(detail);
  return withIconColumn(parts, box);
}

/**
 * A two-line row: the main label on top, a muted detail on a second line below
 * (e.g. a filename over its directory). Both lines crop to the card width. A
 * leading icon, when given, sits in a column to the left, centred against both.
 */
export function renderRowStacked(parts: RowParts): InstanceType<typeof Gtk.Widget> {
  const lines = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  lines.addCssClass('picker-row-stacked');
  lines.setHexpand(true);

  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(parts.main); // the icon (if any) is a sibling column, not inline
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  lines.append(main);

  if (parts.detail) {
    const detail = new Gtk.Label({ xalign: 0, useMarkup: true });
    detail.setMarkup(parts.detail);
    detail.setHexpand(true);
    detail.setEllipsize(Pango.EllipsizeMode.END);
    detail.addCssClass('picker-detail-line');
    lines.append(detail);
  }

  // A leading icon (if any) sits in a column to the left, centred against both lines.
  return withIconColumn(parts, lines);
}
